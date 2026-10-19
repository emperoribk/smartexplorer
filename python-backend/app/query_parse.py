"""Turns a loosely-phrased search query ("that ticket screenshot with the
World Cup match") into the real content terms to search for, plus any
filters implied by how the person phrased it (a file kind, a date range).

This runs entirely locally with a small, fixed set of rules - no model, no
network call, deliberately. It only needs to handle the shape of how people
actually phrase a file search ("the pdf from last week", "photos of the
ticket"), not open-ended natural language understanding, and a transparent,
predictable rule set is easier to trust and to fix than an opaque one -
every filter it applies can be explained in one short label shown back in
the UI (see search.py/main.py), rather than being a black box that quietly
changes what shows up.
"""
from __future__ import annotations

import calendar
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Callable, Optional

# Words that name a *kind* of file rather than describing its content -
# "that ticket screenshot" means "look for 'ticket', and only among images",
# not "look for the literal word 'screenshot'" (almost no image's filename
# or OCR text actually contains that word). Maps to the same kind strings
# indexer.py/search.py already use ('text' covers documents/PDFs, matching
# how they're classified server-side today).
_KIND_WORDS = {
    "screenshot": "image", "screenshots": "image", "photo": "image", "photos": "image",
    "picture": "image", "pictures": "image", "pic": "image", "pics": "image",
    "image": "image", "images": "image", "jpg": "image", "jpeg": "image", "png": "image",
    "video": "video", "videos": "video", "clip": "video", "clips": "video",
    "movie": "video", "movies": "video", "mp4": "video",
    "pdf": "text", "pdfs": "text", "document": "text", "documents": "text",
    "doc": "text", "docs": "text", "spreadsheet": "text", "spreadsheets": "text",
}
_KIND_LABELS = {"image": "photos/screenshots", "video": "videos", "text": "documents"}

# Conversational scaffolding that carries no search meaning on its own -
# stripped so it never becomes a literal required term ("that" or "with"
# almost never appear in a filename or a photo's OCR text). Deliberately
# separate from search.py's STOPWORDS, which serves a different job
# (keeping short/common words from swamping FTS relevance) - this list is
# about recognizing natural phrasing, not query mechanics.
_FILLER_WORDS = {
    "that", "this", "these", "those", "the", "a", "an", "with", "which",
    "showing", "shows", "show", "has", "have", "having", "containing",
    "contains", "about", "regarding", "one", "some", "any", "all", "every",
    "each", "find", "search",
    "for", "me", "my", "i", "of", "is", "was", "were", "there", "here", "file",
    "files", "from", "in", "on", "at", "mention", "mentions", "mentioning",
}

_MONTHS: dict[str, int] = {name.lower(): i for i, name in enumerate(calendar.month_name) if name}
_MONTHS.update({name.lower(): i for i, name in enumerate(calendar.month_abbr) if name})
# "May" the month and "may" the modal verb are the same word - a query like
# "documents that may need signing" shouldn't get quietly scoped to May.
# Every other month name/abbreviation is unambiguous enough in file-search
# phrasing to leave in.
_MONTHS.pop("may", None)

_YEAR_RE = re.compile(r"\b(19|20)\d{2}\b")


@dataclass
class ParsedQuery:
    content_query: str
    kind_filter: Optional[str] = None  # 'image' | 'video' | 'text'
    date_from: Optional[float] = None
    date_to: Optional[float] = None
    # Human-readable notes on what was detected, e.g. ["photos/screenshots",
    # "last week"] - surfaced in the UI so filtering is never silent.
    filter_labels: list = field(default_factory=list)


def _month_range(year: int, month: int) -> tuple[float, float]:
    start = datetime(year, month, 1)
    last_day = calendar.monthrange(year, month)[1]
    end = datetime(year, month, last_day, 23, 59, 59)
    return start.timestamp(), end.timestamp()


def _day_range(d: datetime) -> tuple[float, float]:
    start = d.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1) - timedelta(seconds=1)
    return start.timestamp(), end.timestamp()


def _week_range(offset_weeks: int, now: datetime) -> tuple[float, float]:
    monday = (now - timedelta(days=now.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0
    ) + timedelta(weeks=offset_weeks)
    sunday_end = monday + timedelta(days=7) - timedelta(seconds=1)
    return monday.timestamp(), sunday_end.timestamp()


def _prev_month(now: datetime) -> tuple[int, int]:
    if now.month == 1:
        return now.year - 1, 12
    return now.year, now.month - 1


# Season names, mapped to the calendar month each one starts in (Northern
# hemisphere convention - the common default, and the one this app's own
# test/example content assumes). Each season spans that month plus the
# next two; winter's window crosses the new year (Dec-Feb), which
# _season_window below accounts for directly rather than treating as a
# special case.
_SEASON_ANCHOR = {
    "winter": 12, "spring": 3, "summer": 6, "fall": 9, "autumn": 9,
}


def _season_window(anchor_month: int, start_year: int) -> tuple[datetime, datetime]:
    end_month = anchor_month + 3
    end_year = start_year
    if end_month > 12:
        end_month -= 12
        end_year += 1
    start = datetime(start_year, anchor_month, 1)
    end = datetime(end_year, end_month, 1) - timedelta(seconds=1)
    return start, end


def _season_range(season: str, qualifier: Optional[str], now: datetime) -> tuple[float, float]:
    """`qualifier` is 'last', 'this', or None (a bare season name, e.g. just
    "winter" with no "last"/"this" - treated the same as "this", mirroring
    how a bare month name defaults to the nearest occurrence below).

    Unlike a calendar month, "this winter" said in September doesn't mean
    a window containing today - it means the nearest winter, same as "this
    Christmas" said in October. So: 'this'/bare picks whichever window
    contains `now`, or failing that the nearest upcoming one; 'last' picks
    the most recently *completed* window instead, which is the whole point
    of the word "last" (an ongoing season doesn't count as already past)."""
    anchor_month = _SEASON_ANCHOR[season]
    windows = [_season_window(anchor_month, y) for y in range(now.year - 3, now.year + 2)]

    if qualifier == "last":
        completed = [w for w in windows if w[1] < now]
        chosen = completed[-1] if completed else windows[0]
    else:
        containing = [w for w in windows if w[0] <= now <= w[1]]
        if containing:
            chosen = containing[0]
        else:
            upcoming = [w for w in windows if w[0] > now]
            chosen = upcoming[0] if upcoming else windows[-1]

    return chosen[0].timestamp(), chosen[1].timestamp()


def _detect_date(text: str, now: datetime) -> tuple[Optional[float], Optional[float], Optional[str], str]:
    """Looks for one date phrase in `text`. Returns (from, to, label,
    remaining_text_with_the_phrase_removed). Only ever matches the first
    phrase it finds - a query naming two different dates is rare enough
    not to be worth the ambiguity of trying to combine them."""
    lowered = text.lower()

    # Deliberately requires "last"/"this" (never a bare season word alone):
    # "fall" and "spring" are ordinary English verbs ("before I fall
    # asleep"), so treating them as a date filter on their own would
    # misfire constantly. Every other relative phrase this function
    # recognizes is qualified the same way (never bare "week" or "month"
    # either) - this keeps season words consistent with that.
    season_match = re.search(r"\b(last|this)\s+(winter|spring|summer|fall|autumn)\b", lowered)
    if season_match:
        qualifier, season = season_match.group(1), season_match.group(2)
        start, end = _season_range(season, qualifier, now)
        label = f"{qualifier} {season}"
        remaining = lowered[: season_match.start()] + " " + lowered[season_match.end() :]
        return start, end, label, remaining

    relative_phrases: list[tuple[str, Callable[[], tuple[float, float]]]] = [
        ("yesterday", lambda: _day_range(now - timedelta(days=1))),
        ("today", lambda: _day_range(now)),
        ("last week", lambda: _week_range(-1, now)),
        ("this week", lambda: _week_range(0, now)),
        ("last month", lambda: _month_range(*_prev_month(now))),
        ("this month", lambda: _month_range(now.year, now.month)),
    ]
    for phrase, fn in relative_phrases:
        if phrase in lowered:
            start, end = fn()
            remaining = re.sub(re.escape(phrase), " ", lowered, flags=re.IGNORECASE)
            return start, end, phrase, remaining

    # "<month>[ <year>]" e.g. "june", "june 2026"
    for name, month_num in _MONTHS.items():
        pattern = rf"\b{re.escape(name)}\b(?:\s+((?:19|20)\d{{2}}))?"
        m = re.search(pattern, lowered)
        if m:
            year = int(m.group(1)) if m.group(1) else now.year
            start, end = _month_range(year, month_num)
            remaining = lowered[: m.start()] + " " + lowered[m.end() :]
            label = f"{calendar.month_name[month_num]} {year}"
            return start, end, label, remaining

    # A bare year ("2026") with nothing else date-like already matched.
    m = _YEAR_RE.search(lowered)
    if m:
        year = int(m.group())
        start = _month_range(year, 1)[0]
        end = _month_range(year, 12)[1]
        remaining = lowered[: m.start()] + " " + lowered[m.end() :]
        return start, end, str(year), remaining

    return None, None, None, text


def parse(raw_query: str, now: Optional[datetime] = None) -> ParsedQuery:
    now = now or datetime.now()

    date_from, date_to, date_label, text = _detect_date(raw_query, now)

    kind_filter = None
    kind_label = None
    kept: list[str] = []
    for tok in re.findall(r"\S+", text):
        bare = re.sub(r"[^\w]", "", tok).lower()
        if not bare:
            continue
        if kind_filter is None and bare in _KIND_WORDS:
            kind_filter = _KIND_WORDS[bare]
            kind_label = _KIND_LABELS[kind_filter]
            continue
        if bare in _FILLER_WORDS:
            continue
        kept.append(tok)

    content_query = " ".join(kept).strip()

    labels = []
    if kind_label:
        labels.append(kind_label)
    if date_label:
        labels.append(date_label)

    # An empty content_query is fine, even intended, when a kind/date filter
    # was found - "photos from last week" legitimately has no other content
    # term; it means "list matching files", not "search for nothing" (see
    # search.py's _browse_by_filter). Only fall back to the original raw
    # text when NOTHING was understood at all - no filter and no content -
    # since searching literally nothing would otherwise match every file
    # indiscriminately via FTS's OR-of-terms, which isn't the intent.
    if not content_query and kind_filter is None and date_from is None and date_to is None:
        content_query = raw_query.strip()

    return ParsedQuery(
        content_query=content_query,
        kind_filter=kind_filter,
        date_from=date_from,
        date_to=date_to,
        filter_labels=labels,
    )
