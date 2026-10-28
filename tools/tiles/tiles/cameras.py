"""Speed cameras (UI-SPEC §6.5): cameras.json, one shared file for all of Ukraine.

Every OSM speed camera (`highway=speed_camera` nodes, the devices of `enforcement=maxspeed` relations) and every camera
on the Interior Ministry's list (MVS, mvs.gov.ua: the cameras in service, each a road and km or a town address, the
direction of travel and the limit). OSM mappers copy the list into camera names (`ККШ "М-06 46+050"`), so a row whose
road and km, or street and house, an OSM camera's name carries is that camera, and gives it its limit. A row that no
OSM camera carries is placed from OSM: a town address on its house, snapped onto its street; a crossing at the
streets' shared node; a road km on the road's main path, calibrated on the same road's named cameras on either side.
An OSM camera the list lacks stays (switched off, or added since): a needless warning costs less than a missed one.

The direction a camera checks is the bearing of the traffic it photographs:
- `direction=forward|backward` along the way it is on (forward on one-way roads 129 times of 129, 2026-10);
- on a one-way road, the road's;
- an `enforcement` relation's `from` → device;
- a road row's "у напрямку X": away from X along the road's main path. The list names where the camera looks, at the
  traffic coming towards it (on one-way carriageways the traffic goes away from X 43 times of 51, and OSM's
  `forward`/`backward` disagree with "towards X" 110 times of 125, 2026-10).
Numeric `direction` values are left out: mappers give the camera's view (17 of 22 on one-way roads, 2026-10) or the
traffic's. Without one, the camera checks both ways.

The page is read at build time and used only in the shape the list has (`check_list`): every row readable (a road's
index, km and limit; a town row's address and limit; odd rows past 5 % of a kind reject the page), at least 50 road
and 50 town rows in 10 towns, and as many of each as the committed copy holds give or take (70–200 %). Otherwise
(unreachable, blocked, a new layout) the committed copy of its tables is used (`cameras/mvs.json`; `tiles mvs`
refreshes it, with the same checks). Either way the build goes on, OSM's cameras whole; what went wrong, and a copy
over 60 days old, is a warning in the log, in GitHub's job summary and in the file (`mvs.warnings`).

    cameras.json  {"format": 1, "osm_date", "mvs": {"rows", "source", "warnings"?},
                   "cameras": [[lat, lon, bearing, limit, flags], …]}
        bearing  degrees clockwise from north of the traffic checked; -1: both ways
        limit    km/h at the camera; 0: none given (the app takes the road's)
        flags    1: in OSM, 2: on the MVS list
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import date
from heapq import heappop, heappush
from html.parser import HTMLParser
from pathlib import Path

import numpy as np
import osmium
import shapely

from .graph import ONEWAY_BACKWARD, ONEWAY_FORWARD, read_locations, road_attrs

ROOT = Path(__file__).resolve().parent.parent
SNAPSHOT = ROOT / "cameras" / "mvs.json"
MVS_URL = (
    "https://mvs.gov.ua/katalog-poslug/servisi-ta-poslugi-organiv-sistemi-vnutrisnix-sprav/"
    "avtofotovideofiksaciia-porusen-pdr/adresi-kamer-fotovideofiksaciyi-ta-dozvolena-svidkist-ruxu"
)
USER_AGENT = "Mozilla/5.0 (wtf.ai-tiles/0.1)"
FORMAT = 1
IN_OSM, ON_LIST = 1, 2
EARTH_R = 6_371_008.8

# The list's shape (`check_list`; 228 road rows, 197 town rows in 35 towns on 2026-10-28): fewer is a page that changed
# its layout, not the list.
FLOOR = {"road": 50, "city": 50, "towns": 10}
# Unreadable rows of a kind past this share reject the page: its columns moved.
MAX_ODD_SHARE = 0.05
# The page's counts against the committed copy's: outside, the page is set aside until someone looks (`tiles mvs`).
COPY_RANGE = (0.7, 2.0)
# A copy older than this, used, is a warning: refresh it.
COPY_STALE_DAYS = 60
ROAD_INDEX = re.compile(r"^[МНРТ]-\d{2}(?:-\d{2})*$")
# OSM name of a list camera: the same km (to the metre, written to 3 decimals).
SAME_KM = 0.0015
# Town rows: the town's place point within this, m (big cities wider).
TOWN_RADIUS_M = 12_000
TOWN_RADIUS = {"Київ": 25_000, "Дніпро": 20_000, "Одеса": 20_000, "Львів": 15_000, "Кривий Ріг": 25_000, "Харків": 20_000}
# Road km placed only this close (km of road) to a named camera of the same road: the error grows with the gap
# (named cameras placed as if unnamed, 2026-10: within 5 km median 15 m, 90 % within 110 m; 5–10 km median 41 m,
# 90 % within 400 m; past 30 km median 250 m).
ROAD_KM_MAX_GAP = 10.0
# A list row placed this close to an OSM camera no row names is that camera, m.
MERGE_M = 150.0
# Ways of a road's main path; links and service roads would short-cut it.
MAIN_ROADS = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential"}
# A list row's direction (away from its "у напрямку X") needs X this far along the road from the camera, m.
TOWARD_MIN_M = 1000.0
# Directions within this of each other are one; farther apart (two rows, both ways), the camera checks both.
SAME_DIRECTION_DEG = 60.0
PLACE_RANK = {"city": 0, "town": 1, "village": 2, "suburb": 3, "hamlet": 4}


def log(msg: str) -> None:
    print(f"[cameras] {msg}", file=sys.stderr, flush=True)


# --- The MVS list -------------------------------------------------------------------------


class _Tables(HTMLParser):
    """Every table of the page: its rows' cell texts, and the text just before it (a town table's heading)."""

    def __init__(self) -> None:
        super().__init__()
        self.tables: list[dict] = []
        self.row: list[str] | None = None
        self.cell: list[str] = []
        self.in_cell = False
        self.depth = 0
        self.text: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.depth += 1
            self.tables.append({"before": " ".join(self.text), "rows": []})
            self.text = []
        elif tag == "tr" and self.depth:
            self.row = []
        elif tag in ("td", "th") and self.depth:
            self.in_cell, self.cell = True, []
        elif tag in ("br", "p") and self.in_cell:
            self.cell.append(" | ")

    def handle_endtag(self, tag):
        if tag == "table":
            self.depth -= 1
        elif tag in ("td", "th") and self.in_cell and self.row is not None:
            self.in_cell = False
            text = re.sub(r"\s+", " ", "".join(self.cell).replace("\xa0", " "))
            self.row.append(re.sub(r"(\s*\|\s*)+", " | ", text).strip(" |"))
        elif tag == "tr" and self.row is not None and self.tables:
            self.tables[-1]["rows"].append(self.row)
            self.row = None

    def handle_data(self, data):
        if self.in_cell:
            self.cell.append(data)
        elif not self.depth and data.strip():
            self.text.append(data.strip())


def page_tables(html: str) -> dict:
    """The page's tables as text: national roads' rows (index, name, km, limit) and each town's (place, limit)."""
    p = _Tables()
    p.feed(html)
    roads: list[list[str]] = []
    towns: list[list] = []
    for t in p.tables:
        if not t["rows"]:
            continue
        header, *body = t["rows"]
        body = [row for row in body if any(row)]
        if len(header) == 4:
            roads += body
            continue
        town = re.search(r"у межах\s+(?:м\.|с\.|смт\.?)\s*(.+)$", t["before"])
        if town:
            towns.append([town[1].strip(), body])
    return {"roads": roads, "towns": towns}


def mvs_limits(text: str) -> list[int]:
    """Every km/h value of a limit cell ('50 км/год70 км/год' → [50, 70])."""
    return [int(v) for v in re.findall(r"(\d+)\s*км", text)]


def km_value(text: str) -> float | None:
    """'113+864' → 113.864 km; None when unreadable."""
    m = re.fullmatch(r"(\d+)\s*\+\s*(\d{1,3})", text.strip())
    return int(m[1]) + int(m[2].ljust(3, "0")) / 1000 if m else None


def norm_ref(ref: str) -> str:
    """A road's index as OSM writes it: Cyrillic letter, hyphens ('M-01', 'М01' → 'М-01')."""
    ref = ref.strip().upper().translate(str.maketrans("MHPTEABCOKX", "МНРТЕАВСОКХ"))
    ref = re.sub(r"\s+", "", ref)
    m = re.fullmatch(r"([МНРТ])-?(\d+)(?:-?(\d+))?(?:-?(\d+))?", ref)
    return "-".join(p for p in m.groups() if p) if m else ref


def _parens(text: str) -> tuple[str, list[str]]:
    return re.sub(r"\([^()]*\)", " ", text), re.findall(r"\(([^()]*)\)", text)


AIMED = r",?\s*напрямок спрямування приладу\s+(.+)$"
TOWARD = r"^\s*(?:у|в)\s+напрямку\s*"


def parse_road(row: list[str]) -> dict:
    ref, name, place, limit = row[:4]
    head, groups = _parens(name)
    toward = next((g for g in groups if re.search(r"напрям", g)), None)
    m = re.search(AIMED, head)
    if m:
        head, toward = head[: m.start()], m[1]
    return {
        "kind": "road", "ref": norm_ref(ref), "road_name": head.strip(),
        "toward": re.sub(TOWARD, "", toward).strip() if toward else None,
        "km": km_value(place), "limits": mvs_limits(limit), "raw": row,
    }


def parse_city(city: str, row: list[str]) -> dict:
    loc, limit = row[0].replace(" | ", " "), row[1] if len(row) > 1 else ""
    m = re.search(AIMED, loc)
    aimed = m[1].strip() if m else None
    if m:
        loc = loc[: m.start()]
    head, groups = _parens(loc)
    rec = {"kind": "city", "city": city, "street": None, "house": None, "near": None, "crossing": None,
           "toward": None, "limits": mvs_limits(limit), "raw": row}
    for g in (g.strip() for g in groups):
        if re.match(r"(?:у|в)\s+напрямку", g):
            rec["toward"] = re.sub(TOWARD, "", g).split(",")[0].strip()
        elif g.startswith("біля"):
            rec["near"] = g[4:].strip()
    tail = re.split(r"\s*(?=за умови)", re.sub(r"\s+", " ", head).strip(" ,"), maxsplit=1)[0].strip(" ,")
    if aimed:
        rec["toward"] = aimed
    m = re.match(r"(?i)^(?:перехр(?:естя)?\.?|перех\.)\s*(.+)$", tail)
    if m:
        body = re.sub(r"\s+(?:та|і)\s+(?:вулиці\s+)?", " - ", m[1])
        rec["crossing"] = [s.strip(" ,") for s in re.split(r"\s*[-–—]\s*", body) if s.strip(" ,")]
    elif re.search(r"\D\s*/", tail):
        rec["crossing"] = [s.strip(" ,") for s in tail.split("/")]
    else:
        m = re.match(r"^(.*?),?\s*(\d+[\w/-]*(?:,\s*корп\.\s*\d+)?)$", tail)
        if m and m[1]:
            rec["street"], rec["house"] = m[1].strip(" ,"), m[2]
        else:
            rec["street"] = tail
    return rec


def parse_tables(tables: Mapping) -> list[dict]:
    rows = [parse_road(r) for r in tables["roads"] if len(r) >= 4]
    for town, body in tables["towns"]:
        rows += [parse_city(town, r) for r in body]
    return rows


def fetch_page(timeout: float = 60) -> str:
    req = urllib.request.Request(MVS_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read().decode("utf-8")


def write_snapshot(tables: Mapping, path: Path = SNAPSHOT, day: str | None = None) -> None:
    """The page's tables, one row a line (a new list is a readable diff)."""
    lines = [f'{{"url": {json.dumps(MVS_URL)}, "date": "{day or date.today().isoformat()}",', ' "roads": [']
    lines.append(",\n".join("  " + json.dumps(r, ensure_ascii=False) for r in tables["roads"]))
    lines.append(' ],\n "towns": [')
    lines.append(",\n".join(
        f"  [{json.dumps(town, ensure_ascii=False)}, [\n" + ",\n".join("   " + json.dumps(r, ensure_ascii=False) for r in body) + "\n  ]]"
        for town, body in tables["towns"]
    ))
    lines.append(" ]\n}\n")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8", newline="\n")


def row_problem(row: Mapping) -> str | None:
    """What makes a row unreadable: no limit (or one no road has), a road without its index or km, a town row without
    an address; None for a good one."""
    limits = row["limits"]
    if not limits or any(not 5 <= v <= 130 for v in limits):
        return "limit"
    if row["kind"] == "road":
        if not ROAD_INDEX.match(row["ref"]):
            return "road index"
        if row["km"] is None or not 0 <= row["km"] < 2000:
            return "km"
    elif not (row["street"] or row["crossing"]):
        return "address"
    return None


@dataclass
class ListCheck:
    rows: list[dict]
    """The readable rows."""
    odd: list[dict]
    """The unreadable rows, left out."""
    problems: list[str]
    """Why the list isn't in the list's shape; empty: it is."""


def counts(rows: Iterable[Mapping]) -> dict[str, int]:
    rows = list(rows)
    return {
        "road": sum(r["kind"] == "road" for r in rows),
        "city": sum(r["kind"] == "city" for r in rows),
        "towns": len({r["city"] for r in rows if r["kind"] == "city"}),
    }


KIND = {"road": "road rows", "city": "town rows", "towns": "towns"}


def check_list(rows: list[dict], copy: list[dict] | None = None) -> ListCheck:
    """The rows in the list's shape (`FLOOR`, `MAX_ODD_SHARE`), and as many as the committed copy's (`COPY_RANGE`)."""
    good = [r for r in rows if row_problem(r) is None]
    odd = [r for r in rows if row_problem(r) is not None]
    have, odd_by_kind = counts(rows), counts(odd)
    problems = [f"{have[k]} {KIND[k]}, fewer than {FLOOR[k]}" for k in FLOOR if have[k] < FLOOR[k]]
    for k in ("road", "city"):
        if have[k] and odd_by_kind[k] > MAX_ODD_SHARE * have[k]:
            problems.append(f"{odd_by_kind[k]} of {have[k]} {KIND[k]} unreadable")
    if copy:
        ref = counts(copy)
        lo, hi = COPY_RANGE
        problems += [
            f"{have[k]} {KIND[k]} against the copy's {ref[k]}" for k in ref if ref[k] and not lo <= have[k] / ref[k] <= hi
        ]
    return ListCheck(good, odd, problems)


def odd_note(odd: list[dict]) -> str:
    shown = "; ".join(" | ".join(r["raw"])[:80] for r in odd[:3])
    return f"{len(odd)} unreadable rows left out: {shown}{' …' if len(odd) > 3 else ''}"


@dataclass
class MvsList:
    rows: list[dict]
    source: str
    """"mvs.gov.ua <date>", or "copy of <date>"."""
    warnings: list[str]


def mvs_rows(snapshot: Path = SNAPSHOT, fetch=fetch_page, today: date | None = None) -> MvsList:
    """The list's rows: the page now when it is in the list's shape, else the committed copy; and what went wrong."""
    today = today or date.today()
    snap = json.loads(snapshot.read_text(encoding="utf-8"))
    copy = check_list(parse_tables(snap))
    warnings: list[str] = []
    try:
        page = check_list(parse_tables(page_tables(fetch())), copy.rows)
        if not page.problems:
            return MvsList(page.rows, f"mvs.gov.ua {today.isoformat()}", [odd_note(page.odd)] if page.odd else [])
        warnings.append(f"the MVS page was set aside (its layout changed?): {'; '.join(page.problems)}")
    except (urllib.error.URLError, TimeoutError, OSError, UnicodeDecodeError) as e:
        warnings.append(f"the MVS page could not be read: {e}")
    age = (today - date.fromisoformat(snap["date"])).days
    if age > COPY_STALE_DAYS:
        warnings.append(f"the committed copy of the list is {age} days old: refresh it (`tiles mvs`)")
    if copy.odd:
        warnings.append(odd_note(copy.odd))
    return MvsList(copy.rows, f"copy of {snap['date']}", warnings)


def refresh_snapshot(force: bool = False, path: Path = SNAPSHOT, fetch=fetch_page) -> tuple[bool, list[str]]:
    """`tiles mvs`: the page's tables into the committed copy, when they pass the build's checks against the copy there
    (or `force`: a list that really changed that much). Whether it was written, and what the checks found."""
    tables = page_tables(fetch())
    old = parse_tables(json.loads(path.read_text(encoding="utf-8"))) if path.exists() else None
    check = check_list(parse_tables(tables), old)
    notes = check.problems + ([odd_note(check.odd)] if check.odd else [])
    written = not check.problems or force
    if written:
        write_snapshot(tables, path)
    return written, notes


def report(warnings: list[str], summary: str) -> None:
    """Into the log; on GitHub Actions also as warnings and into the job summary."""
    for w in warnings:
        log(f"warning: {w}")
    if os.environ.get("GITHUB_ACTIONS") == "true":
        for w in warnings:
            print(f"::warning title=Speed cameras (MVS list)::{w}", flush=True)
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        lines = [f"### Speed cameras\n\n{summary}\n"] + [f"- ⚠️ {w}" for w in warnings]
        with open(path, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n\n")


# --- Names ----------------------------------------------------------------------------------

APOS = str.maketrans({"’": "'", "ʼ": "'", "`": "'", "‘": "'", "´": "'", "ʹ": "'"})
LATIN = str.maketrans("aceiopxyk", "асеіорхук")
STREET_TYPES = {
    "вул", "вулиця", "вулиці", "просп", "проспект", "пр", "пр-т", "пр-кт", "бульв", "бульвар", "б-р", "пл", "площа",
    "площі", "пров", "провулок", "шосе", "узвіз", "майдан", "м", "міст", "мосту", "спуск", "тупик", "проїзд",
}


def street_key(name: str | None) -> str:
    """'просп. Князя Володимира' and 'проспект Князя Володимира' → 'володимира князя'."""
    s = (name or "").lower().translate(APOS).translate(LATIN)
    s = re.sub(r"(?<=[^\W\d])\.(?=\S)", ". ", s)
    words = [w.strip(".,'\"") for w in re.split(r"[\s,]+", s)]
    words = [w for w in words if w and w not in STREET_TYPES and w.rstrip(".") not in STREET_TYPES]
    words = [w for w in words if not re.fullmatch(r"\w\.?", w) or w.isdigit()]  # initials
    return " ".join(sorted(words))


def house_key(house: str) -> str:
    """'38-А' → '38а', '8/1' stays, '12, корп. 2' → '12к2'."""
    h = house.lower().translate(LATIN)
    h = re.sub(r",?\s*корп(?:ус)?\.?\s*", "к", h)
    return re.sub(r"[\s\-]", "", h)


def same_street(a: str, b: str) -> bool:
    """Equal keys, or one's words within the other's (a short 'Чорновола' and the full name)."""
    if not a or not b:
        return False
    if a == b:
        return True
    sa, sb = set(a.split()), set(b.split())
    small, big = (sa, sb) if len(sa) <= len(sb) else (sb, sa)
    return small <= big and max(map(len, small)) >= 5


def place_name(text: str) -> str:
    """'м. Київ', 'смт. Ворзель', 'с.Барвінок' → the place's name."""
    return re.sub(r"^(?:смт|с-ще|сел|м|с)\.?\s*", "", text.strip()).strip()


# --- Geometry -------------------------------------------------------------------------------


def bearing_deg(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Initial bearing from a to b (lat, lon), degrees clockwise from north."""
    la1, lo1, la2, lo2 = map(math.radians, (*a, *b))
    y = math.sin(lo2 - lo1) * math.cos(la2)
    x = math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(lo2 - lo1)
    return math.degrees(math.atan2(y, x)) % 360


def dist_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat0 = math.radians((a[0] + b[0]) / 2)
    dx = math.radians(b[1] - a[1]) * math.cos(lat0)
    dy = math.radians(b[0] - a[0])
    return EARTH_R * math.hypot(dx, dy)


def angle_diff(a: float, b: float) -> float:
    return abs((a - b + 180) % 360 - 180)


class Plane:
    """A local plane around `lat0`, m."""

    def __init__(self, lat0: float):
        self.k = math.cos(math.radians(lat0))

    def xy(self, lat: float, lon: float) -> np.ndarray:
        return np.array([math.radians(lon) * EARTH_R * self.k, math.radians(lat) * EARTH_R])

    def ll(self, p: np.ndarray) -> tuple[float, float]:
        return math.degrees(p[1] / EARTH_R), math.degrees(p[0] / (EARTH_R * self.k))


@dataclass
class RoadLine:
    """A road as one polyline in a plane: points and chainage (m along it) at each."""

    plane: Plane
    q: np.ndarray
    cum: np.ndarray

    def project(self, lat: float, lon: float) -> tuple[float, float]:
        """Chainage of the nearest point and the distance to it, m."""
        p = self.plane.xy(lat, lon)
        a, b = self.q[:-1], self.q[1:]
        ab = b - a
        t = np.clip(((p - a) * ab).sum(1) / np.maximum((ab ** 2).sum(1), 1e-9), 0, 1)
        d = np.hypot(*(a + t[:, None] * ab - p).T)
        k = int(np.argmin(d))
        return float(self.cum[k] + t[k] * (self.cum[k + 1] - self.cum[k])), float(d[k])

    def at(self, ch: float) -> tuple[float, float]:
        ch = min(max(ch, 0.0), float(self.cum[-1]))
        k = min(int(np.searchsorted(self.cum, ch, side="right") - 1), len(self.q) - 2)
        t = (ch - self.cum[k]) / max(self.cum[k + 1] - self.cum[k], 1e-9)
        return self.plane.ll(self.q[k] + t * (self.q[k + 1] - self.q[k]))

    def heading(self, ch: float, forward: bool) -> float:
        """Bearing of the path at `ch`, the way of growing chainage or against it."""
        a, b = self.at(ch - 20), self.at(ch + 20)
        return bearing_deg(a, b) if forward else bearing_deg(b, a)


def _dijkstra(adj: Mapping[int, list[tuple[int, float]]], src: int, n: int) -> tuple[np.ndarray, np.ndarray]:
    d, prev = np.full(n, np.inf), np.full(n, -1)
    d[src] = 0
    pq = [(0.0, src)]
    while pq:
        du, u = heappop(pq)
        if du > d[u]:
            continue
        for v, w in adj[u]:
            if du + w < d[v]:
                d[v], prev[v] = du + w, u
                heappush(pq, (d[v], v))
    return d, prev


def main_path(ways: Iterable[OsmWay], bridge_m: float = 10_000) -> RoadLine | None:
    """A road as one polyline: the longest shortest path through its ways, gaps between pieces bridged by straight
    hops shorter than `bridge_m`."""
    pieces = [(w.nodes, w.coords) for w in ways if w.tags.get("highway") in MAIN_ROADS]
    lats = [c[0] for _, cs in pieces for c in cs if c]
    if len(lats) < 2:
        return None
    plane = Plane(float(np.median(lats)))
    idx: dict[int, int] = {}
    pts: list[np.ndarray] = []
    adj: dict[int, list[tuple[int, float]]] = defaultdict(list)
    for nodes, coords in pieces:
        prev = None
        for n, c in zip(nodes, coords):
            if c is None:
                prev = None
                continue
            if n not in idx:
                idx[n] = len(pts)
                pts.append(plane.xy(*c))
            i = idx[n]
            if prev is not None and prev != i:
                d = float(np.hypot(*(pts[i] - pts[prev])))
                adj[i].append((prev, d))
                adj[prev].append((i, d))
            prev = i
    p = np.array(pts)
    comp = np.full(len(p), -1)
    for s in range(len(p)):
        if comp[s] >= 0:
            continue
        stack, comp[s] = [s], s
        while stack:
            u = stack.pop()
            for v, _ in adj[u]:
                if comp[v] < 0:
                    comp[v] = s
                    stack.append(v)
    while len(roots := np.unique(comp)) > 1:
        best = None
        for r0 in roots:
            mine, other = np.where(comp == r0)[0], np.where(comp != r0)[0]
            tree = shapely.STRtree(shapely.points(p[other]))
            (i_mine, i_other), d = tree.query_nearest(shapely.points(p[mine]), return_distance=True, all_matches=False)
            k = int(np.argmin(d))
            if best is None or d[k] < best[0]:
                best = (float(d[k]), int(mine[i_mine[k]]), int(other[i_other[k]]))
        d, a, b = best
        if d > bridge_m:
            break
        adj[a].append((b, d))
        adj[b].append((a, d))
        comp[comp == comp[b]] = comp[a]
    sizes = {r: int((comp == r).sum()) for r in np.unique(comp)}
    start = int(np.where(comp == max(sizes, key=sizes.get))[0][0])
    d, _ = _dijkstra(adj, start, len(p))
    a = int(np.argmax(np.where(np.isfinite(d), d, -1)))
    d, prev = _dijkstra(adj, a, len(p))
    b = int(np.argmax(np.where(np.isfinite(d), d, -1)))
    path = [b]
    while path[-1] != a:
        path.append(int(prev[path[-1]]))
    if len(path) < 2:
        return None
    q = p[path[::-1]]
    return RoadLine(plane, q, np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(q, axis=0).T))]))


def to_chainage(cal: list[tuple[float, float]], km: float) -> float:
    """An official km as chainage (m) on a path, from (chainage, km) points of the same road: the direction from all,
    the offset from the neighbours on either side; points far off the others (another road, a typo) left out."""
    cal = sorted(cal, key=lambda p: p[1])
    s = 1 if np.corrcoef([c for c, _ in cal], [k for _, k in cal])[0, 1] > 0 else -1
    off = [(k, c - s * k * 1000) for c, k in cal]
    med = float(np.median([o for _, o in off]))
    off = [(k, o) for k, o in off if abs(o - med) < 20_000] or off
    ks, os_ = zip(*off)
    return float(np.interp(km, ks, os_)) + s * km * 1000


# --- OSM ------------------------------------------------------------------------------------


@dataclass
class OsmWay:
    id: int
    tags: dict[str, str]
    nodes: list[int]
    why: set[str]
    coords: list[tuple[float, float] | None] = field(default_factory=list)


@dataclass
class Osm:
    cameras: list[dict]
    relations: list[dict]
    # name → [(lat, lon, rank, population)]
    places: dict[str, list[tuple[float, float, int, float]]]
    addresses: list[tuple[dict[str, str], tuple[float, float]]]
    ways: list[OsmWay]
    nodes: dict[int, tuple[float, float]]


def _refs(tags: Mapping[str, str]) -> set[str]:
    return {norm_ref(p) for p in (tags.get("ref") or "").split(";") if p.strip()}


def _population(tags: Mapping[str, str]) -> float:
    digits = re.sub(r"[\s,.']", "", tags.get("population") or "")
    return float(digits) if digits.isdigit() else 0.0


def read_osm(pbf: Path, rows: list[dict]) -> Osm:
    """What the cameras need from the extract, in two passes: cameras, the list's places, addresses and the ways
    through cameras, along the list's roads and named as its streets; then the locations of those ways' nodes."""
    road_refs = {r["ref"] for r in rows if r["kind"] == "road"}
    streets: set[str] = set()
    houses: dict[str, set[str]] = defaultdict(set)
    names = {r["city"] for r in rows if r["kind"] == "city"} | {place_name(r["toward"]) for r in rows if r.get("toward")}
    for r in rows:
        if r["kind"] != "city":
            continue
        streets |= {street_key(s) for s in [r["street"], *(r["crossing"] or [])] if s}
        if r["street"] and r["house"]:
            houses[street_key(r["street"])].add(house_key(r["house"]))
        if r["near"] and (m := re.match(r"^(.*?),?\s*(\d+\S*)$", r["near"])):
            streets.add(street_key(m[1]))
            houses[street_key(m[1])].add(house_key(m[2]))
    streets.discard("")

    def addressed(t) -> bool:
        sk = street_key(t.get("addr:street"))
        return sk in houses and house_key(t.get("addr:housenumber", "")) in houses[sk]

    cameras: list[dict] = []
    relations: list[dict] = []
    places: dict[str, list[tuple[float, float, int, float]]] = defaultdict(list)
    addresses: list[tuple[dict[str, str], tuple[float, float]]] = []
    ways: list[OsmWay] = []
    on_cameras = osmium.IdTracker()
    fp = osmium.FileProcessor(str(pbf), osmium.osm.NODE | osmium.osm.WAY | osmium.osm.RELATION).with_filter(
        osmium.filter.KeyFilter("highway", "place", "addr:housenumber", "type")
    )
    for o in fp:
        t = o.tags
        if o.is_node():
            if not o.location.valid():
                continue
            ll = (o.location.lat, o.location.lon)
            if t.get("highway") == "speed_camera":
                cameras.append({"id": o.id, "lat": ll[0], "lon": ll[1], "tags": dict(t)})
                on_cameras.add_node(o.id)
            elif t.get("place") in PLACE_RANK and t.get("name") in names:
                places[t["name"]].append((*ll, PLACE_RANK[t["place"]], _population(t)))
            elif "addr:street" in t and "addr:housenumber" in t and addressed(t):
                addresses.append(({k: t[k] for k in ("addr:street", "addr:housenumber")}, ll))
        elif o.is_way():
            why = set()
            if road_attrs(t) is not None:
                if _refs(t) & road_refs:
                    why.add("ref")
                if street_key(t.get("name")) in streets or street_key(t.get("old_name")) in streets:
                    why.add("street")
                if on_cameras.contains_any_references(o):
                    why.add("camera")
            if "addr:street" in t and "addr:housenumber" in t and addressed(t):
                why.add("addr")
            if why:
                nodes = [n.ref for n in o.nodes]
                if why == {"addr"}:
                    nodes = nodes[:-1][:6]  # a few corners give its centre
                keep = ("highway", "ref", "name", "old_name", "oneway", "junction", "addr:street", "addr:housenumber")
                ways.append(OsmWay(o.id, {k: t[k] for k in keep if k in t}, nodes, why))
        elif o.is_relation() and t.get("type") == "enforcement" and "maxspeed" in (t.get("enforcement") or "").split(";"):
            relations.append({"id": o.id, "tags": dict(t), "members": [(m.type, m.ref, m.role) for m in o.members]})

    need = {n for w in ways for n in w.nodes} | {ref for r in relations for kind, ref, _ in r["members"] if kind == "n"}
    loc = read_locations(pbf, np.array(sorted(need), dtype=np.int64))
    nodes = {int(i): (la * 1e-7, lo * 1e-7) for i, la, lo in zip(loc.ids.tolist(), loc.lat.tolist(), loc.lon.tolist())}
    for w in ways:
        w.coords = [nodes.get(n) for n in w.nodes]
    log(f"OSM: {len(cameras)} cameras, {len(relations)} enforcement relations, {len(ways)} ways, "
        f"{sum(map(len, places.values()))} places, {len(addresses)} address points")
    return Osm(cameras, relations, places, addresses, ways, nodes)


# --- Cameras --------------------------------------------------------------------------------


@dataclass
class Camera:
    lat: float
    lon: float
    flags: int
    osm_id: int | None = None
    # Of the traffic checked, from OSM; None: none given.
    bearing: float | None = None
    # OSM says both ways (`direction=both`, or a numeric view): the list's rows don't narrow it.
    both: bool = False
    tag_limit: int = 0
    rows: list[dict] = field(default_factory=list)
    # The rows' own directions ("у напрямку X").
    row_bearings: list[float] = field(default_factory=list)

    def limit(self) -> int:
        """The list's (the lowest of a seasonal pair), else the camera's `maxspeed` tag."""
        listed = [v for r in self.rows for v in r["limits"]]
        return min(listed) if listed else self.tag_limit

    def direction(self) -> float | None:
        if self.bearing is not None:
            return self.bearing
        if self.both or not self.row_bearings:
            return None
        b = self.row_bearings
        if any(angle_diff(x, b[0]) > SAME_DIRECTION_DEG for x in b):
            return None
        return math.degrees(math.atan2(sum(math.sin(math.radians(x)) for x in b), sum(math.cos(math.radians(x)) for x in b))) % 360


def tag_kph(value: str | None) -> int:
    return int(value) if value and value.strip().isdigit() and 5 <= int(value) <= 150 else 0


def _way_bearing(w: OsmWay, i: int) -> float | None:
    """The way's bearing at its i-th node."""
    a = w.coords[i - 1] if i > 0 else w.coords[i]
    b = w.coords[i + 1] if i + 1 < len(w.coords) else w.coords[i]
    return bearing_deg(a, b) if a and b and a != b else None


def osm_direction(cam: dict, on_ways: list[tuple[OsmWay, int]]) -> tuple[float | None, bool]:
    """The traffic's bearing from the camera's tags and the ways it is on; and whether OSM says both ways."""
    value = (cam["tags"].get("direction") or "").strip()
    drivable = [(w, i) for w, i in on_ways if road_attrs(w.tags) is not None]
    # The way the node is inside of, rather than one it ends (a junction).
    drivable.sort(key=lambda wi: wi[1] in (0, len(wi[0].nodes) - 1))
    if value in ("forward", "backward") and drivable:
        b = _way_bearing(*drivable[0])
        if b is not None:
            return (b if value == "forward" else (b + 180) % 360), False
    for w, i in drivable:
        oneway = road_attrs(w.tags).oneway
        if oneway in (ONEWAY_FORWARD, ONEWAY_BACKWARD) and (b := _way_bearing(w, i)) is not None:
            return (b if oneway == ONEWAY_FORWARD else (b + 180) % 360), False
    return None, value == "both" or bool(re.fullmatch(r"\d+(?:\.\d+)?", value))


def camera_text(tags: Mapping[str, str]) -> str:
    """The list's words in an OSM camera's name: inside the quotes of `ККШ "…"`, else the whole name."""
    name = tags.get("name:uk") or tags.get("name") or ""
    q = re.search(r"[\"«“](.+)[\"»”]", name)
    return q[1] if q else name


REF_RE = re.compile(r"(?<![\w])([MМHНPРTТ])\s*-?\s*(\d{2})(?:\s*-\s*(\d{2}))?(?:\s*-\s*(\d{2}))?(?![\d])")
KM_RE = re.compile(r"(\d+)\s*\+\s*(\d{1,3})(?!\d)")


def name_keys(tags: Mapping[str, str]) -> tuple[tuple[str, float] | None, dict | None]:
    """What an OSM camera's name says, in the list's terms: a road and km, or a town address."""
    text = camera_text(tags)
    m, k = REF_RE.search(text), KM_RE.search(text)
    if m and k:
        return (norm_ref("".join(g for g in m.groups() if g)), int(k[1]) + int(k[2].ljust(3, "0")) / 1000), None
    if text and not k:
        return None, parse_city("", [re.sub(r"^\s*(?:м|с|смт)\.\s*[^,]+,\s*", "", text), ""])
    return None, None


def town_centres(rows: list[dict], places: Mapping[str, list]) -> dict[str, tuple[float, float]]:
    """Each list town's place point: a city before a town before a village, the most populous of a kind."""
    out = {}
    for town in {r["city"] for r in rows if r["kind"] == "city"}:
        found = sorted(places.get(town, []), key=lambda p: (p[2], -p[3]))
        if found:
            out[town] = found[0][:2]
    return out


def city_row_names(row: dict, cam: dict, centre: tuple[float, float] | None) -> bool:
    """A town row and an OSM camera whose name carries its address, crossing or street (and direction)."""
    o = cam.get("city")
    if not o or centre is None or dist_m(centre, (cam["lat"], cam["lon"])) > TOWN_RADIUS.get(row["city"], TOWN_RADIUS_M):
        return False
    if row["crossing"]:
        keys = [street_key(s) for s in row["crossing"]]
        words = set(" ".join(street_key(s) for s in (o["crossing"] or [o["street"] or ""])).split())
        words |= set(street_key(camera_text(cam["tags"])).split())
        return all(set(k.split()) <= words for k in keys if k)
    if row["house"]:
        return (same_street(street_key(row["street"]), street_key(o["street"])) and o["house"] is not None
                and house_key(o["house"]) == house_key(row["house"]))
    if not same_street(street_key(row["street"]), street_key(o["street"])):
        return False
    return not o["toward"] or not row["toward"] or same_street(street_key(row["toward"]), street_key(o["toward"]))


def _snap(ll: tuple[float, float], ways: list[OsmWay]) -> tuple[tuple[float, float] | None, float]:
    """The nearest point on the ways."""
    plane = Plane(ll[0])
    p = plane.xy(*ll)
    best: tuple[float, np.ndarray | None] = (math.inf, None)
    for w in ways:
        q = [plane.xy(*c) for c in w.coords if c]
        for a, b in zip(q[:-1], q[1:]):
            ab = b - a
            t = 0.0 if not ab.any() else max(0.0, min(1.0, float(np.dot(p - a, ab) / np.dot(ab, ab))))
            d = float(np.hypot(*(a + t * ab - p)))
            if d < best[0]:
                best = (d, a + t * ab)
    return (plane.ll(best[1]) if best[1] is not None else None), best[0]


class Towns:
    """Town rows placed by address: a house snapped onto its street, a crossing's shared node."""

    def __init__(self, osm: Osm):
        self.addresses = osm.addresses + [
            (w.tags, tuple(np.mean([c for c in w.coords if c], axis=0)))
            for w in osm.ways if "addr" in w.why and any(w.coords)
        ]
        self.streets = [w for w in osm.ways if "street" in w.why]

    def street(self, key: str, centre: tuple[float, float], radius: float) -> list[OsmWay]:
        return [
            w for w in self.streets
            if (same_street(key, street_key(w.tags.get("name"))) or same_street(key, street_key(w.tags.get("old_name"))))
            and (c := next((c for c in w.coords if c), None)) and dist_m(c, centre) < radius + 3000
        ]

    def house(self, street: str, house: str, centre, radius) -> tuple[float, float] | None:
        sk, hk = street_key(street), house_key(house)
        found = [ll for t, ll in self.addresses if same_street(sk, street_key(t.get("addr:street")))
                 and house_key(t.get("addr:housenumber", "")) == hk and dist_m(ll, centre) < radius]
        if not found:
            return None
        ll = min(found, key=lambda c: dist_m(c, centre))
        on, d = _snap(ll, self.street(sk, centre, radius))
        return on if on and d < 150 else ll

    def crossing(self, names: list[str], centre, radius) -> tuple[float, float] | None:
        groups = [self.street(street_key(n), centre, radius) for n in names[:2]]
        if len(groups) < 2 or not all(groups):
            return None
        a = {n: c for w in groups[0] for n, c in zip(w.nodes, w.coords) if c}
        b = {n: c for w in groups[1] for n, c in zip(w.nodes, w.coords) if c}
        if shared := set(a) & set(b):
            return min((a[n] for n in shared), key=lambda c: dist_m(c, centre))
        best = min(((dist_m(x, y), x) for x in a.values() for y in b.values()), default=None)
        return best[1] if best and best[0] < 80 else None

    def place(self, row: dict, centre, radius) -> tuple[float, float] | None:
        if row["crossing"]:
            return self.crossing(row["crossing"], centre, radius)
        if row["house"]:
            return self.house(row["street"], row["house"], centre, radius)
        if row["near"] and (m := re.match(r"^(.*?),?\s*(\d+\S*)$", row["near"])):
            ll = self.house(m[1], m[2], centre, radius)
            if ll:
                on, d = _snap(ll, self.street(street_key(row["street"]), centre, radius))
                return on if on and d < 150 else ll
        return None


def toward_bearing(path: RoadLine, ch: float, toward: str | None, places: Mapping[str, list]) -> float | None:
    """The traffic's bearing at chainage `ch` for a row "у напрямку X": along the road away from X, where the camera
    looks. None when X isn't found, or isn't along the road from there."""
    if not toward:
        return None
    found = places.get(place_name(toward))
    if not found:
        return None
    at = path.at(ch)
    # Of the places so named, the biggest kind, then the nearest (villages share names).
    lat, lon, *_ = min(found, key=lambda p: (p[2] > 1, dist_m(at, p[:2])))
    to, _ = path.project(lat, lon)
    if abs(to - ch) < TOWARD_MIN_M:
        return None
    return path.heading(ch, to < ch)


def combine(rows: list[dict], osm: Osm) -> tuple[list[Camera], dict]:
    """OSM's cameras with the list's rows on them, and the rows no OSM camera names placed as cameras of their own."""
    on_ways: dict[int, list[tuple[OsmWay, int]]] = defaultdict(list)
    cam_ids = {c["id"] for c in osm.cameras}
    for w in osm.ways:
        if "camera" in w.why:
            for i, n in enumerate(w.nodes):
                if n in cam_ids:
                    on_ways[n].append((w, i))
    cams: list[Camera] = []
    by_osm: dict[int, Camera] = {}
    for c in osm.cameras:
        c["road"], c["city"] = name_keys(c["tags"])
        bearing, both = osm_direction(c, on_ways.get(c["id"], []))
        cam = Camera(c["lat"], c["lon"], IN_OSM, c["id"], bearing, both, tag_kph(c["tags"].get("maxspeed")))
        cams.append(cam)
        by_osm[c["id"]] = cam
    for r in osm.relations:
        device = next((ref for kind, ref, role in r["members"] if kind == "n" and role == "device"), None)
        start = next((ref for kind, ref, role in r["members"] if kind == "n" and role == "from"), None)
        if device is None or device not in osm.nodes:
            continue
        cam = by_osm.get(device)
        if cam is None:
            ll = osm.nodes[device]
            cam = Camera(ll[0], ll[1], IN_OSM, device, tag_limit=tag_kph(r["tags"].get("maxspeed")))
            cams.append(cam)
            by_osm[device] = cam
        if cam.bearing is None and start in osm.nodes and osm.nodes[start] != osm.nodes[device]:
            cam.bearing, cam.both = bearing_deg(osm.nodes[start], osm.nodes[device]), False
        cam.tag_limit = cam.tag_limit or tag_kph(r["tags"].get("maxspeed"))

    stats = defaultdict(int)
    centres = town_centres(rows, osm.places)
    # 1. Rows an OSM camera's name carries.
    for row in rows:
        if row["kind"] == "road":
            hits = [c for c in osm.cameras if c["road"] and c["road"][0] == row["ref"] and row["km"] is not None
                    and abs(c["road"][1] - row["km"]) < SAME_KM]
        else:
            hits = [c for c in osm.cameras if city_row_names(row, c, centres.get(row["city"]))]
        row["osm"] = [c["id"] for c in hits]
        for c in hits:
            by_osm[c["id"]].rows.append(row)
            by_osm[c["id"]].flags |= ON_LIST
        stats[f"{row['kind']} rows named in OSM"] += bool(hits)

    # 2. Road rows: their road's main path, for a km to place and the direction "у напрямку X".
    ref_ways: dict[str, list[OsmWay]] = defaultdict(list)
    for w in osm.ways:
        if "ref" in w.why:
            for ref in _refs(w.tags):
                ref_ways[ref].append(w)
    placed: list[tuple[dict, tuple[float, float], float | None]] = []
    for ref in sorted({r["ref"] for r in rows if r["kind"] == "road"}):
        mine = [r for r in rows if r["kind"] == "road" and r["ref"] == ref]
        path = main_path(ref_ways.get(ref, []))
        if path is None:
            stats["road rows without their road in OSM"] += len(mine)
            continue
        cal: list[tuple[float, float, dict]] = []
        for r in mine:
            if r["osm"] and r["km"] is not None:
                cam = by_osm[r["osm"][0]]
                ch, d = path.project(cam.lat, cam.lon)
                if d < 100:
                    cal.append((ch, r["km"], r))
                    if (b := toward_bearing(path, ch, r["toward"], osm.places)) is not None:
                        for i in r["osm"]:
                            by_osm[i].row_bearings.append(b)
        for r in mine:
            if r["osm"] or r["km"] is None:
                continue
            near = [(c, k) for c, k, other in cal if other is not r]
            if len(near) < 2 or min(abs(k - r["km"]) for _, k in near) > ROAD_KM_MAX_GAP:
                stats["road rows too far from a named camera to place"] += 1
                continue
            ch = to_chainage(near, r["km"])
            placed.append((r, path.at(ch), toward_bearing(path, ch, r["toward"], osm.places)))

    # 3. Town rows by address.
    towns = Towns(osm)
    for r in rows:
        if r["kind"] != "city" or r["osm"]:
            continue
        centre = centres.get(r["city"])
        ll = towns.place(r, centre, TOWN_RADIUS.get(r["city"], TOWN_RADIUS_M)) if centre else None
        if ll is None:
            stats["town rows without their address in OSM"] += 1
            continue
        placed.append((r, ll, None))

    # 4. A placed row on an OSM camera no row names is that camera; else a camera of its own.
    named = {i for r in rows for i in r["osm"]}
    free = [c for c in cams if c.osm_id not in named]
    for r, ll, b in placed:
        near = min(free, key=lambda c: dist_m(ll, (c.lat, c.lon)), default=None)
        if near is not None and dist_m(ll, (near.lat, near.lon)) < MERGE_M:
            cam = near
            stats["rows placed on an unnamed OSM camera"] += 1
        else:
            cam = Camera(ll[0], ll[1], 0)
            cams.append(cam)
            stats[f"{r['kind']} rows placed as new cameras"] += 1
        cam.flags |= ON_LIST
        cam.rows.append(r)
        if b is not None:
            cam.row_bearings.append(b)
    return cams, dict(stats)


def cameras_json(cams: list[Camera], osm_date: str, rows: int, source: str, warnings: list[str] | None = None) -> str:
    out = sorted(
        [round(c.lat, 6), round(c.lon, 6), -1 if (b := c.direction()) is None else round(b) % 360, c.limit(), c.flags]
        for c in cams
    )
    body = ",\n".join(json.dumps(c, separators=(",", ":")) for c in out)
    mvs = {"rows": rows, "source": source, **({"warnings": warnings} if warnings else {})}
    head = {"format": FORMAT, "osm_date": osm_date, "mvs": mvs}
    return json.dumps(head, ensure_ascii=False)[:-1] + ', "cameras": [\n' + body + "\n]}\n"


def build_cameras(pbf: Path, output: Path, osm_date: str, snapshot: Path = SNAPSHOT, fetch=fetch_page) -> dict:
    """cameras.json from the extract and the list (the page, else its copy)."""
    mvs = mvs_rows(snapshot, fetch)
    rows = mvs.rows
    cams, stats = combine(rows, read_osm(pbf, rows))
    output.write_text(cameras_json(cams, osm_date, len(rows), mvs.source, mvs.warnings), encoding="utf-8", newline="\n")
    listed = sum(1 for c in cams if c.flags & ON_LIST)
    directed = sum(1 for c in cams if c.direction() is not None)
    summary = (f"{len(cams)} cameras ({sum(1 for c in cams if c.flags & IN_OSM)} in OSM, {listed} on the list of "
               f"{len(rows)} rows, {mvs.source}); {directed} with a direction, {sum(1 for c in cams if c.limit())} with a limit")
    log(summary)
    for k in sorted(stats):
        log(f"  {k}: {stats[k]}")
    report(mvs.warnings, summary)
    return {"cameras": len(cams), "listed": listed, "directed": directed, "rows": len(rows), "source": mvs.source,
            "warnings": mvs.warnings, **stats}
