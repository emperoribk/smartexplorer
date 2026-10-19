"""Finds files that are the same, or near enough the same, that keeping all
of them is probably accidental clutter rather than a deliberate choice:

  - exact duplicates: byte-identical files (same sha256 hash), any kind -
    two copies of an installer, a screenshot saved twice under a different
    name, etc. The hash is computed once per file during ordinary indexing
    (see indexer.py's _hash_file) and just cached in the files table.

  - near-duplicate images: different bytes, but CLIP's embedding says
    they're almost the same picture - a burst of near-identical
    screenshots, a photo saved at two sizes/qualities, etc. Nothing here
    needs any new indexing work: every image already gets a CLIP embedding
    for semantic search (see embeddings.py), so this is just a pairwise
    comparison over vectors that were already computed and stored.

  - near-duplicate documents: different bytes, no CLIP embedding to compare
    (this is for actual documents - PDF/DOCX/TXT/MD - not images), but the
    extracted/OCR'd text two files share says they're essentially the same
    document: the same letter exported as both .pdf and .docx, a renamed
    second copy, draft 2 of a proposal with a paragraph tweaked. Reuses the
    same text already sitting in files_fts from ordinary indexing (see
    extract.py) - no new extraction work either. See
    find_near_duplicate_documents below for why this needed its own
    (calibrated against a real ~150-document library) similarity measure
    and clustering approach, distinct from the image path above.

All three are read-only queries over the existing index - nothing here
deletes anything; that stays a deliberate, explicit action the person takes
in the UI after reviewing what was found.
"""
from __future__ import annotations

import math
import re
import sqlite3
from dataclasses import dataclass
from typing import Dict, List, Optional, Set, Tuple

from . import db
from .cluster import complete_linkage_cluster

# Cosine similarity above this counts as "basically the same picture" for
# CLIP's ViT-B-32 embeddings. Two genuinely different photos of a similar
# subject (two different cats, two different trading screenshots) typically
# land well below this; a resave, a crop, a re-screenshot of the same
# moment, or a lightly edited copy lands well above it. Chosen
# conservatively (high) on purpose - a missed near-duplicate is a lot less
# annoying than a false "these are the same" flagged for two photos that
# just happen to look alike, which would erode trust in the whole feature.
#
# In practice this alone isn't enough for *structured* screenshots - a
# trading-result card or a stock-quote card is mostly constant app chrome
# (layout, fonts, colors) around a small patch of numbers that's the actual
# differentiator. CLIP embeds the whole image, so two different trades in
# the same app can score above this threshold on visual similarity alone:
# real example from this app's own dev/test data, two screenshots of two
# different options trades (+$211,899 vs +$32,226 realized P/L) scored
# 0.9944 - comfortably above 0.97. So CLIP similarity is treated as a
# candidate signal, not a verdict - see _text_corroborates below, which
# checks the two files' already-OCR'd text before accepting the match.
NEAR_DUP_THRESHOLD = 0.97

# A dollar (or "N USD") amount specifically - see MONEY_JACCARD_THRESHOLD
# below for why this gets checked ahead of generic numbers.
_MONEY_RE = re.compile(r"\$\s*([\d][\d,]*\.?\d*)|([\d][\d,]*\.?\d*)\s*USD\b")

# A "number" here means a price, percentage, date, code, etc pulled out of
# each file's OCR'd text - anything that's mostly digits, at least 2
# characters so a stray page-number-ish single digit doesn't count as a
# meaningful match on its own.
_NUMBER_RE = re.compile(r"\d[\d,]*\.?\d*")

# A "word" is an alphabetic token of at least 3 letters - long enough to
# skip single-letter noise from OCR misreads without needing a stopword
# list.
_WORD_RE = re.compile(r"[a-zA-Z]{3,}")

# Two screenshots whose extracted dollar amounts overlap at least this much
# on a Jaccard basis count as textually corroborated. This turned out to be
# the signal that actually matters for a "trading result card" style
# screenshot, and it has to be checked *before*, and separately from, the
# generic all-numbers check below it: a family of screenshots from the same
# options-profit-calculator template shares its entry price, exit price,
# contract count and date across many different what-if scenarios, and only
# the realized-P/L dollar figure actually varies between them. That shared
# boilerplate dominates a Jaccard over *all* numbers - real example from
# this app's own dev/test data, two screenshots with entry $31.45, exit
# $110.45, 28 contracts, same date, but a realized P/L of +$516,287 on one
# and +$37,667 on the other scored 0.73 on all-numbers overlap (because 11
# of 13 shared tokens are template boilerplate) yet only 0.33 when the
# comparison is narrowed to just the dollar amounts, where the one that
# actually differs is 1 of only 3. Genuine duplicates (the same card,
# resaved or re-encoded) scored 1.0 here every time.
MONEY_JACCARD_THRESHOLD = 0.7

# Same idea, for screenshots that have numbers but no dollar amounts at all
# (an invite code, a date, a percentage). Calibrated the same way: genuine
# duplicates landed at 1.000, the false positives CLIP alone produced
# topped out at 0.625. 0.7 sits in the gap with margin on both sides.
#
# Known remaining gap: this tier isn't foolproof for screenshots whose
# "numbers" are actually filenames or IDs rather than differentiating
# content - two different file-manager search-results screenshots, for
# instance, can share most of the filenames visible in their thumbnail grid
# and still clear 0.7 even though the search terms typed into them differ.
# That's a real false positive this version doesn't catch; it's a narrower,
# lower-stakes case than the trading-card/stock-quote one this was built
# for; tightening it further is possible but risks new false negatives
# elsewhere and hasn't been done here.
NUMBER_JACCARD_THRESHOLD = 0.7

# Same idea as NUMBER_JACCARD_THRESHOLD, but for the (rarer) case where
# neither image has any extractable numbers at all - e.g. two chat
# screenshots. Falls back to comparing the actual words used, since two
# different conversations sharing the same messaging-app chrome shouldn't
# be called duplicates just because they look alike. Set high (a genuine
# duplicate - the same caption OCR'd twice off two resaves of one image -
# scored a clean 1.0 in testing) since shared app chrome can otherwise
# inflate raw word overlap even between genuinely different screenshots.
WORD_JACCARD_THRESHOLD = 0.85

# Skip the near-duplicate image pass above this many images in one folder.
# It's an all-pairs comparison (every image compared against every other),
# so the cost - and the memory for the similarity matrix - grows with the
# square of how many images there are. This cap is far beyond a typical
# personal folder; past it, the pass is skipped outright rather than left to
# run for a long time or hold a large matrix in memory. (Exact-duplicate
# detection has no such limit - it's a single indexed SQL query either way.)
NEAR_DUP_MAX_IMAGES = 8000

# A document-vs-document word's extracted text is only a meaningful signal
# once it has enough of it - a near-empty extraction (a near-blank scan, a
# title-only page, a tiny config/locale file that slipped into the "text"
# kind) can trivially share 100% of its handful of words with something
# completely unrelated. Calibrated against a real ~150-document library:
# every genuine near-duplicate checked by hand had well over this many
# words on both sides; the false positives this measure produced without a
# floor came specifically from documents under it.
DOC_MIN_WORDS = 15

# Weighted (IDF) Jaccard over each document's extracted words, required on
# BOTH the primary similarity check and (via _text_corroborates's own word
# tier) the corroboration check below - see find_near_duplicate_documents.
# Calibrated the same way WORD_JACCARD_THRESHOLD above was: real near-
# duplicates in test data (the same letter re-exported as .pdf/.docx, draft
# 2 of a proposal, a renamed second copy) scored 0.85-1.000; unrelated
# documents that merely shared a lot of generic boilerplate language
# scored well below that once _text_corroborates' money/number tiers were
# applied (see that function - built for near-duplicate images, reused
# here unchanged since it isn't specific to what established the
# "candidate" match in the first place).
DOC_SIMILARITY_THRESHOLD = 0.85

# Document file kinds that extraction turns into real body text - not the
# full set indexer.py calls "text" kind (which also includes .csv/.json/
# .xml/.yaml/.yml/.ini/.log: config and tabular data, where "near-duplicate"
# isn't a meaningful idea the way it is for an actual document). Scoping to
# these is what keeps this feature from flagging, say, two different
# localized copies of an installer's locale.json as "near-duplicate
# documents" just because they share the same field names - confirmed
# against real data, not a guess.
DOC_NEAR_DUP_EXTS = {".pdf", ".docx", ".txt", ".md"}

# Safety cap, same idea as NEAR_DUP_MAX_IMAGES - skip the pass outright
# above this many eligible documents in one folder rather than let an
# O(n^2) pass over plain-Python word sets (not vectorized the way the CLIP
# path above is) run for a long time. Set lower than the image cap
# specifically because this path's per-pair cost is real Python set
# operations, not a single matrix multiply.
DOC_NEAR_DUP_MAX_FILES = 2000



@dataclass
class ExactGroup:
    content_hash: str
    paths: List[str]
    filenames: List[str]
    size: int
    kind: str


@dataclass
class NearDupGroup:
    paths: List[str]
    filenames: List[str]
    # The loosest (lowest) and tightest (highest) pairwise similarity found
    # anywhere within the group - shown in the UI as a rough "how sure is
    # this" signal. These can differ a fair bit within one group: a group of
    # 3+ images is formed by chaining "A looks like B" and "B looks like C"
    # (see _cluster below), so A and C don't have to be all that similar to
    # each other for all three to end up grouped together. That's visible
    # here on purpose rather than papered over.
    min_similarity: float
    max_similarity: float


@dataclass
class NearDupDocGroup:
    paths: List[str]
    filenames: List[str]
    # Same meaning as NearDupGroup's min/max_similarity above, but these
    # behave a little differently: this group is formed by complete-linkage
    # clustering (see find_near_duplicate_documents), not union-find, which
    # guarantees every pair within the group cleared DOC_SIMILARITY_THRESHOLD
    # directly - min_similarity can never be a weak link chained in through
    # a middle document the way it theoretically could for the union-find
    # image path above.
    min_similarity: float
    max_similarity: float


def find_exact_duplicates(conn: sqlite3.Connection) -> List[ExactGroup]:
    rows = conn.execute(
        """
        SELECT content_hash, path, filename, size, kind
        FROM files
        WHERE content_hash IS NOT NULL AND content_hash != ''
        ORDER BY content_hash
        """
    ).fetchall()

    groups: Dict[str, ExactGroup] = {}
    for content_hash, path, filename, size, kind in rows:
        g = groups.get(content_hash)
        if g is None:
            groups[content_hash] = ExactGroup(
                content_hash=content_hash, paths=[path], filenames=[filename], size=size, kind=kind
            )
        else:
            g.paths.append(path)
            g.filenames.append(filename)

    result = [g for g in groups.values() if len(g.paths) > 1]
    # Biggest reclaimable space first - a folder full of tiny duplicate text
    # files is real, but a person cleaning up almost always cares more about
    # the group of three 200MB installers first.
    result.sort(key=lambda g: g.size * (len(g.paths) - 1), reverse=True)
    return result


def _cluster(n: int, edges: List[Tuple[int, int]]) -> List[List[int]]:
    """Union-find: groups indices 0..n-1 into connected components given a
    list of (i, j) pairs known to be similar enough to link. Two images end
    up in the same group if there's *any* chain of above-threshold pairs
    connecting them, not just a single direct comparison - see NearDupGroup
    above for what that means for min_similarity within a group."""
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, j in edges:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[ri] = rj

    clusters: Dict[int, List[int]] = {}
    for i in range(n):
        clusters.setdefault(find(i), []).append(i)
    return list(clusters.values())


def _extract_money(text: Optional[str]) -> Set[str]:
    if not text:
        return set()
    out: Set[str] = set()
    for m in _MONEY_RE.finditer(text):
        val = (m.group(1) or m.group(2) or "").replace(",", "")
        if val:
            out.add(val)
    return out


def _extract_numbers(text: Optional[str]) -> Set[str]:
    if not text:
        return set()
    return {m.group().replace(",", "") for m in _NUMBER_RE.finditer(text) if len(m.group()) >= 2}


def _extract_words(text: Optional[str]) -> Set[str]:
    if not text:
        return set()
    return {w.lower() for w in _WORD_RE.findall(text)}


def _jaccard(a: Set[str], b: Set[str]) -> Optional[float]:
    """None means "no signal either way" (both sets empty) rather than 0 -
    callers treat that as "nothing to contradict the visual match with"."""
    if not a and not b:
        return None
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _text_corroborates(
    money_a: Set[str],
    money_b: Set[str],
    numbers_a: Set[str],
    numbers_b: Set[str],
    words_a: Set[str],
    words_b: Set[str],
) -> bool:
    """Whether the OCR'd text of two files backs up (or at least doesn't
    contradict) what CLIP's visual similarity is claiming.

    Three tiers, most specific signal first, each one only consulted when
    the tier above it found nothing to go on:

      1. dollar amounts (MONEY_JACCARD_THRESHOLD) - the actual differentiator
         on a trading-result or stock-quote card, where everything else
         (dates, contract counts, entry/exit prices) is often shared
         boilerplate across many different outcomes.
      2. other numbers (NUMBER_JACCARD_THRESHOLD) - invite codes, dates,
         percentages, for screenshots with numeric content but no $ amounts.
      3. words (WORD_JACCARD_THRESHOLD) - for text-only screenshots with no
         numbers at all, e.g. a chat conversation.

    Two files with no OCR'd text at all on either side (the common case for
    ordinary photos, which is what this feature was originally built to
    catch - a burst of near-identical shots, a photo saved at two sizes)
    fall through all three tiers and are corroborated by default: there's no
    text to disagree with, so the visual signal stands alone as before.
    """
    if money_a or money_b:
        j = _jaccard(money_a, money_b)
        return j is not None and j >= MONEY_JACCARD_THRESHOLD

    if numbers_a or numbers_b:
        j = _jaccard(numbers_a, numbers_b)
        return j is not None and j >= NUMBER_JACCARD_THRESHOLD

    j = _jaccard(words_a, words_b)
    return j is None or j >= WORD_JACCARD_THRESHOLD


def find_near_duplicate_images(conn: sqlite3.Connection) -> List[NearDupGroup]:
    rows = conn.execute(
        """
        SELECT f.path, f.filename, e.vector, fts.content
        FROM embeddings e
        JOIN files f ON f.id = e.file_id
        LEFT JOIN files_fts fts ON fts.path = f.path
        """
    ).fetchall()
    if len(rows) < 2 or len(rows) > NEAR_DUP_MAX_IMAGES:
        return []

    import numpy as np

    paths = [r[0] for r in rows]
    filenames = [r[1] for r in rows]
    vectors = np.array([db.blob_to_vector(r[2]) for r in rows], dtype=np.float32)
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1e-8
    unit = vectors / norms

    # One matrix multiply gives every pairwise cosine similarity at once -
    # this is the "nearly free" part: no per-pair model call, just linear
    # algebra over vectors that search.py's semantic search already needed
    # computed and stored anyway.
    sims = unit @ unit.T

    # Precomputed once per file (not per pair) - the OCR text these come
    # from was already sitting in files_fts from ordinary indexing, so this
    # whole pass costs nothing beyond parsing text that's already local.
    money = [_extract_money(r[3]) for r in rows]
    numbers = [_extract_numbers(r[3]) for r in rows]
    words = [_extract_words(r[3]) for r in rows]

    n = len(paths)
    edges = [
        (i, j)
        for i in range(n)
        for j in range(i + 1, n)
        if sims[i, j] >= NEAR_DUP_THRESHOLD
        and _text_corroborates(money[i], money[j], numbers[i], numbers[j], words[i], words[j])
    ]
    clusters = _cluster(n, edges)

    groups: List[NearDupGroup] = []
    for members in clusters:
        if len(members) < 2:
            continue
        pair_sims = [
            float(sims[members[a], members[b]])
            for a in range(len(members))
            for b in range(a + 1, len(members))
        ]
        groups.append(
            NearDupGroup(
                paths=[paths[i] for i in members],
                filenames=[filenames[i] for i in members],
                min_similarity=min(pair_sims),
                max_similarity=max(pair_sims),
            )
        )
    groups.sort(key=lambda g: len(g.paths), reverse=True)
    return groups


def find_near_duplicate_documents(conn: sqlite3.Connection) -> List[NearDupDocGroup]:
    """Near-duplicate *documents* (PDF/DOCX/TXT/MD - see DOC_NEAR_DUP_EXTS),
    by extracted-text similarity. Unlike near-duplicate images, there's no
    CLIP embedding to lean on here - text is the only signal available, so
    (unlike the image path, where text is a secondary corroboration check
    on top of an already-strong visual match) it has to carry the whole
    comparison on its own. That took real calibration against a real
    ~150-document test library, not just reusing NEAR_DUP_THRESHOLD's
    approach wholesale - two things fell out of that calibration that
    shaped this function:

      1. A plain (or even IDF-weighted) word Jaccard alone isn't enough.
         Short/sparse extractions (a near-blank scan, a title-only page)
         trivially share 100% of their handful of words with something
         completely unrelated - that's exactly where DOC_MIN_WORDS comes
         from, not a guess. More surprising: even past that floor, two
         *different* documents built from the same boilerplate template
         (a form letter, an agreement) can still score very high on word
         overlap alone, with only the actual differentiating numbers
         (an amount, an account, a date) telling them apart - the same
         "shared app chrome inflates the match" problem NEAR_DUP_THRESHOLD's
         module-level comment describes for trading-screenshot templates,
         just in document form. _text_corroborates already solves exactly
         this (its money/number tiers were built for that reason), so it's
         reused here as a required second gate, unchanged, rather than
         writing a parallel version of the same idea.

      2. Plain union-find chaining (duplicates.py's near-duplicate *image*
         path) produced the same "one dominant blob" failure mode the (since removed) Smart albums
         already documented for images, once enough documents shared
         generic language - confirmed against the same real test library.
         Complete-linkage (see cluster.py) fixes it the same way it does
         there: a group only forms when every pair within it clears the
         bar directly, not through a chain of weaker links.

    Reuses the OCR/extracted text already sitting in files_fts from
    ordinary indexing (see extract.py) - no new extraction work, same as
    the image path above reuses already-computed CLIP embeddings."""
    rows = conn.execute(
        """
        SELECT f.path, f.filename, f.ext, fts.content
        FROM files f
        JOIN files_fts fts ON fts.path = f.path
        WHERE f.kind = 'text' AND fts.content IS NOT NULL AND length(fts.content) > 0
        """
    ).fetchall()

    eligible: List[Tuple[str, str, str]] = []  # (path, filename, content)
    for path, filename, ext, content in rows:
        if (ext or "").lower() not in DOC_NEAR_DUP_EXTS:
            continue
        eligible.append((path, filename, content))

    if len(eligible) < 2 or len(eligible) > DOC_NEAR_DUP_MAX_FILES:
        return []

    import numpy as np

    word_sets = [_extract_words(c) for _p, _f, c in eligible]
    keep = [i for i, w in enumerate(word_sets) if len(w) >= DOC_MIN_WORDS]
    if len(keep) < 2:
        return []

    paths = [eligible[i][0] for i in keep]
    filenames = [eligible[i][1] for i in keep]
    contents = [eligible[i][2] for i in keep]
    words = [word_sets[i] for i in keep]

    # IDF computed once, over this folder's own eligible-document set - a
    # word that shows up in nearly every document here (boilerplate common
    # to this folder specifically, not some fixed external corpus) is
    # correctly treated as weak evidence, the same way it would be for a
    # much smaller or larger folder.
    doc_count_for_word: Dict[str, int] = {}
    for w in words:
        for word in w:
            doc_count_for_word[word] = doc_count_for_word.get(word, 0) + 1
    total = len(words)

    def idf(word: str) -> float:
        return math.log((total + 1) / (doc_count_for_word.get(word, 0) + 1))

    def weighted_jaccard(a: Set[str], b: Set[str]) -> float:
        shared = a & b
        if not shared:
            return 0.0
        union = a | b
        union_weight = sum(idf(w) for w in union)
        if union_weight <= 0:
            return 0.0
        return sum(idf(w) for w in shared) / union_weight

    # money/numbers are the corroboration signal (see _text_corroborates);
    # `words` (already computed above, used for the candidate weighted-
    # Jaccard score) doubles as its plain-word tier too - no need to
    # extract the same thing from the same content a second time.
    money = [_extract_money(c) for c in contents]
    numbers = [_extract_numbers(c) for c in contents]

    n = len(paths)
    sims = np.zeros((n, n), dtype=np.float64)
    for i in range(n):
        for j in range(i + 1, n):
            wj = weighted_jaccard(words[i], words[j])
            if wj < DOC_SIMILARITY_THRESHOLD:
                continue
            if not _text_corroborates(
                money[i], money[j], numbers[i], numbers[j], words[i], words[j]
            ):
                continue
            sims[i, j] = sims[j, i] = wj

    clusters = complete_linkage_cluster(sims, DOC_SIMILARITY_THRESHOLD)

    groups: List[NearDupDocGroup] = []
    for members in clusters:
        if len(members) < 2:
            continue
        pair_sims = [
            float(sims[members[a], members[b]])
            for a in range(len(members))
            for b in range(a + 1, len(members))
        ]
        groups.append(
            NearDupDocGroup(
                paths=[paths[i] for i in members],
                filenames=[filenames[i] for i in members],
                min_similarity=min(pair_sims),
                max_similarity=max(pair_sims),
            )
        )
    groups.sort(key=lambda g: len(g.paths), reverse=True)
    return groups
