"""OCR for images, so a screenshot or photo containing text ('receipt', a sign,
a book page) is findable by that text, in addition to CLIP's visual matching.
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp", ".tiff"}

# Where the official installers put tesseract.exe/tesseract by default, used
# as a last-resort fallback below when it isn't bundled and isn't resolvable
# on PATH. Checking PATH alone isn't enough on Windows in particular: an
# installer updates the registry's PATH value, but a process (or the
# terminal window it was launched from) that was already running before the
# install finished keeps its own stale copy of PATH until it's restarted -
# so right after installing Tesseract, "not on PATH yet" and "not installed"
# look identical from here unless we also check the well-known location
# directly.
_WELL_KNOWN_INSTALL_PATHS = [
    Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe"),
    Path(r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe"),
    Path("/usr/local/bin/tesseract"),  # Homebrew, Intel Mac
    Path("/opt/homebrew/bin/tesseract"),  # Homebrew, Apple Silicon
]

_tesseract_configured = False
_tesseract_ok: bool | None = None


def tesseract_available() -> bool:
    """Whether OCR is actually usable right now, not just importable -
    pytesseract imports fine even when the tesseract binary itself is
    missing, and every OCR call then just quietly returns "" (see
    ocr_pil_image below), which is exactly the failure mode that made
    "text in images" search silently do nothing for a real user who'd never
    installed Tesseract separately (it's a native program, not a pip
    package - see the README). Exposed so the app can tell the person about
    it instead of leaving them to wonder why searching for text that's
    plainly in a screenshot finds nothing. Checked once and cached - the
    answer can't change during the life of this process."""
    global _tesseract_ok
    if _tesseract_ok is not None:
        return _tesseract_ok
    _configure_tesseract()
    try:
        import pytesseract

        pytesseract.get_tesseract_version()
        _tesseract_ok = True
    except Exception:
        _tesseract_ok = False
    return _tesseract_ok


def _configure_tesseract() -> None:
    """Point pytesseract at a Tesseract binary. Tries, in order: one bundled
    alongside the backend (see README - "Bundling Tesseract for
    distribution"), so a packaged install needs nothing pre-installed on the
    target machine; whatever's already resolvable on PATH (a system-wide
    install, e.g. from the dev setup instructions); and finally the default
    location the official installer puts it in, in case it's installed but
    not yet on this process's PATH (see _WELL_KNOWN_INSTALL_PATHS above). If
    none of those pan out, ocr_image() below just quietly returns no text
    per file - OCR is a bonus signal, not a hard requirement."""
    global _tesseract_configured
    if _tesseract_configured:
        return
    _tesseract_configured = True

    try:
        import pytesseract
    except Exception:
        return

    bundled_dir = Path(__file__).resolve().parent.parent / "tesseract"
    bundled_exe = bundled_dir / ("tesseract.exe" if os.name == "nt" else "tesseract")
    if bundled_exe.exists():
        pytesseract.pytesseract.tesseract_cmd = str(bundled_exe)
        os.environ.setdefault("TESSDATA_PREFIX", str(bundled_dir / "tessdata"))
        return

    if shutil.which("tesseract"):
        # Already resolvable as-is - pytesseract's default "tesseract"
        # command will find it on PATH when it spawns the process.
        return

    for candidate in _WELL_KNOWN_INSTALL_PATHS:
        if candidate.exists():
            pytesseract.pytesseract.tesseract_cmd = str(candidate)
            return


def ocr_image(path: Path) -> str:
    try:
        from PIL import Image

        with Image.open(path) as img:
            return ocr_pil_image(img)
    except Exception:
        # Unreadable image, etc. OCR is a bonus signal on top of CLIP
        # embeddings, so we degrade quietly rather than failing indexing.
        return ""


# Below this many combined characters from the cheap base passes, an image
# is treated as "basically no real text found yet" and worth paying for the
# slower upscaled passes on. A real document/screenshot/photo with actual
# prose or labeled fields reads as comfortably more than this; it's
# specifically a sparse, isolated, stylized number/code (a trading app's
# summary card, say) - the case the upscale passes were added for - that
# reads as barely anything here.
UPSCALE_RESCUE_THRESHOLD = 40


def ocr_pil_image(img) -> str:
    """OCRs an already-open PIL image (also used for rendered PDF pages, see
    extract.py) rather than requiring a file on disk.

    Runs Tesseract over a couple of cheap, differently-prepared versions of
    the image first and combines whatever text each finds, rather than
    trusting one pass. Real-world images vary a lot in what reads best: a
    plain document photo is usually fine as-is. Only when those cheap passes
    together still found next to nothing does this escalate to a couple of
    upscaled passes, which read a stylized graphic - a glowing/outlined
    number on a dark background, like a trading app's summary card, or a
    thin UI font - far more reliably, but take noticeably longer; there's no
    point paying that cost on every one of a folder's images when the large
    majority already read fine on the first try. A number or word that's
    correct in just one variant is still fully searchable even though others
    may garble it."""
    _configure_tesseract()
    try:
        import pytesseract

        texts: list[str] = []
        seen: set[str] = set()

        def _run(variant) -> None:
            try:
                text = pytesseract.image_to_string(variant).strip()
            except Exception:
                return
            if text and text not in seen:
                seen.add(text)
                texts.append(text)

        rgb, gray = _base_variants(img)
        _run(rgb)
        _run(gray)

        combined = "\n".join(texts)
        if len(combined) < UPSCALE_RESCUE_THRESHOLD:
            for variant in _upscale_variants(img):
                _run(variant)
            combined = "\n".join(texts)

        if len(combined) < 4:
            # Every pass above came back essentially empty - a strong sign
            # the image is mostly just one isolated number/code on a plain
            # background (Tesseract's default page segmentation assumes a
            # block of prose and can miss that entirely). Retry once assuming
            # sparse, isolated text, which reads those much more reliably.
            try:
                sparse = pytesseract.image_to_string(img.convert("RGB"), config="--psm 11").strip()
                if sparse:
                    combined = sparse
            except Exception:
                pass
        return combined
    except Exception:
        return ""


def _base_variants(img):
    """The two cheap passes run on every image - see ocr_pil_image above."""
    from PIL import ImageOps

    rgb = img.convert("RGB")
    gray_autocontrast = ImageOps.autocontrast(rgb.convert("L"))
    return rgb, gray_autocontrast


def _upscale_variants(img) -> list:
    """A couple of upscaled, normalized versions of an image - only run when
    the cheap base passes found little to nothing (see ocr_pil_image)."""
    from PIL import Image, ImageOps

    gray = img.convert("L")

    # A modest upscale often reads stylized or thin-stroked text far more
    # reliably than the original resolution does - even when that resolution
    # is already fairly large, which is why this isn't limited to small
    # thumbnails. Capped so an already-huge photo doesn't get blown up
    # further and slow OCR down for no real benefit.
    longest = max(gray.size) or 1
    cap = 2600
    variants = []
    for scale in (1.3, 1.8):
        effective = min(scale, cap / longest)
        if effective > 1.05:
            big = gray.resize(
                (round(gray.width * effective), round(gray.height * effective)), Image.LANCZOS
            )
            variants.append(ImageOps.autocontrast(big))
    return variants
