"""File format conversion - the "Convert to..." context-menu actions.

Each conversion writes a NEW file next to the original, with the new
extension (report.pdf -> report.docx) - the original is never touched or
removed, so a conversion that doesn't come out the way you wanted never
costs you the source file.

Only a fixed, known-good set of (source, target) pairs is supported -
supported_targets() is both what the UI offers per file and what convert()
itself checks, so a pair nobody built a converter for is refused up front
with a plain message rather than failing halfway through.
"""
from __future__ import annotations

from pathlib import Path

from . import extract, ocr

IMAGE_EXTS = ocr.IMAGE_EXTS
PDF_EXTS = extract.PDF_EXTS

# Only these two plausibly hold real row/column data - extract.py's own
# TEXT_EXTS also includes things like .json/.xml/.log that "convert to
# Excel" wouldn't make sense for.
TABULAR_TEXT_EXTS = {".txt", ".csv", ".tsv"}


class ConversionError(Exception):
    """Raised with a message that's safe to show directly in the UI."""


def supported_targets(ext: str) -> list[str]:
    ext = ext.lower()
    if ext in PDF_EXTS:
        return [".docx", ".txt"]
    if ext in IMAGE_EXTS:
        return [".pdf", ".docx"]
    if ext in TABULAR_TEXT_EXTS:
        return [".xlsx"]
    return []


def convert(path: Path, target_ext: str) -> Path:
    target_ext = target_ext.lower()
    if not target_ext.startswith("."):
        target_ext = f".{target_ext}"
    ext = path.suffix.lower()

    if target_ext not in supported_targets(ext):
        raise ConversionError(f"Can't convert a {ext or 'file with no extension'} file to {target_ext}.")

    dest = _available_dest(path, target_ext)

    if ext in PDF_EXTS and target_ext == ".docx":
        _pdf_to_docx(path, dest)
    elif ext in PDF_EXTS and target_ext == ".txt":
        _pdf_to_txt(path, dest)
    elif ext in IMAGE_EXTS and target_ext == ".pdf":
        _image_to_pdf(path, dest)
    elif ext in IMAGE_EXTS and target_ext == ".docx":
        _image_to_docx(path, dest)
    elif ext in TABULAR_TEXT_EXTS and target_ext == ".xlsx":
        _text_to_xlsx(path, dest)
    else:
        # supported_targets() said yes but nothing above handled it - a
        # mapping bug, not a user-facing case. Fail loudly rather than
        # silently producing nothing.
        raise ConversionError(f"No converter wired up for {ext} -> {target_ext}.")

    return dest


def _available_dest(path: Path, target_ext: str) -> Path:
    """report.pdf -> report.docx, or "report (2).docx" if that name's
    already taken - same idea as main.py's _next_available_stem for
    suggested renames, just never overwriting an existing file."""
    candidate = path.with_suffix(target_ext)
    if not candidate.exists():
        return candidate
    n = 2
    while True:
        candidate = path.with_name(f"{path.stem} ({n}){target_ext}")
        if not candidate.exists():
            return candidate
        n += 1


def _pdf_has_text_layer(path: Path) -> bool:
    """Whether pypdf can pull any real text out of this PDF at all. A
    scanned or photographed page (a receipt, a screenshot, a bank
    statement saved as PDF) has none, no matter how much text is visible
    on it, because the page is really just a picture - pypdf (and
    pdf2docx, which is built on the same kind of real-text-object reading)
    can only find text that exists as actual text objects in the PDF, not
    text that only exists as pixels inside an image. Mirrors extract.py's
    own per-page threshold (MIN_TEXT_LAYER_CHARS), just decided once for
    the whole file - good enough for picking a conversion strategy, where
    a mostly-scanned and a fully-scanned file both need the same one."""
    from pypdf import PdfReader

    # See extract.py's _extract_pdf for why this is opened through our own
    # "with" rather than PdfReader(str(path)) - the same Windows
    # file-handle-stays-open-until-GC hazard applies here.
    with open(path, "rb") as f:
        reader = PdfReader(f)
        pages = reader.pages
        total = sum(len((p.extract_text() or "").strip()) for p in pages)
        page_count = len(pages)
    return total >= extract.MIN_TEXT_LAYER_CHARS * max(page_count, 1)


def _pdf_to_docx(path: Path, dest: Path) -> None:
    if _pdf_has_text_layer(path):
        # A real digital PDF - pdf2docx reconstructs the actual page
        # layout (text, tables, and embedded images all carried across)
        # rather than just dumping extracted text into a blank document.
        from pdf2docx import Converter

        cv = Converter(str(path))
        try:
            cv.convert(str(dest))
        finally:
            cv.close()
    else:
        # Nothing here but a picture - handing this to pdf2docx would just
        # embed that picture as-is, which reproduces the exact problem
        # this works around: a "converted" .docx you still can't select
        # or edit a single word of. OCR every page instead (the same
        # per-page OCR extract.py already falls back to for a scanned
        # PDF's search index - see extract._ocr_pdf_page) and build a
        # plain document from the recovered words. The original visual
        # layout doesn't survive this - there's no getting both a
        # pixel-for-pixel scan AND real, independently editable text - but
        # what lands in the document is now actual words you can select,
        # retype, and reflow, not a picture of them.
        _pdf_to_docx_via_ocr(path, dest)


def _pdf_to_docx_via_ocr(path: Path, dest: Path) -> None:
    import docx
    from pypdf import PdfReader

    # Same reasoning as _pdf_has_text_layer above.
    with open(path, "rb") as f:
        page_count = len(PdfReader(f).pages)

    document = docx.Document()
    for page_num in range(page_count):
        if page_num > 0:
            document.add_page_break()
        text = extract._ocr_pdf_page(path, page_num).strip()
        if not text:
            document.add_paragraph("")
            continue
        for line in text.splitlines():
            if line.strip():
                document.add_paragraph(line.strip())
    document.save(str(dest))


def _pdf_to_txt(path: Path, dest: Path) -> None:
    text = extract.extract_text(path)
    dest.write_text(text, encoding="utf-8")


def _normalize_image_bytes(path: Path) -> bytes:
    """A plain PNG re-encode, for an image format a converter library
    below doesn't accept directly (some WEBP/TIFF files trip up img2pdf
    and python-docx alike) - Pillow already handles decoding all of these
    elsewhere in the app (ocr.py's OCR pipeline)."""
    import io

    from PIL import Image

    with Image.open(path) as im:
        buf = io.BytesIO()
        im.convert("RGB").save(buf, format="PNG")
        return buf.getvalue()


def _image_to_pdf(path: Path, dest: Path) -> None:
    import img2pdf

    try:
        dest.write_bytes(img2pdf.convert(str(path)))
    except Exception:
        dest.write_bytes(img2pdf.convert(_normalize_image_bytes(path)))


def _image_to_docx(path: Path, dest: Path) -> None:
    # The image goes at the top of a fresh document, with one empty
    # paragraph directly under it - room to type into once this gets
    # opened (see main.py's caller, which opens the result in whatever
    # program the person already has set to handle .docx files).
    import io

    import docx

    document = docx.Document()
    try:
        document.add_picture(str(path))
    except Exception:
        document.add_picture(io.BytesIO(_normalize_image_bytes(path)))
    document.add_paragraph("")
    document.save(str(dest))


def _text_to_xlsx(path: Path, dest: Path) -> None:
    import csv
    import io

    from openpyxl import Workbook

    raw = path.read_text(encoding="utf-8", errors="replace")
    # Sniffs the actual delimiter rather than assuming comma - handles a
    # tab-separated export exactly as readily as a genuine .csv. Falls
    # back to comma for a file with too little structure to sniff (a
    # single line, or genuinely freeform text with no consistent
    # delimiter) - that still lands every row in column A rather than
    # failing outright.
    sample = raw[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",\t;|")
    except csv.Error:
        dialect = csv.excel

    wb = Workbook()
    ws = wb.active
    for row in csv.reader(io.StringIO(raw), dialect):
        ws.append(row)
    wb.save(str(dest))
