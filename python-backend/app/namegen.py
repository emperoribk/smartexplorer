"""Smart auto-naming: turns the OCR/extracted text a file already has in the
index (files_fts.content - see db.py's schema) into a short, readable
filename, e.g. a screenshot OCR'd as "Quanto  Colombia vs Portugal  Ticket
#48291  Section 12..." becomes `quanto-colombia-portugal-ticket.jpg`.

Deliberately does no new OCR/CLIP work here - this only reads text that
indexing already extracted and stored, so a suggestion is just a SQLite
lookup plus some string processing, not a fresh pass over the file's bytes.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

_WORD_RE = re.compile(r"[A-Za-z]+")

# Common function words, plus screenshot/UI "noise" that shows up in OCR text
# constantly (site chrome, browser tab text, boilerplate) but never tells one
# file apart from another - the same reason duplicates.py's near-duplicate
# check has to look past shared boilerplate to find what's actually distinct
# about a given screenshot. Keeping this list modest on purpose: it only
# needs to remove words common enough to show up in *most* OCR'd screenshots,
# not attempt real stopword-list completeness.
_STOPWORDS = {
    "the", "and", "for", "are", "was", "were", "this", "that", "with", "from",
    "your", "you", "have", "has", "had", "not", "but", "than", "then", "into",
    "out", "over", "under", "more", "most", "some", "any", "each", "other",
    "such", "only", "own", "same", "how", "why", "what", "which", "who",
    "whom", "these", "those", "been", "being", "does", "did", "doing",
    "would", "should", "could", "about", "before", "after", "again", "once",
    "here", "there", "when", "where", "all", "can", "will", "just", "also",
    "its", "it's", "our", "we", "us", "you're", "youre", "com", "www", "http",
    "https", "html", "png", "jpg", "jpeg", "screenshot", "image", "untitled",
    "download", "downloads", "file", "files", "copy", "new", "search",
    "results", "windows", "explorer", "desktop", "folder",
}

MAX_WORDS = 5
MAX_SLUG_LENGTH = 60


def _extract_keywords(text: str, max_words: int = MAX_WORDS) -> list[str]:
    """Picks the words that best identify this piece of text: frequent
    enough to be a real topic (not an OCR fluke) but not so common they'd
    show up in every screenshot. Ties are broken by whichever word appeared
    first, and the final list is re-ordered back to first-appearance order
    so the slug reads the way the source text did (a ticket's team names
    before its seat info, say) rather than by raw frequency rank."""
    counts: dict[str, int] = {}
    first_seen: dict[str, int] = {}
    for i, tok in enumerate(_WORD_RE.findall(text)):
        w = tok.lower()
        if len(w) < 3 or w in _STOPWORDS:
            continue
        counts[w] = counts.get(w, 0) + 1
        first_seen.setdefault(w, i)

    if not counts:
        return []

    ranked = sorted(counts, key=lambda w: (-counts[w], first_seen[w]))
    top = ranked[:max_words]
    top.sort(key=lambda w: first_seen[w])
    return top


def suggest_filename(content_text: Optional[str], original_ext: str) -> Optional[str]:
    """Returns a suggested filename (with `original_ext` kept, e.g.
    ".jpg"), or None when there's no usable extracted text to work from -
    the caller should treat None as "nothing to suggest here" rather than a
    fallback to guess from, so the UI can say so plainly rather than
    offering a name that isn't actually based on anything."""
    if not content_text:
        return None

    words = _extract_keywords(content_text)
    if not words:
        return None

    # Trim from the end (in reading order) until it fits a sane length - a
    # name this feature suggests should never be unwieldy. Words already
    # start ranked by relevance/frequency and are only re-ordered to reading
    # order afterward, so the least-relevant word is typically also one of
    # the last kept here, but this is a length cap, not a relevance re-sort.
    slug = "-".join(words)
    while len(slug) > MAX_SLUG_LENGTH and len(words) > 1:
        words = words[:-1]
        slug = "-".join(words)
    slug = slug[:MAX_SLUG_LENGTH].rstrip("-")

    # Capitalize just the first character so a suggested name reads like a
    # title ("Quanto-entry-premium.jpg") rather than all-lowercase - the
    # rest of the slug (and each individual word) is left alone on purpose,
    # this is not a title-case pass.
    if slug:
        slug = slug[0].upper() + slug[1:]

    ext = original_ext.lower() if original_ext else ""
    return f"{slug}{ext}"
