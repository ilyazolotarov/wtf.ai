"""Opening hours of places to stop at (STOPS-SPEC §6.1): the common part of OSM's `opening_hours`, as the minutes of
a week a place is open.

Read: rules separated by ";" (a later one replaces the days it names) or by "," before a weekday (adds to them);
each rule's weekdays (Mo–Su, ranges such as Mo-Fr or Fr-Mo, lists, any case; PH dropped, a rule of PH alone
skipped; none: every day) and its times (H:MM-H:MM, a list; past midnight into the next day; equal ends: the whole
day; a trailing "+" read as the end given), or off / closed, or nothing (the whole day). Days no rule names are
closed, once a rule opens some day: a value that only closes some days ("Su off", "PH off") says nothing of the
others and is unknown, while "off" or "closed" alone is closed always. "24/7" is the whole week. Anything else (months, dates, weeks, sunrise, comments, open ends without a time)
makes the value unknown: the app says nothing rather than something wrong.
"""

import re

DAY_MIN = 24 * 60
WEEK_MIN = 7 * DAY_MIN
DAYS = ("mo", "tu", "we", "th", "fr", "sa", "su")

_DAY = r"(?:mo|tu|we|th|fr|sa|su|ph)"
_SELECTOR = re.compile(rf"^\s*({_DAY}(?:\s*-\s*{_DAY})?(?:\s*,\s*{_DAY}(?:\s*-\s*{_DAY})?)*)(?![a-z])\s*:?\s*(.*)$", re.I)
# "," starting another rule: after a time, "+", off or closed, before a weekday.
_ADDITIONAL = re.compile(rf"(?:(?<=[0-9+])|(?<=off)|(?<=closed))\s*,\s*(?={_DAY}(?![a-z]))", re.I)
_TIME = re.compile(r"^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\+?$")

Hours = tuple[tuple[int, int], ...]


def _days(selector: str) -> list[int] | None:
    """The weekdays (0 = Monday) a selector names, PH dropped; None when it names nothing else."""
    days: list[int] = []
    for item in selector.lower().split(","):
        ends = [e.strip() for e in item.split("-")]
        if "ph" in ends:
            if len(ends) > 1:
                raise ValueError(item)
            continue
        a = DAYS.index(ends[0])
        b = DAYS.index(ends[-1])
        days += [(a + k) % 7 for k in range((b - a) % 7 + 1)]
    return days or None


def _times(text: str) -> list[tuple[int, int]] | None:
    """A rule's times as [start, end) minutes of its day (the end past 1440 into the next); None: off."""
    t = text.strip().lower()
    if t in ("off", "closed"):
        return None
    if not t:
        return [(0, DAY_MIN)]
    out = []
    for part in t.split(","):
        m = _TIME.match(part.strip())
        if not m:
            raise ValueError(part)
        start = int(m[1]) * 60 + int(m[2])
        end = int(m[3]) * 60 + int(m[4])
        if start >= DAY_MIN or end > 2 * DAY_MIN or int(m[2]) >= 60 or int(m[4]) >= 60:
            raise ValueError(part)
        if end <= start and end <= DAY_MIN:
            end += DAY_MIN
        out.append((start, end))
    return out


def week_hours(value: str | None) -> Hours | None:
    """The minutes of the week open (Monday 00:00 = 0), as sorted, separate [start, end) ranges; () when always
    closed; None when the value is missing or says something this reader doesn't know."""
    v = (value or "").strip()
    if not v:
        return None
    if v.lower() == "24/7":
        return ((0, WEEK_MIN),)
    day: list[list[tuple[int, int]] | None] = [None] * 7
    try:
        for rule in v.split(";"):
            if not rule.strip():
                continue
            for k, part in enumerate(_ADDITIONAL.split(rule)):
                if part.strip().lower() == "24/7":
                    day = [[(0, DAY_MIN)] for _ in range(7)]
                    continue
                m = _SELECTOR.match(part)
                days, rest = (_days(m[1]), m[2]) if m else (list(range(7)), part)
                if days is None:
                    continue
                times = _times(rest)
                for d in days:
                    # A rule after ";" replaces the day's times; one after "," adds to them.
                    day[d] = [] if times is None else ([*(day[d] or []), *times] if k else list(times))
    except ValueError:
        return None
    if not any(day) and None in day:
        return None
    ranges = sorted((d * DAY_MIN + s, d * DAY_MIN + e) for d in range(7) for s, e in day[d] or [])
    week: list[tuple[int, int]] = []
    for s, e in ranges:
        # Sunday night into Monday: the week wraps.
        for a, b in ((s, min(e, WEEK_MIN)), (0, e - WEEK_MIN)) if e > WEEK_MIN else ((s, e),):
            week.append((a, b))
    week.sort()
    merged: list[tuple[int, int]] = []
    for s, e in week:
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return tuple(merged)
