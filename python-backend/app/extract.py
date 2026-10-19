"""Plain-text extraction for document-y files so their contents are searchable."""
from __future__ import annotations

from pathlib import Path

TEXT_EXTS = {".txt", ".md", ".csv", ".log", ".json", ".xml", ".yaml", ".yml", ".ini"}
PDF_EXTS = {".pdf"}
DOCX_EXTS = {".docx"}

MAX_CHARS = 200_000  # guard against indexing gigantic files into SQLite/FTS

# A page with fewer real characters than this is treated as having no usable
# text layer at all - typically a scanned/photographed page (a receipt, ID,
# form, etc. saved as PDF) rather than one produced from a word processor -
# so it's OCR'd like a plain image instead, which is what makes numbers and
# words in scanned PDFs searchable at all.
MIN_TEXT_LAYER_CHARS = 20
# OCR is much slower than pulling an existing text layer, so a huge
# all-scanned PDF (a photographed book, say) doesn't spend forever indexing -
# after this many OCR'd pages, any remaining pages just keep whatever (if
# any) text layer they have.
MAX_OCR_PAGES = 40


def extract_text(path: Path) -> str:
    """Best-effort text extraction. Returns '' if the type isn't handled or fails."""
    ext = path.suffix.lower()
    try:
        if ext in TEXT_EXTS:
            return path.read_text(encoding="utf-8", errors="ignore")[:MAX_CHARS]
        if ext in PDF_EXTS:
            return _extract_pdf(path)
        if ext in DOCX_EXTS:
            return _extract_docx(path)
    except Exception:
        return ""
    return ""


def _extract_pdf(path: Path) -> str:
    from pypdf import PdfReader

    # Opened through our own "with" rather than handing pypdf the bare path
    # (PdfReader(str(path)) opens the file itself and only closes it when
    # garbage-collected) - pypdf's parsed page objects hold circular
    # references back to the reader, which delays that GC past when this
    # function returns instead of happening immediately. On Windows that
    # left the file still open moments later, when a rename/suggest-name
    # run right after indexing would fail with EBUSY ("resource busy or
    # locked"). Our own "with" closes the OS handle deterministically the
    # moment this function is done with it, regardless of pypdf's own
    # object graph.
    with open(path, "rb") as f:
        reader = PdfReader(f)
        chunks = []
        total_chars = 0
        ocr_pages_done = 0
        for page_num, page in enumerate(reader.pages):
            text = page.extract_text() or ""
            if len(text.strip()) < MIN_TEXT_LAYER_CHARS and ocr_pages_done < MAX_OCR_PAGES:
                ocr_pages_done += 1
                text = _ocr_pdf_page(path, page_num) or text
            chunks.append(text)
            total_chars += len(text)
            if total_chars > MAX_CHARS:
                break
    return "\n".join(chunks)[:MAX_CHARS]


def _ocr_pdf_page(path: Path, page_num: int) -> str:
    """Renders one PDF page to an image and OCRs it - the fallback for a
    scanned/photographed page that has little or no real text layer for pypdf
    to pull out directly."""
    try:
        import pymupdf as fitz  # the package is "pymupdf"; "fitz" is its old import name

        with fitz.open(str(path)) as doc:
            if page_num >= doc.page_count:
                return ""
            page = doc[page_num]
            # ~200 DPI is enough for Tesseract to read normal document text
            # and numbers reliably without making OCR unreasonably slow.
            pix = page.get_pixmap(matrix=fitz.Matrix(200 / 72, 200 / 72))
            png_bytes = pix.tobytes("png")
    except Exception:
        return ""

    try:
        from io import BytesIO

        from PIL import Image

        from . import ocr

        with Image.open(BytesIO(png_bytes)) as img:
            return ocr.ocr_pil_image(img)
    except Exception:
        return ""


def _extract_docx(path: Path) -> str:
    """Reads a docx's text - not just its top-level paragraphs (what
    python-docx's own `.paragraphs` gives you), but everywhere text actually
    lives in the document. Tables and text boxes are both just <w:p>
    paragraphs nested somewhere else in the same underlying XML tree (inside
    a table cell, or inside a drawing/textbox wrapper) - walking every <w:p>
    in the document body picks up all three uniformly, reconstructing each
    paragraph's text the same way python-docx itself does (its own <w:t>
    runs joined with no separator - a paragraph's text is often split across
    several runs purely for formatting reasons, e.g. part bold - and
    joining them with anything but "" would wrongly insert gaps inside
    single words), then joining paragraphs with newlines so words from
    different cells/text boxes/paragraphs never get smashed together.
    Headers/footers live in separate document parts, not the main body, so
    those aren't reachable this way - read via python-docx's own
    section.header/footer API instead, which handles the "same header as
    previous section" linking python-docx tracks internally."""
    import docx
    from docx.oxml.ns import qn

    doc = docx.Document(str(path))
    chunks: list[str] = []

    for p in doc.element.body.iter(qn("w:p")):
        text = "".join(t.text or "" for t in p.iter(qn("w:t")))
        if text:
            chunks.append(text)

    for section in doc.sections:
        for part in (section.header, section.footer):
            for p in part.paragraphs:
                if p.text:
                    chunks.append(p.text)

    return "\n".join(chunks)[:MAX_CHARS]


_DOCX_IMAGE_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".webp": "image/webp",
}


def docx_images(path: Path, max_images: int = 8, max_bytes: int = 3_000_000) -> tuple[list[str], bool]:
    """The pictures inside a .docx, in the order they appear in the document,
    as data: URLs a preview can show directly. Many Word files are just a
    scanned or screenshotted page placed in the document - they have no text
    at all, so the picture IS the content. Formats browsers can't draw
    (EMF/WMF) are skipped; anything over `max_bytes` is shrunk to a JPEG.
    Returns (images, truncated)."""
    import base64
    import re
    import zipfile
    from io import BytesIO
    from posixpath import normpath

    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        order: list[str] = []
        try:
            rels_xml = z.read("word/_rels/document.xml.rels").decode("utf-8", "ignore")
            targets = {}
            for m in re.finditer(r"<Relationship\b[^>]*>", rels_xml):
                tag = m.group(0)
                rid = re.search(r'Id="([^"]+)"', tag)
                tgt = re.search(r'Target="([^"]+)"', tag)
                if rid and tgt:
                    targets[rid.group(1)] = tgt.group(1)
            doc_xml = z.read("word/document.xml").decode("utf-8", "ignore")
            for m in re.finditer(r'r:(?:embed|id)="([^"]+)"', doc_xml):
                t = targets.get(m.group(1))
                if not t:
                    continue
                full = normpath("word/" + t) if not t.startswith("/") else t.lstrip("/")
                if full in names and full not in order and full.startswith("word/media/"):
                    order.append(full)
        except KeyError:
            pass
        # Anything in media/ the document body didn't reference by id (some
        # generators embed pictures differently): still better than nothing.
        for n in sorted(names):
            if n.startswith("word/media/") and n not in order:
                order.append(n)

        usable = [n for n in order if Path(n).suffix.lower() in _DOCX_IMAGE_MIME]
        out: list[str] = []
        for n in usable[:max_images]:
            data = z.read(n)
            mime = _DOCX_IMAGE_MIME[Path(n).suffix.lower()]
            if len(data) > max_bytes:
                try:
                    from PIL import Image

                    with Image.open(BytesIO(data)) as img:
                        img = img.convert("RGB")
                        img.thumbnail((1800, 1800))
                        buf = BytesIO()
                        img.save(buf, "JPEG", quality=85)
                        data, mime = buf.getvalue(), "image/jpeg"
                except Exception:
                    continue
            out.append(f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}")
        return out, len(usable) > max_images
