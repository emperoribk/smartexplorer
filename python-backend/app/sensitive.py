"""Flags files whose extracted/OCR'd text contains things that shouldn't
leave this machine casually - a Social Security Number, a credit card
number, a bank routing number, a private key - so a person is warned
*before* they zip up or share a folder, not after. This is a feature a
cloud-based tool couldn't credibly offer the same way: it only works
because the text it's scanning (see extract.py / ocr.py) never left the
device to get here in the first place.

Reuses the same files_fts text every other feature in this module reuses
(duplicates.py's near-duplicate-document pass, search.py's content search)
- no new extraction or OCR work, just a regex pass over text that was
already sitting in the index.

Deliberately narrow rather than broad: every detector here either carries
its own checksum (Luhn for cards, the ABA algorithm for routing numbers) or
is a near-zero-false-positive literal pattern (a PEM private-key header).
A detector that would mostly just flag ordinary numbers - a bare 9-digit
SSN with no dashes and no nearby keyword, a generic "account number" with
no checksum of its own - is left out rather than shipped noisy; see each
detector's own comment for why its particular bar was chosen. Nothing here
is a second guarantee the way the checksummed detectors are - OCR errors
(a misread digit) can make a real sensitive number fail its own checksum
and slip through, the same residual-gap tradeoff the near-duplicate-image
and near-duplicate-document detectors already accept elsewhere in this
file; it's read-only and advisory, not a hard filter.

Matched values are never returned whole - every finding is masked down to
a type and a short suffix (e.g. "SSN ending 1234") before it leaves this
module, the same way a bank statement or receipt would show it. Nothing
here deletes, moves, or redacts the file itself - like duplicates.py, that
stays a deliberate, explicit action the person takes after seeing what was
found.
"""
from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass, field
from typing import Dict, List, Optional

# Skip the pass outright above this many eligible files - same idea as
# duplicates.py's NEAR_DUP_MAX_IMAGES / DOC_NEAR_DUP_MAX_FILES, except this
# pass is linear (one regex sweep per file, no pairwise comparison), so the
# cap exists only to bound one very large folder's worst case, not because
# the cost grows with the square of how many files there are.
SENSITIVE_SCAN_MAX_FILES = 20000

# A finding's masked value shows this many trailing characters of the raw
# match and nothing else - enough for the person to recognize *which*
# number it is (their own, a family member's, a client's) without the
# flagged file's own content round-tripping through the app's UI/state in
# full.
_MASK_KEEP = 4

# Keywords checked for near a candidate match when the pattern alone isn't
# a strong enough signal on its own (see SSN_NO_DASH and ROUTING below).
# Lowercased, checked against a window of plain text around the match -
# not a regex, just a substring test, since these are short, fixed phrases
# with no variation worth a pattern for.
_SSN_KEYWORDS = ("ssn", "social security")
_ROUTING_KEYWORDS = ("routing", "aba number", "transit number")
_KEYWORD_WINDOW = 40  # chars on each side of the match


@dataclass
class Finding:
    kind: str  # "ssn" | "credit_card" | "routing_number" | "private_key"
    masked: str  # e.g. "SSN ending 1234", "private key block"
    count: int  # how many times this exact masked value appears in the file


@dataclass
class FileFindings:
    path: str
    filename: str
    kind: str  # 'text' | 'image' - lets the UI show a real thumbnail for photos
    findings: List[Finding] = field(default_factory=list)


# --- SSN ---------------------------------------------------------------

# The dashed format is specific enough to stand on its own: the area/group/
# serial exclusions below are the same ones the SSA itself never issues
# (000/666/900-999 area, 00 group, 0000 serial), which is what keeps this
# from flagging an arbitrary "123-45-6789"-shaped placeholder used in a
# template or a test fixture - a real never-issued number can't match this
# pattern at all.
#
# Known gap: this doesn't require a nearby "ssn" keyword the way the
# no-dash form below does, so an unrelated number that happens to be
# grouped 3-2-4 with dashes (an order or reference number formatted that
# way, by coincidence) can still be flagged - checked against real test
# data, this specific grouping is rare enough outside actual SSNs that
# requiring a keyword here too would have missed more real ones than it
# would have saved false positives, but it's a real, accepted trade-off,
# not an oversight.
_SSN_DASHED_RE = re.compile(
    r"\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b"
)

# The no-dash form (ssn written as 9 bare digits) is far too easily
# confused with an order number, a tracking number, a phone extension, etc.
# - it's only accepted when one of _SSN_KEYWORDS shows up within
# _KEYWORD_WINDOW characters of the match, the same area/group/serial
# exclusions still applied.
_SSN_NODASH_RE = re.compile(
    r"\b(?!000|666|9\d{2})\d{3}(?!00)\d{2}(?!0000)\d{4}\b"
)


def _find_ssns(text: str) -> List[str]:
    out = []
    for m in _SSN_DASHED_RE.finditer(text):
        out.append(m.group().replace("-", ""))
    lower = text.lower()
    for m in _SSN_NODASH_RE.finditer(text):
        start = max(0, m.start() - _KEYWORD_WINDOW)
        end = min(len(text), m.end() + _KEYWORD_WINDOW)
        if any(k in lower[start:end] for k in _SSN_KEYWORDS):
            out.append(m.group())
    return out


# --- Credit card ---------------------------------------------------------

# Digit runs of 13-19, optionally grouped with spaces or dashes every 4 -
# how a card number is actually written on a statement, receipt, or a
# screenshot of a wallet app, rather than assuming one unbroken run.
_CARD_RE = re.compile(r"\b(?:\d[ -]?){13,19}\b")

# Recognized issuer prefixes + the exact lengths each one actually uses -
# checked ahead of the Luhn test below, not instead of it: prefix+length
# alone would still accept plenty of non-card 15/16-digit numbers, but
# combined with a passing Luhn checksum the two together are what keeps
# this from flagging, say, a 16-digit order or tracking number (which has
# only a 1-in-10 chance of passing Luhn by chance, and isn't shaped like a
# real issuer prefix in the first place).
_CARD_PREFIXES = (
    (re.compile(r"^4\d*$"), (13, 16, 19)),  # Visa
    (re.compile(r"^(5[1-5]\d{2}|222[1-9]|22[3-9]\d|2[3-6]\d{2}|27[01]\d|2720)\d*$"), (16,)),  # Mastercard
    (re.compile(r"^3[47]\d*$"), (15,)),  # Amex
    (re.compile(r"^(6011|65)\d*$"), (16,)),  # Discover
)


def _luhn_ok(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def _find_cards(text: str) -> List[str]:
    out = []
    for m in _CARD_RE.finditer(text):
        digits = re.sub(r"[ -]", "", m.group())
        if not any(
            prefix_re.match(digits) and len(digits) in lengths
            for prefix_re, lengths in _CARD_PREFIXES
        ):
            continue
        if _luhn_ok(digits):
            out.append(digits)
    return out


# --- Bank routing number (ABA) -------------------------------------------

_ROUTING_RE = re.compile(r"\b\d{9}\b")

# The ABA routing-number checksum: a weighted sum (3,7,1 repeating) of the
# 9 digits must be a multiple of 10. Same role Luhn plays for cards - most
# of what keeps this from flagging an arbitrary 9-digit number, with the
# keyword check below as a second, independent gate on top (unlike cards,
# a routing number has no issuer-prefix-shaped signal to lean on, so the
# checksum alone isn't treated as sufficient by itself).
_ROUTING_WEIGHTS = (3, 7, 1, 3, 7, 1, 3, 7, 1)


def _routing_checksum_ok(digits: str) -> bool:
    return sum(int(d) * w for d, w in zip(digits, _ROUTING_WEIGHTS)) % 10 == 0


def _find_routing_numbers(text: str) -> List[str]:
    out = []
    lower = text.lower()
    for m in _ROUTING_RE.finditer(text):
        digits = m.group()
        if not _routing_checksum_ok(digits):
            continue
        start = max(0, m.start() - _KEYWORD_WINDOW)
        end = min(len(text), m.end() + _KEYWORD_WINDOW)
        if any(k in lower[start:end] for k in _ROUTING_KEYWORDS):
            out.append(digits)
    return out


# --- Private key block -----------------------------------------------------

# A PEM private-key header is about as close to a zero-false-positive
# literal pattern as text scanning gets - nothing else is shaped like this
# line. Deliberately not trying to detect API keys/access tokens generally
# (AWS-style "AKIA..." and friends): those patterns vary a lot by provider
# and a narrower, higher-confidence pass felt better than a wider, noisier
# guess - a known gap, not an oversight.
_PRIVATE_KEY_RE = re.compile(r"-{5}BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-{5}")


def _find_private_keys(text: str) -> int:
    return len(_PRIVATE_KEY_RE.findall(text))


# --- Driver ----------------------------------------------------------------


def _mask(kind_label: str, raw: str) -> str:
    tail = raw[-_MASK_KEEP:] if len(raw) > _MASK_KEEP else raw
    return f"{kind_label} ending {tail}"


def _scan_text(text: str) -> List[Finding]:
    findings: List[Finding] = []

    counts: Dict[str, int] = {}
    for raw in _find_ssns(text):
        counts[_mask("SSN", raw)] = counts.get(_mask("SSN", raw), 0) + 1
    for masked, n in counts.items():
        findings.append(Finding(kind="ssn", masked=masked, count=n))

    counts = {}
    for raw in _find_cards(text):
        masked = _mask("card", raw)
        counts[masked] = counts.get(masked, 0) + 1
    for masked, n in counts.items():
        findings.append(Finding(kind="credit_card", masked=masked, count=n))

    counts = {}
    for raw in _find_routing_numbers(text):
        masked = _mask("routing number", raw)
        counts[masked] = counts.get(masked, 0) + 1
    for masked, n in counts.items():
        findings.append(Finding(kind="routing_number", masked=masked, count=n))

    n_keys = _find_private_keys(text)
    if n_keys:
        findings.append(Finding(kind="private_key", masked="private key block", count=n_keys))

    return findings


def scan_folder(conn: sqlite3.Connection) -> List[FileFindings]:
    """Scans every already-indexed file's extracted/OCR'd text for the
    patterns above. Read-only - like duplicates.py, nothing here acts on a
    file; it's the person's call what to do once they see what was found."""
    rows = conn.execute(
        """
        SELECT f.path, f.filename, f.kind, fts.content
        FROM files f
        JOIN files_fts fts ON fts.path = f.path
        WHERE f.kind IN ('text', 'image')
          AND fts.content IS NOT NULL AND length(fts.content) > 0
        """
    ).fetchall()

    if len(rows) > SENSITIVE_SCAN_MAX_FILES:
        rows = rows[:SENSITIVE_SCAN_MAX_FILES]

    results: List[FileFindings] = []
    for path, filename, kind, content in rows:
        findings = _scan_text(content)
        if findings:
            results.append(FileFindings(path=path, filename=filename, kind=kind, findings=findings))

    # Most-flagged file first - mirrors duplicates.py's "biggest thing
    # first" ordering (there by reclaimable space, here by how much a
    # single file has going on).
    results.sort(key=lambda r: sum(f.count for f in r.findings), reverse=True)
    return results
