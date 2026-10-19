"""Merges keyword (FTS5) results with semantic (CLIP) results into one ranked list."""
from __future__ import annotations

import math
import re
import sqlite3
from pathlib import Path
from typing import List, Optional, Set, Tuple, TypedDict

from . import db, embeddings, indexer, query_parse

SEMANTIC_THRESHOLD = 0.20  # CLIP cosine similarities for real matches tend to land ~0.2-0.4
# When a multi-word query already has text matches, photo (CLIP) matches are
# added as extras only if they stand out this many standard deviations above
# the query's own baseline (the normal bar is 2), and at most this many.
STRICT_SIGMAS = 2.5
STRICT_MAX_VISUAL = 24
# ...and only when the best photo match clearly stands out (this many
# standard deviations above the baseline). A query that really describes a
# picture ("brown bag", "red handbag") has a best match 4-5 sigma out; a
# query that is about documents ("invoices of $20", "bank statement march")
# tops out around 2.5-3.7, and adding photos there would just be noise.
STRICT_MIN_TOP_SIGMAS = 4.0
MAX_RESULTS = 200  # shown to the user; also what _rank() slices its final list to.

# A text/content match's score (see _text_search) is the fraction of the
# query's total idf-weight that a file actually matched - 1.0 means it
# matched every meaningful word (or the whole phrase), a fraction means it
# only matched some of them. Below this line, a file matched nothing but
# one weak, generic word the query happened to also contain (searching
# "all invoices $20" and turning up a file that only has "$20" in it
# somewhere, with no "invoice" anywhere) - a coincidence, not a real
# answer to the search. Calibrated against a real multi-hundred-file
# index: genuine multi-word matches land at 0.75-1.0, coincidental single-
# common-word ones land at 0.15-0.45 - there's a real cliff between them,
# not a judgment call. A single-word query is unaffected either way (it
# always scores exactly 1.0 for anything that matches it at all, since
# there's only one word's worth of weight to match in the first place).
MIN_TEXT_MATCH_SCORE = 0.6

# Safety cap on any single raw FTS fetch (per query word, or the bm25
# tiebreak query below) - not a relevance cutoff. Real personal libraries
# don't get anywhere near this for one word; it just protects against a
# pathological query.
TEXT_FETCH_LIMIT = 5000

# "Find similar" (a right-click action on one file, not a typed query)
# compares that file's own already-extracted text against every other
# file's, using the same idf-weighted-overlap idea as the text search
# above - a word two documents share is worth more the rarer it is across
# the rest of the library, so two files sharing lots of boilerplate
# ("the", "invoice", whatever's common in THIS library) don't look related
# just because of that. Calibrated against a real ~600-document library
# (one with every kind of file this app sees: PDFs, docx, OCR'd images,
# csv, json, txt): genuinely unrelated documents (different topics
# entirely - a README against a business proposal, an unrelated PDF
# against another) never scored above ~0.07 no matter how large or varied
# the library got, while every genuinely related pair found (the same
# document saved in two formats, a multi-page scan split across files, a
# burst of related screenshots, successive drafts of the same proposal)
# scored at least double that. This is well clear of that noise ceiling in
# either direction, not a number picked by eye.
SIMILAR_TEXT_THRESHOLD = 0.15

# Safety cap mirroring MAX_RESULTS/_rank below - "find similar" also goes
# through _rank(), so this isn't the only cap, but keeps a maximally messy
# library's full-text comparison pass itself bounded.
SIMILAR_TEXT_FETCH_LIMIT = 20000

_WORD_RE = re.compile(r"[a-zA-Z]{3,}")

# An actual keyword/text match is generally more trustworthy than a "looks
# visually similar" CLIP guess at the same score, so its score is scaled up
# by this much before the two are compared - but this is a multiplier, not
# an absolute wall. Earlier this was a hard tier (every text match, however
# thin, ranked above every visual match, no matter how confident) - which
# turned out to have a real failure mode: in a folder full of trading
# screenshots, a handful of unrelated Chase bank statements that happen to
# contain the word "card" outranked the actual PnL-card screenshots, purely
# because they were "text matches" at all, even though CLIP recognized the
# real cards with far more confidence. A multiplier lets a genuinely
# confident visual match still win over a text match that barely qualifies
# as one, while a solid text match still comfortably beats a so-so visual
# guess.
TEXT_TRUST_MULTIPLIER = 1.4
NAME_TRUST_MULTIPLIER = 2.2  # an exact filename match is trusted even more.

_MATCH_TRUST = {"name": NAME_TRUST_MULTIPLIER, "content": TEXT_TRUST_MULTIPLIER, "visual": 1.0}

# Very short/common words are dropped from keyword search: as FTS5 prefix
# terms (e.g. "a"*) they match almost every document and drown out real
# relevance ranking. They still count for exact filename matching.
STOPWORDS = {
    "a", "an", "the", "of", "in", "on", "to", "for", "and", "or", "is",
    "at", "by", "it", "as", "be", "my", "me", "i",
}
MIN_TERM_LEN = 2


class SearchResult(TypedDict):
    path: str
    filename: str
    kind: str
    score: float
    match_type: str  # 'name' | 'content' | 'visual'
    root: str  # which indexed folder this result came from


def search(root: Path, query: str) -> List[SearchResult]:
    results, _parsed = search_with_info(root, query)
    return results


def search_with_info(root: Path, query: str) -> Tuple[List[SearchResult], query_parse.ParsedQuery]:
    """Same as search(), but also returns what the natural-language query
    parser (query_parse.py) understood from the query - which content words
    it actually searched for, and any kind/date filter it inferred from how
    the query was phrased (e.g. "that ticket screenshot from last week").
    main.py surfaces this back to the UI so filtering is never silent."""
    query = query.strip()
    if not query:
        return [], query_parse.parse("")

    parsed = query_parse.parse(query)

    db_path = indexer.db_path_for(root)
    if not db_path.exists():
        # Nothing has ever been indexed here - don't create an empty database
        # just because someone searched; that would leave a misleading
        # "indexed" marker (a .smartsearch folder) behind for a folder that
        # was never actually indexed.
        return [], parsed

    conn = db.connect(db_path)
    root_str = str(root)
    has_filter = parsed.kind_filter or parsed.date_from is not None or parsed.date_to is not None

    if not parsed.content_query and has_filter:
        # A pure filter query ("photos from last week", nothing else) -
        # list matching files directly rather than running FTS/CLIP search
        # with no content term to search for, which would just find
        # nothing (there's nothing to match against).
        return _browse_by_filter(conn, parsed, root_str), parsed

    results: dict[str, SearchResult] = {}
    _text_search(conn, parsed.content_query, results, root_str)

    # A single-word query's text match is a much weaker guarantee than a
    # multi-word one: MIN_TEXT_MATCH_SCORE only lets a MULTI-term match
    # through when several distinct words are actually corroborated
    # together (or the whole phrase) - a real, validated answer. A lone
    # word, though, trivially scores 1.0 against ANY file containing it
    # anywhere at all, with no corroboration possible (there's only one
    # word's worth of evidence to begin with) - e.g. a screenshot of this
    # very app mid-search, with the typed word visibly on-screen, would
    # "genuinely" contain the word "mountains" without being a mountain
    # photo at all. So a single-word query always also runs visual search,
    # the same as before there was any text threshold - "bag" still finds
    # an actual photo of a bag with no matching filename or OCR text.
    is_multi_term = len(_query_terms(parsed.content_query)) > 1

    # Photo (CLIP) search ALWAYS runs. It used to be skipped for a multi-word
    # query whenever any text matched, on the theory that a corroborated text
    # answer shouldn't be diluted by weaker visual guesses. That made one of
    # the app's best features fail in the most ordinary way: searching
    # "brown bag" found a text file that merely contains those two words (an
    # ImageNet label list, or a screenshot of an earlier search for the same
    # words) and so never looked at the brown bags sitting in the folder.
    # The noise concern is handled instead by making visual matches earn
    # their place when text already found something: a stricter cutoff and a
    # cap on how many visual extras are added (see _visual_similarity_core).
    text_found_multi = is_multi_term and bool(results)
    _visual_search(conn, parsed.content_query, results, root_str, strict=text_found_multi)

    ranked = _rank(results.values())

    if has_filter:
        filtered = _apply_filters(conn, ranked, parsed)
        # Never let a misread filter (a month name that was actually meant
        # as an ordinary word, say) silently erase every real match - if
        # narrowing would leave nothing, show the unfiltered results rather
        # than an unexplained "no results" for something that does exist.
        if filtered or not ranked:
            ranked = filtered

    return ranked, parsed


def _browse_by_filter(
    conn: sqlite3.Connection, parsed: query_parse.ParsedQuery, root: str
) -> List[SearchResult]:
    clauses = []
    params: list = []
    if parsed.kind_filter:
        clauses.append("kind = ?")
        params.append(parsed.kind_filter)
    if parsed.date_from is not None:
        clauses.append("mtime >= ?")
        params.append(parsed.date_from)
    if parsed.date_to is not None:
        clauses.append("mtime <= ?")
        params.append(parsed.date_to)
    where = " AND ".join(clauses) if clauses else "1=1"
    rows = conn.execute(
        f"SELECT path, filename, kind FROM files WHERE {where} ORDER BY mtime DESC LIMIT ?",
        (*params, MAX_RESULTS),
    ).fetchall()
    return [
        SearchResult(path=path, filename=filename, kind=kind, score=1.0, match_type="content", root=root)
        for path, filename, kind in rows
    ]


def _apply_filters(
    conn: sqlite3.Connection, ranked: List[SearchResult], parsed: query_parse.ParsedQuery
) -> List[SearchResult]:
    if not ranked:
        return ranked
    paths = [r["path"] for r in ranked]
    placeholders = ",".join("?" for _ in paths)
    mtimes = dict(
        conn.execute(f"SELECT path, mtime FROM files WHERE path IN ({placeholders})", paths).fetchall()
    )

    out = []
    for r in ranked:
        if parsed.kind_filter and r["kind"] != parsed.kind_filter:
            continue
        mtime = mtimes.get(r["path"])
        if parsed.date_from is not None and (mtime is None or mtime < parsed.date_from):
            continue
        if parsed.date_to is not None and (mtime is None or mtime > parsed.date_to):
            continue
        out.append(r)
    return out


def _rank(results) -> List[SearchResult]:
    # A single blended sort key - each result's own score, scaled by how
    # much its match TYPE is trusted (see _MATCH_TRUST above) - rather than
    # a hard "all text matches first, no matter how thin" tier. That old
    # tier is what let a handful of unrelated files that only matched one
    # common word outrank a file CLIP was genuinely confident about, just
    # for being a "text match" at all.
    ranked = sorted(
        results,
        key=lambda r: r["score"] * _MATCH_TRUST.get(r["match_type"], 1.0),
        reverse=True,
    )
    return ranked[:MAX_RESULTS]


def search_multi(roots: List[Path], query: str) -> List[SearchResult]:
    """Searches several already-indexed folders at once and merges the
    results into one re-ranked list - the "search everywhere I've indexed"
    mode, as opposed to search()'s single current folder. Folders that were
    never indexed, or whose index has gone missing, are silently skipped
    rather than failing the whole search."""
    merged: List[SearchResult] = []
    for root in roots:
        try:
            merged.extend(search(root, query))
        except Exception:
            continue
    return _rank(merged)



def find_similar(root: Path, target_path: str) -> List[SearchResult]:
    """"Find similar" - a right-click action on one already-indexed file,
    rather than a typed query: surfaces everything else in this folder
    that's related to it, the same way an ordinary search would, just with
    the query being "this file" instead of a few typed words. An image
    compares by CLIP embedding (the same visual-similarity machinery
    _visual_search uses for a text query, just given this file's own
    stored vector instead of one derived from a typed description); a
    document compares by its own extracted/OCR'd text against every other
    file's (see _text_similarity_search). A file can have neither, either,
    or both kinds of evidence - whatever it has is used; nothing is forced
    to pick a single comparison method only."""
    db_path = indexer.db_path_for(root)
    if not db_path.exists():
        return []

    conn = db.connect(db_path)
    root_str = str(root)

    row = conn.execute(
        "SELECT id FROM files WHERE path = ?", (target_path,)
    ).fetchone()
    if not row:
        # Not in this folder's index at all (never indexed, or indexing
        # hasn't caught up with a very recent file yet) - nothing to
        # compare it against.
        return []
    target_id = row[0]

    results: dict = {}

    emb_row = conn.execute(
        "SELECT vector FROM embeddings WHERE file_id = ?", (target_id,)
    ).fetchone()
    if emb_row is not None:
        target_vec = db.blob_to_vector(emb_row[0])
        _visual_similarity_core(
            conn,
            target_vec,
            results,
            root_str,
            label=f"<similar to {Path(target_path).name}>",
            exclude_path=target_path,
        )

    text_row = conn.execute(
        "SELECT content FROM files_fts WHERE path = ?", (target_path,)
    ).fetchone()
    if text_row is not None and text_row[0] and text_row[0].strip():
        _text_similarity_search(conn, text_row[0], results, root_str, exclude_path=target_path)

    return _rank(results.values())


def _text_search(conn: sqlite3.Connection, query: str, results: dict, root: str) -> None:
    terms = _query_terms(query)
    if not terms:
        return

    total_docs = conn.execute("SELECT COUNT(*) FROM files").fetchone()[0] or 1

    # How many distinct files each individual query word matches, and how
    # rare that makes it (idf = log(N / matches)). This - not raw bm25 - is
    # what decides how much a matched word is worth. A word that shows up
    # in almost every file (searching "trading" in a folder that's mostly
    # trading screenshots, or "cat" in a folder that's mostly cat photos) is
    # barely a signal at all; a word that shows up in only a couple of files
    # is a strong one. Without weighting by rarity, a file matching only a
    # rare, specific word (e.g. "card", as in "PnL card") can rank behind
    # hundreds of files that only matched a common word in the same query -
    # and that problem gets *worse*, not better, in a bigger library, since
    # the common word only gets more common. Weighting by rarity is what
    # makes the ranking hold up regardless of how large the library is.
    term_paths: dict[str, set] = {}
    idf: dict[str, float] = {}
    for term in terms:
        try:
            rows = conn.execute(
                "SELECT path FROM files_fts WHERE files_fts MATCH ? LIMIT ?",
                (f'"{term}"*', TEXT_FETCH_LIMIT),
            ).fetchall()
        except sqlite3.OperationalError:
            continue
        paths = {p for (p,) in rows}
        if not paths:
            continue
        term_paths[term] = paths
        idf[term] = math.log((total_docs + 1) / len(paths))

    if not term_paths:
        return

    candidate_paths: set = set()
    for paths in term_paths.values():
        candidate_paths |= paths

    # On top of individual words, also check whether the query's words
    # appear together, in order, as a phrase - "a trading PnL card" is a
    # much rarer, much more specific thing to find than "trading", "pnl" or
    # "card" separately, however big the library gets, so a file containing
    # the actual phrase is given a strong boost of its own (its own idf,
    # based on how many files contain that exact phrase - almost always far
    # fewer than any single word in it). This is what would let a photo
    # whose caption or OCR text literally says "blue ribbon" surface near
    # the top even in a library with thousands of other cat photos, rather
    # than relying only on "ribbon" being individually rare enough.
    phrase_paths: set = set()
    phrase_idf = 0.0
    if len(terms) > 1:
        try:
            phrase_rows = conn.execute(
                "SELECT path FROM files_fts WHERE files_fts MATCH ? LIMIT ?",
                (f'"{" ".join(terms)}"', TEXT_FETCH_LIMIT),
            ).fetchall()
        except sqlite3.OperationalError:
            phrase_rows = []
        phrase_paths = {p for (p,) in phrase_rows}
        if phrase_paths:
            phrase_idf = math.log((total_docs + 1) / len(phrase_paths))
            candidate_paths |= phrase_paths

    max_possible = sum(idf.values()) + phrase_idf or 1.0

    # A small secondary tiebreaker for files that matched the exact same set
    # of words - common for single-word searches, where rarity alone can't
    # tell two matches apart. SQLite's own bm25() (term frequency, roughly)
    # only ever nudges the ranking within that tie; it never lets a file
    # jump ahead of one that matched a rarer word, which is what let a
    # single duplicated/verbose OCR pass outrank a genuinely better match
    # before this change.
    bm25_by_path: dict[str, float] = {}
    fts_query = _to_fts_query(query)
    if fts_query:
        try:
            bm_rows = conn.execute(
                "SELECT path, bm25(files_fts) AS rank FROM files_fts WHERE files_fts MATCH ? LIMIT ?",
                (fts_query, TEXT_FETCH_LIMIT),
            ).fetchall()
            bm25_by_path = {path: 1.0 / (1.0 + math.exp(rank)) for path, rank in bm_rows}
        except sqlite3.OperationalError:
            pass

    file_kinds = dict(conn.execute("SELECT path, kind FROM files").fetchall())
    filenames = dict(conn.execute("SELECT path, filename FROM files").fetchall())

    for path in candidate_paths:
        matched = [t for t in terms if path in term_paths.get(t, ())]
        is_phrase_match = path in phrase_paths
        if not matched and not is_phrase_match:
            continue
        idf_sum = sum(idf[t] for t in matched) + (phrase_idf if is_phrase_match else 0.0)
        tiebreak = bm25_by_path.get(path, 0.0)
        # idf_sum dominates (scaled into a whole fraction of max_possible);
        # the bm25 tiebreak is scaled small enough that it can only reorder
        # files within the same rarity tier, never cross into the next one.
        score = (idf_sum / max_possible) + (tiebreak / 1000.0)
        filename = filenames.get(path, path)
        match_type = "name" if query.lower() in filename.lower() else "content"
        # A filename match is exempted from the threshold below: the file
        # is *named* after (part of) what was searched, which is its own
        # strong, direct signal regardless of how the idf math shakes out -
        # unlike a coincidental single-word hit buried somewhere in a much
        # longer OCR'd/extracted text.
        if match_type != "name" and score < MIN_TEXT_MATCH_SCORE:
            continue
        existing = results.get(path)
        if not existing or score > existing["score"]:
            results[path] = SearchResult(
                path=path,
                filename=filename,
                kind=file_kinds.get(path, "other"),
                score=score,
                match_type=match_type,
                root=root,
            )


def _visual_search(
    conn: sqlite3.Connection, query: str, results: dict, root: str, strict: bool = False
) -> None:
    query_vec = embeddings.embed_text(query)
    if query_vec is None:
        return
    _visual_similarity_core(conn, query_vec, results, root, label=repr(query), strict=strict)


def _visual_similarity_core(
    conn: sqlite3.Connection,
    query_vec,
    results: dict,
    root: str,
    label: str,
    exclude_path: str = None,
    strict: bool = False,
) -> None:
    """Shared by _visual_search (a text-derived query vector, via CLIP's
    text encoder) and find_similar (an image-derived query vector - another
    file's own already-stored embedding). Same noise/threshold reasoning
    either way: what counts as "similar" depends on how spread out THIS
    query's own matches are against THIS library, not a single fixed line.
    """
    sql = """
        SELECT f.path, f.filename, f.kind, e.vector
        FROM embeddings e JOIN files f ON f.id = e.file_id
        """
    params: tuple = ()
    if exclude_path is not None:
        sql += " WHERE f.path != ?"
        params = (exclude_path,)
    rows = conn.execute(sql, params).fetchall()

    sims = [
        (path, filename, kind, embeddings.cosine_similarity(query_vec, db.blob_to_vector(blob)))
        for path, filename, kind, blob in rows
    ]

    # CLIP similarity scores are noisy in an absolute sense - the model's
    # embedding space isn't centered around zero, so even a nonsense query
    # against a totally unrelated image often lands well above 0, and a
    # flat cutoff alone (SEMANTIC_THRESHOLD) can let a whole folder of
    # unrelated screenshots through at once if the query just happens to
    # sit in a noisy part of that space (this is exactly what let "all
    # invoices of $20" - not a real picture description at all - pull in
    # dozens of unrelated test/screenshot images). Whatever the baseline
    # noise level is for THIS query against THIS library, a genuine visual
    # match should still stand out from it, not just clear a fixed line -
    # so the effective cutoff is also raised to the query's own mean +
    # 2 standard deviations, and only images clearing both that and the
    # absolute floor count as a match.
    strict_skip = False
    if len(sims) >= 8:
        values = [s for *_ignore, s in sims]
        mean = sum(values) / len(values)
        variance = sum((v - mean) ** 2 for v in values) / len(values)
        std = variance ** 0.5
        cutoff = max(SEMANTIC_THRESHOLD, mean + (STRICT_SIGMAS if strict else 2) * std)
        if strict and max(values) < mean + STRICT_MIN_TOP_SIGMAS * std:
            strict_skip = True
    else:
        cutoff = SEMANTIC_THRESHOLD

    # Printed (not logged - nothing here calls logging.basicConfig, so a
    # logging call would go nowhere) every time visual search actually
    # runs, so a bad ranking can be diagnosed from real numbers instead of
    # guessing - this is what exposed the "all invoices of $20"/"all
    # mountains" issues in the first place. Cheap and low-volume: visual
    # search itself only runs when text search found nothing (see
    # search_with_info), so this isn't printed on every keystroke.
    top = sorted(sims, key=lambda s: s[3], reverse=True)[:8]
    print(f"[visual search] query={label} cutoff={cutoff:.3f} top matches:", flush=True)
    for _path, filename, _kind, sim in top:
        mark = "PASS" if sim >= cutoff else "below cutoff"
        print(f"    {sim:.3f}  {mark:12s}  {filename}", flush=True)

    # "strict" = text search already found real answers, so visual matches
    # are only extras: best few that clear the higher bar.
    if strict_skip:
        candidates = []
    elif strict:
        candidates = sorted(sims, key=lambda s: s[3], reverse=True)[:STRICT_MAX_VISUAL]
    else:
        candidates = sims
    for path, filename, kind, sim in candidates:
        if sim < cutoff:
            continue
        existing = results.get(path)
        # Same blended comparison _rank uses at the end (score * trust
        # multiplier) - a text/name match already recorded for this file
        # only gets replaced by a visual one if CLIP is confident enough to
        # outweigh how much more that match type is normally trusted. This
        # is what lets a genuinely strong CLIP match still surface for a
        # file whose only "text match" was a thin coincidence (e.g. a query
        # word that only happened to appear in an unrelated file's OCR'd
        # text) - without this, that coincidental text hit would keep the
        # real visual signal from ever being recorded for that file at all.
        should_replace = (
            not existing
            or sim > existing["score"] * _MATCH_TRUST.get(existing["match_type"], 1.0)
        )
        if should_replace:
            results[path] = SearchResult(
                path=path, filename=filename, kind=kind, score=sim, match_type="visual", root=root
            )



def _text_similarity_search(
    conn: sqlite3.Connection,
    target_text: str,
    results: dict,
    root: str,
    exclude_path: str,
) -> None:
    """The text half of find_similar(): compares one file's own extracted
    text against every other file's, word-set against word-set, weighted
    by rarity (idf) exactly like _text_search weighs a typed query's words
    - a word both documents contain is worth more toward "these are
    related" the rarer that word is across the rest of this library, so
    two files that just happen to share a lot of common/boilerplate
    vocabulary don't look related only because of that. See
    SIMILAR_TEXT_THRESHOLD above for how that cutoff was calibrated."""
    target_words = _extract_content_words(target_text)
    if not target_words:
        return

    rows = conn.execute(
        """
        SELECT f.path, f.filename, f.kind, fts.content
        FROM files f JOIN files_fts fts ON fts.path = f.path
        WHERE f.path != ? AND fts.content IS NOT NULL
        LIMIT ?
        """,
        (exclude_path, SIMILAR_TEXT_FETCH_LIMIT),
    ).fetchall()

    doc_words: dict = {}
    file_info: dict = {}
    word_doc_count: dict = {}
    for path, filename, kind, content_text in rows:
        words = _extract_content_words(content_text)
        if not words:
            continue
        doc_words[path] = words
        file_info[path] = (filename, kind)
        for w in words:
            word_doc_count[w] = word_doc_count.get(w, 0) + 1

    if not doc_words:
        return

    total_docs = len(doc_words) + 1  # +1 counts the target file itself

    def idf(word: str) -> float:
        return math.log((total_docs + 1) / (word_doc_count.get(word, 0) + 1))

    for path, words in doc_words.items():
        shared = target_words & words
        if not shared:
            continue
        union = target_words | words
        weighted_union = sum(idf(w) for w in union)
        if weighted_union <= 0:
            continue
        score = sum(idf(w) for w in shared) / weighted_union
        if score < SIMILAR_TEXT_THRESHOLD:
            continue
        filename, kind = file_info[path]
        existing = results.get(path)
        if not existing or score > existing["score"]:
            results[path] = SearchResult(
                path=path, filename=filename, kind=kind, score=score, match_type="content", root=root,
            )


def _extract_content_words(text: Optional[str]) -> Set[str]:
    if not text:
        return set()
    return {w.lower() for w in _WORD_RE.findall(text)}


def _query_terms(query: str) -> List[str]:
    """The distinct, lowercased content words a search actually looks for -
    stopwords and very short words dropped, as they'd match almost every
    document and be worthless as a rarity signal (see _text_search)."""
    seen: List[str] = []
    for raw in query.split():
        t = raw.strip().lower()
        if not t or len(t) < MIN_TERM_LEN or t in STOPWORDS:
            continue
        if t not in seen:
            seen.append(t)
    return seen


def _to_fts_query(query: str) -> str:
    # Treat the query as OR'd prefix terms so partial words still match,
    # e.g. "bag" also matches "bags", "baggage", etc.
    terms = _query_terms(query)
    if not terms:
        return ""
    escaped = [f'"{t}"*' for t in terms]
    return " OR ".join(escaped)
