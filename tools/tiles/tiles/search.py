"""Address search index (SEARCH-SPEC): <region>.search.bin.

Five passes over the region's extract with pyosmium: the settlements' areas (admin boundaries and
place polygons), associatedStreet relations (the street of houses tagged with a number only),
tagged ways (streets, buildings with an address, named POI and place areas), tagged nodes (places,
POIs, address points), then the locations of only the nodes those ways use. Everything named
becomes an *entity*:

    place     place=city/town/village/hamlet (settlements) and suburb/quarter/… (named areas)
    street    the named highways of one settlement with one name, merged; or the addresses
              of an `addr:street` no highway carries (address-only street)
    poi       a named amenity, shop, office, …

Each entity outside a settlement belongs to the settlement whose area holds it: a boundary or
place polygon with the settlement's name around its point. Outside every such area, to the
settlement nearest to it (scaled by its kind: a city reaches 15 km, a hamlet 1.2 km) among those
with no area, else among all. So "Шевченка Чернігів" finds the street through its settlement's name. A house
number belongs to its street's entity, or to the settlement for `addr:place` addresses. The file
is read by random access on the phone:

    header      76 B: magic "WTFS", format, counts, section offsets, OSM date, build stamp
    strings     u16 length + UTF-8, deduplicated: names, tags, house numbers
    entities    44 B each: settlements first (with how far their children reach), then each
                settlement's children, then the rest
    addresses   12 B each, grouped by owner entity, house numbers in natural order
    tokens      sorted folded tokens (fold() below, src/nav/search/fold.ts): offsets + blob
    postings    per token, ascending entity ids
    entrances   16 B each, by address; then places to stop at (fuel, cafés, …: STOPS-SPEC §6.1),
                16 B each, by 0.01° cell, and the used cells' table; each section's trailer
                at the end, the entrances' last
"""

from __future__ import annotations

import math
import re
import struct
import time
import unicodedata
from collections import Counter, defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import osmium
import shapely

from .graph import date_stamp, read_locations
from .hours import WEEK_MIN, week_hours
from .streets import read_relation_streets

FORMAT = 1
MAGIC = b"WTFS"
HEADER = struct.Struct("<4sHHIIIIIIIIIII16sII")  # 76 bytes
# Flags (the u16 after the format): the file ends with an entrance section and this trailer
# (section offset, count, "WTFE"). Readers of format 1 without it read the rest as before.
FLAG_ENTRANCES = 1
TRAILER = struct.Struct("<II4s")
ENTRANCE_MAGIC = b"WTFE"
# Places to stop at (STOPS-SPEC §6.1): after the entrances, the places by grid cell, the used
# cells' table and a trailer (section offset, count, "WTFP") just before the entrance trailer,
# which stays last: a reader without places reads the file as before.
FLAG_PLACES = 2
PLACE_MAGIC = b"WTFP"
# Their opening hours (STOPS-SPEC §6.1), just before the places: each place's schedule (u16, HOURS_NONE: unknown;
# padded to 4 bytes), the schedules' first ranges (u32, one more than the schedules), the ranges (u16 start, end:
# [start, end) minutes of the week from Monday 00:00; padded to 4 bytes), and a footer (section offset, schedule
# count, "WTFH") that ends where the places begin. The file's last two trailers stay as they were: readers before
# it read the file as before.
FLAG_HOURS = 4
HOURS_MAGIC = b"WTFH"
HOURS_NONE = 0xFFFF
NONE = 0xFFFFFFFF
EARTH_R = 6_371_008.8
M_PER_DEG = EARTH_R * math.pi / 180

KIND_PLACE, KIND_STREET, KIND_POI = 1, 2, 3

# reach: a settlement's, in REACH_UNIT_M; 0 for other entities, and in files before it (read: the kind's).
ENTITY_DT = np.dtype([
    ("kind", "u1"), ("reach", "u1"), ("rank", "<u2"), ("lat", "<i4"), ("lon", "<i4"),
    ("name", "<u4"), ("name_en", "<u4"), ("tag", "<u4"), ("parent", "<u4"),
    ("addr", "<u4"), ("naddr", "<u4"), ("child", "<u4"), ("nchild", "<u4"),
])
ADDR_DT = np.dtype([("house", "<u4"), ("lat", "<i4"), ("lon", "<i4")])
# address: index in the address table, NONE for an entrance of no address; ref: its number, NONE without.
ENTRANCE_DT = np.dtype([("address", "<u4"), ("ref", "<u4"), ("lat", "<i4"), ("lon", "<i4")])
# name: string (NONE: none, the app shows the category's word); flags: FLAG_24_7, FUEL_FLAGS; category: PLACE_CATEGORIES.
PLACE_DT = np.dtype([("lat", "<i4"), ("lon", "<i4"), ("name", "<u4"), ("flags", "<u2"), ("category", "u1"), ("reserved", "u1")])
# key: the 0.01° grid cell (cell_key); first: its first place. A last entry (NONE, place count) ends the table.
CELL_DT = np.dtype([("key", "<u4"), ("first", "<u4")])
assert (HEADER.size, ENTITY_DT.itemsize, ADDR_DT.itemsize, ENTRANCE_DT.itemsize, PLACE_DT.itemsize) == (76, 44, 12, 16, 16)

# Settlements with no area own the streets, POIs and areas near them: how far (m) each kind reaches.
SETTLEMENT_RADIUS_M = {"city": 15_000, "town": 6_000, "village": 2_500, "hamlet": 1_200}
# A settlement's reach in the file: the farthest of its children and houses, at least its kind's
# radius, in these units (u8: up to 63.75 km), so the app looks for a point's address among the
# settlements that may own it.
REACH_UNIT_M = 250
# Settlement areas: admin boundaries and place polygons (a settlement's when they bear its name).
AREA_TAGS = (("boundary", "administrative"), *(("place", k) for k in SETTLEMENT_RADIUS_M))
PLACE_RANK = {
    "city": 50_000, "town": 40_000, "village": 20_000, "hamlet": 10_000, "suburb": 15_000,
    "quarter": 9_000, "neighbourhood": 8_000, "isolated_dwelling": 3_000, "locality": 2_000,
}
POI_RANK = 1_000
STREET_HIGHWAYS = {
    "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
    "living_street", "service", "road", "track", "pedestrian",
}
POI_KEYS = ("amenity", "shop", "tourism", "leisure", "office", "healthcare", "craft", "historic")
POI_VALUES = {"railway": {"station", "halt"}, "aeroway": {"aerodrome", "terminal"}}
# Every name a query may use; the first present of DISPLAY_KEYS is shown, name:en in English.
NAME_KEYS = ("name", "name:uk", "name:en", "name:ru", "alt_name", "old_name", "official_name")
DISPLAY_KEYS = ("name", "name:uk")
FILTER_KEYS = ("highway", "addr:housenumber", "place", "entrance", *POI_KEYS, *POI_VALUES)
# Entrances people use (garages, shop doors and emergency exits are left out); the number is the
# `ref`, else `addr:unit`, else a `name` of up to three letters or digits ("1", "Б").
ENTRANCE_KINDS = {"staircase", "main", "yes", "home", "secondary"}
SHORT_NAME_RE = re.compile(r"[0-9A-Za-zА-Яа-яІіЇїЄєҐґ]{1,3}")
# Places to stop at, named or not: `amenity` → category (u8). Parking only where anyone may park.
PLACE_CATEGORIES = {
    "fuel": 1, "charging_station": 2, "cafe": 3, "fast_food": 4, "restaurant": 4, "pharmacy": 5, "parking": 6,
}
PLACE_CATEGORY_COUNT = 6
PARKING_CLOSED = {"private", "customers", "no"}
PLACE_NAME_KEYS = ("name", "name:uk", "brand")
# Flags: open 24/7 (the whole week, however `opening_hours` says it), and for fuel the fuels sold (`<tag>` = yes).
FLAG_24_7 = 1
FUEL_FLAGS = (("fuel:diesel", 2), ("fuel:lpg", 4), ("fuel:octane_92", 8), ("fuel:octane_95", 16), ("fuel:octane_98", 32))
# Grid cell of a place: 0.01°, key = row × CELL_COLS + column, from the stored 1e-6° coordinates.
CELL_E6 = 10_000
CELL_COLS = 36_000
# An address whose street no highway of its settlement carries joins a same-named street
# whose extent is this close (m), in any settlement; else it makes an address-only street.
STREET_JOIN_M = 500
# `addr:place` joins a place of that name this close (m).
PLACE_JOIN_M = 3_000


def log(msg: str) -> None:
    print(f"[search] {msg}", flush=True)


# --- Folding (keep in step with src/nav/search/fold.ts; shared cases in
# src/nav/search/__fixtures__/fold-cases.json) ----------------------------------------------

TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "h", "ґ": "g", "д": "d", "е": "e", "є": "ie", "ж": "zh",
    "з": "z", "и": "y", "і": "i", "ї": "i", "й": "i", "к": "k", "л": "l", "м": "m", "н": "n",
    "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "kh", "ц": "ts",
    "ч": "ch", "ш": "sh", "щ": "shch", "ь": "", "ю": "iu", "я": "ia", "ё": "e", "ы": "y",
    "э": "e", "ъ": "", "'": "", "’": "", "ʼ": "", "`": "",
}
# Latin spellings of є, ю, я at a word start (ye, yu, ya) fold like the ones inside a word.
DIGRAPHS = (("ye", "ie"), ("yu", "iu"), ("ya", "ia"))
TOKEN_RE = re.compile(r"[a-z0-9]+")
# Combining diacritical marks (U+0300–U+036F) after NFD: é → e, ü → u. Other marks stay and
# split tokens, in both languages alike.
MARKS_RE = re.compile("[\u0300-\u036f]")
HOUSE_DROP_RE = re.compile(r"[^a-z0-9/]")

# Street and settlement kinds (folded): a query may leave them out, abbreviate or misspell them.
STOPWORDS = frozenset({
    "vulytsia", "vul", "provulok", "prov", "prospekt", "prosp", "ploshcha", "pl", "bulvar",
    "bulv", "shose", "naberezhna", "nab", "uzviz", "proizd", "aleia", "tupyk", "maidan",
    "mikroraion", "mkr", "mkrn", "kvartal", "ulytsa", "ul", "pereulok", "per", "ploshchad",
    "street", "st", "avenue", "ave", "lane", "ln", "square", "sq", "boulevard", "blvd", "road",
    "rd", "misto", "selo", "selyshche", "smt",
})


def translit(text: str) -> str:
    """Lower case, Cyrillic to Latin, diacritics dropped, digraph variants folded."""
    s = "".join(TRANSLIT.get(c, c) for c in unicodedata.normalize("NFC", text.lower()))
    s = MARKS_RE.sub("", unicodedata.normalize("NFD", s))
    for a, b in DIGRAPHS:
        s = s.replace(a, b)
    return s


def fold(text: str) -> list[str]:
    """Search tokens of a name or query: runs of ASCII letters and digits."""
    return TOKEN_RE.findall(translit(text))


def fold_house(text: str) -> str:
    """A house number for matching: "10-А" → "10a"; "12/2" keeps its slash."""
    return HOUSE_DROP_RE.sub("", translit(text))


def name_key(text: str) -> str:
    return " ".join(fold(text))


def house_sort_key(house: str) -> tuple[int, str]:
    m = re.match(r"\d+", house)
    return (int(m.group()) if m else 1 << 30, fold_house(house))


# --- Reading ------------------------------------------------------------------------------


@dataclass
class Item:
    """A named or addressed OSM object; located (1e-7°) after the node pass."""
    names: dict[str, str]
    tags: dict[str, str]
    refs: list[int] | None = None  # way nodes; None for a node
    lon: int = 0
    lat: int = 0
    located: bool = False
    length_m: float = 0.0  # streets
    bbox: list[int] | None = None  # streets: extent of the way (1e-7°)
    osm_id: int = 0  # nodes
    entrances: list["Item"] = field(default_factory=list)  # addresses: the entrances on its outline
    owned: bool = False  # entrances: on an address's outline


@dataclass
class Area:
    """A boundary or place polygon (lon/lat °) and its names, folded without kind words."""
    keys: frozenset[str]
    geom: object


@dataclass
class Raw:
    places: list[Item] = field(default_factory=list)
    streets: list[Item] = field(default_factory=list)
    addresses: list[Item] = field(default_factory=list)
    pois: list[Item] = field(default_factory=list)
    entrances: list[Item] = field(default_factory=list)
    stops: list[Item] = field(default_factory=list)  # places to stop at (PLACE_CATEGORIES)
    areas: list[Area] = field(default_factory=list)


def names_of(tags: Mapping[str, str]) -> dict[str, str]:
    return {k: v for k in NAME_KEYS if (v := (tags.get(k) or "").strip())}


def poi_tag(tags: Mapping[str, str]) -> str | None:
    for key in POI_KEYS:
        value = tags.get(key)
        if value and value != "no":
            return f"{key}={value}"
    for key, values in POI_VALUES.items():
        if tags.get(key) in values:
            return f"{key}={tags.get(key)}"
    return None


def stop_place(tags: Mapping[str, str]) -> Item | None:
    """A place to stop at (STOPS-SPEC §6.1), named or not: tags `category`, `flags`, `name` if any, and `hours`
    when its opening hours are known (`start-end` minutes of the week, comma-separated; empty: always closed)."""
    amenity = tags.get("amenity")
    category = PLACE_CATEGORIES.get(amenity)
    if category is None or (amenity == "parking" and (tags.get("access") or "").strip() in PARKING_CLOSED):
        return None
    hours = week_hours(tags.get("opening_hours"))
    flags = FLAG_24_7 if hours == ((0, WEEK_MIN),) else 0
    if amenity == "fuel":
        for key, bit in FUEL_FLAGS:
            if (tags.get(key) or "").strip() == "yes":
                flags |= bit
    name = next((v for k in PLACE_NAME_KEYS if (v := (tags.get(k) or "").strip())), "")
    out = {"category": str(category), "flags": str(flags), "name": name}
    if hours is not None:
        out["hours"] = ",".join(f"{s}-{e}" for s, e in hours)
    return Item({}, out)


def classify(tags: Mapping[str, str], refs: list[int] | None, raw: Raw, relation_street: str = "") -> list[Item]:
    """Adds the object to every list it belongs in; returns the items made. `relation_street`:
    the street an associatedStreet relation gives the object, for a house without `addr:street`."""
    names = names_of(tags)
    shown = any(k in names for k in DISPLAY_KEYS)
    made: list[tuple[list[Item], Item]] = []
    place = tags.get("place")
    if place in PLACE_RANK and shown:
        made.append((raw.places, Item(names, {"place": place, "population": tags.get("population") or ""}, refs)))
    if refs is not None and tags.get("highway") in STREET_HIGHWAYS and shown:
        made.append((raw.streets, Item(names, {"highway": tags.get("highway")}, refs)))
    house = (tags.get("addr:housenumber") or "").strip()
    street, addr_place = (tags.get("addr:street") or "").strip(), (tags.get("addr:place") or "").strip()
    if not (street or addr_place):
        street = relation_street
    if house and (street or addr_place):
        made.append((raw.addresses, Item({}, {"house": house, "street": street, "place": addr_place}, refs)))
    if refs is None and tags.get("entrance") in ENTRANCE_KINDS:
        made.append((raw.entrances, Item({}, {"ref": entrance_number(tags)})))
    if shown and place is None and (tag := poi_tag(tags)):
        made.append((raw.pois, Item(names, {"tag": tag}, refs)))
    if (stop := stop_place(tags)) is not None:
        stop.refs = refs
        made.append((raw.stops, stop))
    for lst, item in made:
        lst.append(item)
    return [item for _, item in made]


def read_objects(pbf: Path) -> Raw:
    # Areas first: their node location index is gone before the other passes fill the memory.
    raw = Raw(areas=read_areas(pbf))
    ways: list[Item] = []
    rel_street = read_relation_streets(pbf)
    for obj in osmium.FileProcessor(str(pbf), osmium.osm.WAY).with_filter(osmium.filter.KeyFilter(*FILTER_KEYS)):
        refs = [n.ref for n in obj.nodes]
        if refs:
            ways.extend(classify(obj.tags, refs, raw, rel_street.get(("w", obj.id), "")))
    for obj in osmium.FileProcessor(str(pbf), osmium.osm.NODE).with_filter(osmium.filter.KeyFilter(*FILTER_KEYS)):
        if not obj.location.valid():
            continue
        for item in classify(obj.tags, None, raw, rel_street.get(("n", obj.id), "")):
            item.lon, item.lat, item.located = obj.location.x, obj.location.y, True
            item.osm_id = obj.id
    locate_ways(pbf, ways)
    for name in ("places", "streets", "addresses", "pois", "entrances", "stops"):
        setattr(raw, name, [i for i in getattr(raw, name) if i.located])
    link_entrances(raw)
    return raw


def area_key(text: str) -> str:
    """A name compared between a settlement and its area: folded, kind words left out ("смт")."""
    return " ".join(t for t in fold(text) if t not in STOPWORDS)


def read_areas(pbf: Path) -> list[Area]:
    """Named admin boundaries and place polygons. One cut by the region's edge can't be
    assembled and is left out: its settlement keeps the nearest-point rule."""
    wkb = osmium.geom.WKBFactory()
    areas: list[Area] = []
    fp = osmium.FileProcessor(str(pbf)).with_areas(osmium.filter.TagFilter(*AREA_TAGS))
    for obj in fp.with_filter(osmium.filter.KeyFilter("boundary", "place")):
        if not obj.is_area():
            continue
        keys = frozenset(k for v in names_of(obj.tags).values() if (k := area_key(v)))
        if not keys:
            continue
        try:
            geom = shapely.from_wkb(wkb.create_multipolygon(obj))
        except RuntimeError:
            continue  # broken multipolygon
        if not geom.is_valid:
            geom = geom.buffer(0)  # a ring that touches itself
        if not geom.is_empty:
            areas.append(Area(keys, geom))
    return areas


def entrance_number(tags: Mapping[str, str]) -> str:
    for key in ("ref", "addr:unit"):
        if v := (tags.get(key) or "").strip():
            return v
    name = (tags.get("name") or "").strip()
    return name if SHORT_NAME_RE.fullmatch(name) else ""


def link_entrances(raw: Raw) -> None:
    """Each entrance on an addressed building's outline joins that address (the first, if two
    buildings share it). Entrances drawn next to a building, off its outline, stay loose."""
    by_node = {e.osm_id: e for e in raw.entrances}
    if not by_node:
        return
    for a in raw.addresses:
        for ref in dict.fromkeys(a.refs or ()):
            e = by_node.get(ref)
            if e is not None and not e.owned:
                e.owned = True
                a.entrances.append(e)


def locate_ways(pbf: Path, ways: list[Item]) -> None:
    """Centroid of a way's nodes; for a street, the vertex halfway along it and its length."""
    if not ways:
        return
    loc = read_locations(pbf, np.unique(np.fromiter((r for w in ways for r in w.refs), dtype=np.int64)))
    ids, lon, lat = loc.ids, loc.lon, loc.lat
    for item in ways:
        refs = np.asarray(item.refs, dtype=np.int64)
        pos = np.searchsorted(ids, refs)
        pos[pos >= len(ids)] = 0
        ok = ids[pos] == refs if len(ids) else np.zeros(len(refs), bool)
        if not ok.any():
            continue
        x, y = lon[pos[ok]].astype(np.float64), lat[pos[ok]].astype(np.float64)
        item.located = True
        if "highway" in item.tags and len(x) >= 2:
            kx = math.cos(math.radians(y[0] * 1e-7))
            seg = np.hypot(np.diff(x) * kx, np.diff(y)) * 1e-7 * M_PER_DEG
            cum = np.concatenate([[0.0], np.cumsum(seg)])
            item.length_m = float(cum[-1])
            item.bbox = [int(x.min()), int(y.min()), int(x.max()), int(y.max())]
            mid = int(np.searchsorted(cum, cum[-1] / 2))
            item.lon, item.lat = int(x[min(mid, len(x) - 1)]), int(y[min(mid, len(y) - 1)])
        else:
            if len(x) > 1 and item.refs[0] == item.refs[-1]:
                x, y = x[:-1], y[:-1]  # closed way: the first node once
            item.lon, item.lat = int(round(x.mean())), int(round(y.mean()))


# --- Building -----------------------------------------------------------------------------


@dataclass
class Entity:
    kind: int
    names: dict[str, str]
    tag: str
    lon: int  # 1e-7°
    lat: int
    rank: int
    parent: int = -1  # index into Index.entities before ordering
    # street groups: extent (1e-7°) and name spellings seen
    bbox: list[int] | None = None
    houses: list[tuple[str, int, int]] = field(default_factory=list)
    reach_m: float = 0.0  # settlements: how far their children and houses are (set_reach)


def display_name(names: Mapping[str, str]) -> str:
    return next(names[k] for k in (*DISPLAY_KEYS, *NAME_KEYS) if k in names)


def projector(lat0_e7: float):
    kx = math.cos(math.radians(lat0_e7 * 1e-7)) * M_PER_DEG * 1e-7
    ky = M_PER_DEG * 1e-7

    def project(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
        return np.column_stack([np.asarray(lon, np.float64) * kx, np.asarray(lat, np.float64) * ky])

    return project


def nearest_settlement(points: np.ndarray, settlements: list[tuple[int, str, np.ndarray]]) -> np.ndarray:
    """For each projected point (m), the settlement (index) with the smallest distance ÷ its
    kind's reach, within that reach; −1 for none."""
    best = np.full(len(points), -1, dtype=np.int64)
    if not len(points) or not settlements:
        return best
    score = np.full(len(points), np.inf)
    geoms = shapely.points(points)
    for kind, radius in SETTLEMENT_RADIUS_M.items():
        of_kind = [(i, xy) for i, k, xy in settlements if k == kind]
        if not of_kind:
            continue
        tree = shapely.STRtree(shapely.points(np.array([xy for _, xy in of_kind])))
        (src, dst), dist = tree.query_nearest(geoms, max_distance=radius, return_distance=True, all_matches=False)
        s = dist / radius
        better = s < score[src]
        score[src[better]] = s[better]
        best[src[better]] = np.array([of_kind[j][0] for j in dst[better]], dtype=np.int64)
    return best


def settlement_areas(entities: list[Entity], settlements: list[tuple[int, str, np.ndarray]], areas: list[Area]) -> list[tuple[object, int]]:
    """Each settlement's area, with the settlement's index: the smallest of the areas that hold
    its point and bear one of its names. An area is one settlement's (the higher rank's)."""
    if not areas or not settlements:
        return []
    tree = shapely.STRtree([a.geom for a in areas])
    points = shapely.points([(entities[i].lon * 1e-7, entities[i].lat * 1e-7) for i, _, _ in settlements])
    holder: dict[int, int] = {}
    for s, a in zip(*tree.query(points, predicate="within").tolist()):
        i = settlements[s][0]
        if not areas[a].keys & {k for v in entities[i].names.values() if (k := area_key(v))}:
            continue  # a district, a hromada or another settlement around it
        j = holder.get(a)
        if j is None or entities[i].rank > entities[j].rank:
            holder[a] = i
    smallest: dict[int, int] = {}
    for a, i in holder.items():
        if i not in smallest or areas[a].geom.area < areas[smallest[i]].geom.area:
            smallest[i] = a
    return [(areas[a].geom, i) for i, a in smallest.items()]


def settlement_finder(entities: list[Entity], settlements: list[tuple[int, str, np.ndarray]], areas: list[Area], project):
    """(lon, lat 1e-7°) → settlement index, −1 for none. A point in a settlement's area is that
    settlement's (the innermost area's). Elsewhere the nearest one's that has no area (one with an
    area owns nothing outside it), else the nearest one's: near a town past its edge, by a road."""
    owned = settlement_areas(entities, settlements, areas)
    bounded = {i for _, i in owned}
    unbounded = [s for s in settlements if s[0] not in bounded]
    tree = shapely.STRtree([g for g, _ in owned]) if owned else None
    size = np.array([g.area for g, _ in owned])
    owner = np.array([i for _, i in owned], dtype=np.int64)

    def parents(items_lon, items_lat) -> np.ndarray:
        lon, lat = np.asarray(items_lon, np.float64), np.asarray(items_lat, np.float64)
        xy = project(lon, lat)
        best = nearest_settlement(xy, unbounded)
        if bounded and (none := best < 0).any():
            best[none] = nearest_settlement(xy[none], settlements)
        if tree is not None and len(lon):
            point, area = tree.query(shapely.points(lon * 1e-7, lat * 1e-7), predicate="within")
            order = np.lexsort((size[area], point))  # by point, the smallest area first
            point, area = point[order], area[order]
            first = np.r_[True, point[1:] != point[:-1]] if len(point) else np.zeros(0, bool)
            best[point[first]] = owner[area[first]]
        return best

    return parents


def build_index(raw: Raw) -> list[Entity]:
    """Entities (settlements, other places, streets, POIs) with parents and house numbers."""
    entities: list[Entity] = []
    all_lat = [i.lat for lst in (raw.places, raw.streets, raw.addresses, raw.pois) for i in lst]
    project = projector(float(np.mean(all_lat)) if all_lat else 0.0)

    # Places; settlements are their own parents' roots.
    settlements: list[tuple[int, str, np.ndarray]] = []
    for p in raw.places:
        kind = p.tags["place"]
        pop = re.match(r"\d+", p.tags.get("population", "").replace(" ", ""))
        rank = PLACE_RANK[kind] + min(9_999, int(pop.group()) // 100 if pop else 0)
        idx = len(entities)
        entities.append(Entity(KIND_PLACE, p.names, f"place={kind}", p.lon, p.lat, rank))
        if kind in SETTLEMENT_RADIUS_M:
            settlements.append((idx, kind, project([p.lon], [p.lat])[0]))
    settlement_set = {i for i, _, _ in settlements}
    parents = settlement_finder(entities, settlements, raw.areas, project)

    others = [i for i in range(len(entities)) if i not in settlement_set]
    if others:
        par = parents([entities[i].lon for i in others], [entities[i].lat for i in others])
        for i, p in zip(others, par.tolist()):
            entities[i].parent = p

    # Streets: highways merged by (name, settlement).
    groups: dict[tuple[str, int], int] = {}
    by_name: dict[str, list[int]] = defaultdict(list)
    if raw.streets:
        par = parents([s.lon for s in raw.streets], [s.lat for s in raw.streets])
        best_len: dict[int, float] = {}
        for s, p in zip(raw.streets, par.tolist()):
            key = (name_key(display_name(s.names)), p)
            if not key[0]:
                continue
            idx = groups.get(key)
            if idx is None:
                idx = len(entities)
                groups[key] = idx
                by_name[key[0]].append(idx)
                entities.append(Entity(KIND_STREET, dict(s.names), f"highway={s.tags['highway']}", s.lon, s.lat, 0, p, None))
                best_len[idx] = -1.0
            e = entities[idx]
            for k, v in s.names.items():
                e.names.setdefault(k, v)
            e.rank += s.length_m
            if s.length_m > best_len[idx]:
                # Shown at the longest way's middle, with its name spelling and class.
                best_len[idx] = s.length_m
                e.lon, e.lat, e.tag = s.lon, s.lat, f"highway={s.tags['highway']}"
                e.names = {**e.names, **s.names}
            for lon, lat in ((s.bbox[0], s.bbox[1]), (s.bbox[2], s.bbox[3])) if s.bbox else ((s.lon, s.lat),):
                e.bbox = extend_bbox(e.bbox, lon, lat)

    # Addresses.
    place_by_name: dict[str, list[int]] = defaultdict(list)
    for i, e in enumerate(entities):
        if e.kind == KIND_PLACE:
            for v in set(e.names.values()):
                place_by_name[name_key(v)].append(i)
    if raw.addresses:
        par = parents([a.lon for a in raw.addresses], [a.lat for a in raw.addresses])
        orphan_spelling: dict[int, Counter] = defaultdict(Counter)
        place_groups: dict[tuple[str, int], int] = {}
        for a, p in zip(raw.addresses, par.tolist()):
            house, street, aplace = a.tags["house"], a.tags["street"], a.tags["place"]
            owner = None
            if street:
                key = (name_key(street), p)
                if not key[0]:
                    continue
                owner = groups.get(key)
                if owner is None:
                    owner = nearest_by_bbox(entities, by_name.get(key[0], []), a.lon, a.lat, STREET_JOIN_M)
                if owner is None:
                    owner = len(entities)
                    groups[key] = owner
                    by_name[key[0]].append(owner)
                    entities.append(Entity(KIND_STREET, {}, "addr:street", a.lon, a.lat, 0, p, None))
                if entities[owner].tag == "addr:street":
                    orphan_spelling[owner][street] += 1
            else:
                k = name_key(aplace)
                if not k:
                    continue
                if p >= 0 and k in {name_key(v) for v in entities[p].names.values()}:
                    owner = p
                else:
                    owner = nearest_place(entities, place_by_name.get(k, []), a.lon, a.lat, PLACE_JOIN_M)
                if owner is None:
                    # A hamlet or an area not mapped as a place: its houses make a street-like entity.
                    owner = place_groups.get((k, p))
                    if owner is None:
                        owner = len(entities)
                        place_groups[(k, p)] = owner
                        entities.append(Entity(KIND_STREET, {}, "addr:place", a.lon, a.lat, 0, p, None))
                    orphan_spelling[owner][aplace] += 1
            e = entities[owner]
            e.houses.append((house, a.lon, a.lat, a.entrances))
            if e.kind == KIND_STREET:
                e.bbox = extend_bbox(e.bbox, a.lon, a.lat)
        for idx, spellings in orphan_spelling.items():
            e = entities[idx]
            e.names = {"name": spellings.most_common(1)[0][0]}
            # Shown at the house nearest the middle of its houses.
            lon = np.array([h[1] for h in e.houses], np.float64)
            lat = np.array([h[2] for h in e.houses], np.float64)
            j = int(np.argmin((lon - lon.mean()) ** 2 + (lat - lat.mean()) ** 2))
            e.lon, e.lat = int(lon[j]), int(lat[j])

    for e in entities:
        if e.kind == KIND_STREET:
            e.rank = min(30_000, int(e.rank / 10) + 10 * len(e.houses))

    # POIs.
    if raw.pois:
        par = parents([q.lon for q in raw.pois], [q.lat for q in raw.pois])
        for q, p in zip(raw.pois, par.tolist()):
            entities.append(Entity(KIND_POI, q.names, q.tags["tag"], q.lon, q.lat, POI_RANK, p))
    set_reach(entities, settlements)
    return entities


def set_reach(entities: list[Entity], settlements: list[tuple[int, str, np.ndarray]]) -> None:
    """Each settlement's reach: the farthest of its children and houses (and its own), plus
    100 m (a dropped pin finds a house 75 m away), at least its kind's radius."""
    owner, lon, lat = [], [], []
    for i, e in enumerate(entities):
        s = i if e.parent < 0 else e.parent
        owner.append(s)
        lon.append(e.lon)
        lat.append(e.lat)
        for h in e.houses:
            owner.append(s)
            lon.append(h[1])
            lat.append(h[2])
    if not owner:
        return
    s_idx = np.array(owner, dtype=np.int64)
    s_lon = np.array([entities[s].lon for s in range(len(entities))], np.float64)[s_idx]
    s_lat = np.array([entities[s].lat for s in range(len(entities))], np.float64)[s_idx]
    dx = (np.array(lon, np.float64) - s_lon) * 1e-7 * M_PER_DEG * np.cos(np.radians(s_lat * 1e-7))
    dy = (np.array(lat, np.float64) - s_lat) * 1e-7 * M_PER_DEG
    far = np.zeros(len(entities))
    np.maximum.at(far, s_idx, np.hypot(dx, dy))
    for i, kind, _ in settlements:
        entities[i].reach_m = max(float(SETTLEMENT_RADIUS_M[kind]), far[i] + 100)


def extend_bbox(bbox: list[int] | None, lon: int, lat: int) -> list[int]:
    if bbox is None:
        return [lon, lat, lon, lat]
    return [min(bbox[0], lon), min(bbox[1], lat), max(bbox[2], lon), max(bbox[3], lat)]


def bbox_distance_m(bbox: list[int], lon: int, lat: int) -> float:
    dx = max(bbox[0] - lon, 0, lon - bbox[2]) * 1e-7 * M_PER_DEG * math.cos(math.radians(lat * 1e-7))
    dy = max(bbox[1] - lat, 0, lat - bbox[3]) * 1e-7 * M_PER_DEG
    return math.hypot(dx, dy)


def nearest_by_bbox(entities: list[Entity], candidates: list[int], lon: int, lat: int, limit_m: float) -> int | None:
    best, best_d = None, limit_m
    for i in candidates:
        bbox = entities[i].bbox
        if bbox is not None and (d := bbox_distance_m(bbox, lon, lat)) <= best_d:
            best, best_d = i, d
    return best


def nearest_place(entities: list[Entity], candidates: list[int], lon: int, lat: int, limit_m: float) -> int | None:
    best, best_d = None, limit_m
    for i in candidates:
        e = entities[i]
        if (d := bbox_distance_m([e.lon, e.lat, e.lon, e.lat], lon, lat)) <= best_d:
            best, best_d = i, d
    return best


# --- Writing ------------------------------------------------------------------------------


class Strings:
    """Deduplicated string table: u16 byte length + UTF-8."""

    def __init__(self) -> None:
        self.data = bytearray()
        self.offsets: dict[str, int] = {}

    def add(self, text: str | None) -> int:
        if text is None:
            return NONE
        off = self.offsets.get(text)
        if off is None:
            raw = text.encode("utf-8")[:0xFFFF]
            off = len(self.data)
            self.data += struct.pack("<H", len(raw)) + raw
            self.offsets[text] = off
        return off


def order_entities(entities: list[Entity]) -> tuple[list[int], int]:
    """Settlements (by rank) first, then each settlement's children (kind, name), then the
    entities without a settlement: a settlement's children are one contiguous range."""
    is_settlement = [e.kind == KIND_PLACE and e.tag.split("=", 1)[1] in SETTLEMENT_RADIUS_M for e in entities]
    settlements = sorted((i for i, s in enumerate(is_settlement) if s), key=lambda i: (-entities[i].rank, display_name(entities[i].names)))
    rank_of = {i: r for r, i in enumerate(settlements)}
    rest = [i for i, s in enumerate(is_settlement) if not s]
    rest.sort(key=lambda i: (rank_of.get(entities[i].parent, len(settlements)), entities[i].kind, name_key(display_name(entities[i].names))))
    return settlements + rest, len(settlements)


def cell_key(lat6: int, lon6: int) -> int:
    """The 0.01° grid cell of a point in 1e-6°: row × CELL_COLS + column, counted from (-90, -180)."""
    return (lat6 + 90_000_000) // CELL_E6 * CELL_COLS + min(CELL_COLS - 1, (lon6 + 180_000_000) // CELL_E6)


def place_section(stops: Sequence[Item], strings: Strings) -> tuple[np.ndarray, np.ndarray, list[str | None]]:
    """The places by (cell, lat, lon, category), their names added to `strings`, the cell table: each used
    cell's key and first place, ascending, then (NONE, place count); and each place's hours tag (None: unknown)."""
    rows = []
    for it in stops:
        lat, lon = q6(it.lat), q6(it.lon)
        rows.append((cell_key(lat, lon), lat, lon, int(it.tags["category"]), int(it.tags["flags"]), it.tags["name"],
                     it.tags.get("hours", "?")))
    rows.sort()
    rec = np.zeros(len(rows), dtype=PLACE_DT)
    if rows:
        rec["lat"], rec["lon"], rec["category"], rec["flags"] = zip(*((r[1], r[2], r[3], r[4]) for r in rows))
        rec["name"] = [strings.add(r[5] or None) for r in rows]
    keys = np.fromiter((r[0] for r in rows), dtype=np.int64, count=len(rows))
    used, first = np.unique(keys, return_index=True)
    cells = np.zeros(len(used) + 1, dtype=CELL_DT)
    cells["key"][:-1], cells["first"][:-1] = used, first
    cells[-1] = (NONE, len(rows))
    return rec, cells, [None if r[6] == "?" else r[6] for r in rows]


def hours_section(hours: Sequence[str | None], offset: int) -> tuple[bytes, int]:
    """The places' opening hours (FLAG_HOURS) for a section at `offset`, with its footer; and its schedule count.
    Each schedule once, the most common first: past 65,535 of them the rarest are unknown."""
    counts = Counter(h for h in hours if h is not None)
    schedules = [h for h, _ in counts.most_common(HOURS_NONE)]
    index = {h: i for i, h in enumerate(schedules)}
    which = np.array([HOURS_NONE if h is None else index.get(h, HOURS_NONE) for h in hours], dtype="<u2")
    ranges = [[int(v) for r in h.split(",") for v in r.split("-")] if h else [] for h in schedules]
    first = np.concatenate([[0], np.cumsum([len(r) // 2 for r in ranges], dtype=np.int64)]).astype("<u4")
    flat = np.array([v for r in ranges for v in r], dtype="<u2")
    body = pad4(which.tobytes()) + first.tobytes() + pad4(flat.tobytes())
    return body + TRAILER.pack(offset, len(schedules), HOURS_MAGIC), len(schedules)


def write_index(entities: list[Entity], path: Path, osm_date: str, built_at: int | None = None,
                loose_entrances: list[Item] = (), stops: Sequence[Item] = ()) -> dict[str, int]:
    """`loose_entrances`: entrances on no address's outline, kept for the map (address NONE).
    `stops`: places to stop at (stop_place); the section is written even when there are none."""
    order, n_settlements = order_entities(entities)
    new_id = np.empty(len(entities), dtype=np.int64)
    new_id[order] = np.arange(len(order))
    strings = Strings()
    ent = np.zeros(len(order), dtype=ENTITY_DT)
    addrs: list[tuple[int, int, int]] = []
    entrances: list[tuple[int, int, int, int]] = []
    postings: dict[str, set[int]] = defaultdict(set)
    children: dict[int, list[int]] = defaultdict(list)

    for nid, old in enumerate(order):
        e = entities[old]
        r = ent[nid]
        r["kind"], r["rank"] = e.kind, min(0xFFFF, max(0, int(e.rank)))
        r["reach"] = min(0xFF, math.ceil(e.reach_m / REACH_UNIT_M))
        r["lon"], r["lat"] = q6(e.lon), q6(e.lat)
        shown = display_name(e.names)
        r["name"] = strings.add(shown)
        en = e.names.get("name:en")
        r["name_en"] = strings.add(en) if en and en != shown else NONE
        r["tag"] = strings.add(e.tag)
        r["parent"] = new_id[e.parent] if e.parent >= 0 else NONE
        if e.parent >= 0:
            children[int(new_id[e.parent])].append(nid)
        houses = sorted(e.houses, key=lambda h: house_sort_key(h[0]))
        r["addr"], r["naddr"] = len(addrs), len(houses)
        for h, lon, lat, ents in houses:
            for en in sorted(ents, key=lambda en: house_sort_key(en.tags["ref"] or "~")):
                ref = en.tags["ref"]
                entrances.append((len(addrs), strings.add(ref) if ref else NONE, q6(en.lat), q6(en.lon)))
            addrs.append((strings.add(h), q6(lon), q6(lat)))
        for v in set(e.names.values()):
            for tok in fold(v):
                postings[tok].add(nid)
    for nid in range(len(order)):
        kids = children.get(nid)
        if kids:
            if kids != list(range(kids[0], kids[0] + len(kids))):
                raise AssertionError("a settlement's children aren't contiguous")
            ent[nid]["child"], ent[nid]["nchild"] = kids[0], len(kids)
        else:
            ent[nid]["child"] = NONE

    addr_rec = np.zeros(len(addrs), dtype=ADDR_DT)
    if addrs:
        addr_rec["house"], addr_rec["lat"], addr_rec["lon"] = zip(*((h, la, lo) for h, lo, la in addrs))

    for en in loose_entrances:
        ref = en.tags["ref"]
        entrances.append((NONE, strings.add(ref) if ref else NONE, q6(en.lat), q6(en.lon)))
    entr_rec = np.zeros(len(entrances), dtype=ENTRANCE_DT)
    if entrances:
        entr_rec["address"], entr_rec["ref"], entr_rec["lat"], entr_rec["lon"] = zip(*entrances)
    place_rec, cell_rec, place_hours = place_section(stops, strings)  # before the strings are written

    tokens = sorted(postings)
    encoded = [t.encode("ascii") for t in tokens]
    tok_blob = b"".join(encoded)
    tok_off = np.concatenate([[0], np.cumsum([len(t) for t in encoded], dtype=np.int64)]).astype("<u4")
    post = [sorted(postings[t]) for t in tokens]
    post_start = np.concatenate([[0], np.cumsum([len(p) for p in post], dtype=np.int64)]).astype("<u4")
    post_arr = np.fromiter((p for lst in post for p in lst), dtype="<u4", count=int(post_start[-1]))

    sections = [
        pad4(bytes(strings.data)), ent.tobytes(), addr_rec.tobytes(), tok_off.tobytes(),
        pad4(tok_blob), post_start.tobytes(), post_arr.tobytes(), entr_rec.tobytes(),
    ]
    offsets, pos = [], HEADER.size
    for s in sections:
        offsets.append(pos)
        pos += len(s)
    hours_bytes, n_schedules = hours_section(place_hours, pos)
    for s in (hours_bytes, place_rec.tobytes(), cell_rec.tobytes()):
        sections.append(s)
        offsets.append(pos)
        pos += len(s)
    # The entrances' trailer stays last: readers before places find it there.
    trailer = TRAILER.pack(offsets[9], len(place_rec), PLACE_MAGIC) + TRAILER.pack(offsets[7], len(entr_rec), ENTRANCE_MAGIC)
    pos += len(trailer)
    header = HEADER.pack(
        MAGIC, FORMAT, FLAG_ENTRANCES | FLAG_PLACES | FLAG_HOURS, len(ent), n_settlements, len(addr_rec), len(tokens), *offsets[:7],
        osm_date.encode("ascii").ljust(16, b"\0"), int(built_at if built_at is not None else date_stamp(osm_date)), pos,
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(header + b"".join(sections) + trailer)
    tmp.replace(path)
    kinds = Counter(ent["kind"].tolist())
    return {
        "bytes": pos, "entities": len(ent), "places": kinds[KIND_PLACE], "streets": kinds[KIND_STREET],
        "pois": kinds[KIND_POI], "addresses": len(addr_rec), "tokens": len(tokens), "postings": len(post_arr),
        "string_bytes": len(strings.data), "entrances": len(entr_rec),
        "numbered_entrances": int((entr_rec["ref"] != NONE).sum()),
        "stops": len(place_rec), "stop_cells": len(cell_rec) - 1,
        "stop_bytes": len(hours_bytes) + len(place_rec.tobytes()) + len(cell_rec.tobytes()) + TRAILER.size,
        "stops_with_hours": sum(h is not None for h in place_hours), "hours_schedules": n_schedules,
    }


def pad4(b: bytes) -> bytes:
    return b + b"\0" * (-len(b) % 4)


def q6(e7: int) -> int:
    """1e-7° → 1e-6°, rounded (as the graph's q6)."""
    return (int(e7) + 5) // 10


# --- Reading the file back (tests, inspection) ---------------------------------------------


@dataclass
class SearchFile:
    osm_date: str
    built_at: int
    settlements: int
    data: bytes
    entities: np.ndarray
    addresses: np.ndarray
    tokens: list[str]
    post_start: np.ndarray
    postings: np.ndarray
    strings_offset: int
    entrances: np.ndarray  # ENTRANCE_DT, sorted by address (NONE last); empty in a file without them
    places: np.ndarray | None = None  # PLACE_DT, by cell; None in a file without the section
    cells: np.ndarray | None = None  # CELL_DT, ending with (NONE, place count)
    # Opening hours (FLAG_HOURS): each place's schedule (HOURS_NONE: unknown), the schedules' first ranges, the ranges.
    hours_of: np.ndarray | None = None
    hours_first: np.ndarray | None = None
    hours_ranges: np.ndarray | None = None  # (start, end) rows, minutes of the week

    def hours(self, place: int) -> tuple[tuple[int, int], ...] | None:
        """A place's open minutes of the week; None: unknown (or a file without hours)."""
        if self.hours_of is None or self.hours_of[place] == HOURS_NONE:
            return None
        s = int(self.hours_of[place])
        return tuple((int(a), int(e)) for a, e in self.hours_ranges[self.hours_first[s] : self.hours_first[s + 1]])

    def string(self, offset: int) -> str | None:
        if offset == NONE:
            return None
        p = self.strings_offset + offset
        (n,) = struct.unpack_from("<H", self.data, p)
        return self.data[p + 2 : p + 2 + n].decode("utf-8")

    def posting(self, token: str) -> list[int]:
        i = self.tokens.index(token) if token in self.tokens else -1
        return [] if i < 0 else self.postings[self.post_start[i] : self.post_start[i + 1]].tolist()

    def find(self, name: str, kind: int | None = None) -> list[int]:
        return [i for i, e in enumerate(self.entities) if self.string(int(e["name"])) == name and (kind is None or e["kind"] == kind)]

    def houses(self, entity: int) -> list[str]:
        e = self.entities[entity]
        recs = self.addresses[int(e["addr"]) : int(e["addr"]) + int(e["naddr"])]
        return [self.string(int(h)) for h in recs["house"]]


def read_search(path: Path) -> SearchFile:
    data = path.read_bytes()
    (magic, fmt, flags, n_ent, n_settlements, n_addr, n_tok, o_str, o_ent, o_addr, o_toff, o_tblob, o_pstart, o_post,
     date, built, size) = HEADER.unpack_from(data)
    if magic != MAGIC or fmt != FORMAT or size != len(data):
        raise ValueError(f"not a format-{FORMAT} search file: {path}")
    tok_off = np.frombuffer(data, dtype="<u4", count=n_tok + 1, offset=o_toff)
    blob = data[o_tblob : o_tblob + int(tok_off[-1])]
    tokens = [blob[tok_off[i] : tok_off[i + 1]].decode("ascii") for i in range(n_tok)]
    post_start = np.frombuffer(data, dtype="<u4", count=n_tok + 1, offset=o_pstart)
    entrances = np.zeros(0, dtype=ENTRANCE_DT)
    if flags & FLAG_ENTRANCES:
        o_entr, n_entr, entr_magic = TRAILER.unpack_from(data, len(data) - TRAILER.size)
        if entr_magic != ENTRANCE_MAGIC:
            raise ValueError(f"entrance trailer missing: {path}")
        entrances = np.frombuffer(data, dtype=ENTRANCE_DT, count=n_entr, offset=o_entr)
    places = cells = None
    if flags & FLAG_PLACES:
        o_pl, n_pl, pl_magic = TRAILER.unpack_from(data, len(data) - 2 * TRAILER.size)
        if pl_magic != PLACE_MAGIC:
            raise ValueError(f"place trailer missing: {path}")
        places = np.frombuffer(data, dtype=PLACE_DT, count=n_pl, offset=o_pl)
        o_cells = o_pl + n_pl * PLACE_DT.itemsize
        cells = np.frombuffer(data, dtype=CELL_DT, count=(len(data) - 2 * TRAILER.size - o_cells) // CELL_DT.itemsize, offset=o_cells)
    hours_of = hours_first = hours_ranges = None
    if flags & FLAG_HOURS and places is not None:
        o_h, n_h, h_magic = TRAILER.unpack_from(data, o_pl - TRAILER.size)
        if h_magic != HOURS_MAGIC:
            raise ValueError(f"hours footer missing: {path}")
        hours_of = np.frombuffer(data, dtype="<u2", count=len(places), offset=o_h)
        o_first = o_h + 2 * len(places) + (-2 * len(places) % 4)
        hours_first = np.frombuffer(data, dtype="<u4", count=n_h + 1, offset=o_first)
        hours_ranges = np.frombuffer(data, dtype="<u2", count=2 * int(hours_first[-1]), offset=o_first + 4 * (n_h + 1)).reshape(-1, 2)
    return SearchFile(
        date.rstrip(b"\0").decode(), built, n_settlements, data,
        np.frombuffer(data, dtype=ENTITY_DT, count=n_ent, offset=o_ent),
        np.frombuffer(data, dtype=ADDR_DT, count=n_addr, offset=o_addr),
        tokens, post_start,
        np.frombuffer(data, dtype="<u4", count=int(post_start[-1]), offset=o_post),
        o_str, entrances, places, cells, hours_of, hours_first, hours_ranges,
    )


def validate(sf: SearchFile) -> list[str]:
    """Internal consistency; returns problems (empty = valid)."""
    problems: list[str] = []
    n = len(sf.entities)
    if sf.tokens != sorted(sf.tokens) or len(set(sf.tokens)) != len(sf.tokens):
        problems.append("tokens not sorted and unique")
    for i in range(len(sf.tokens)):
        p = sf.postings[sf.post_start[i] : sf.post_start[i + 1]]
        if len(p) == 0 or (np.diff(p.astype(np.int64)) <= 0).any() or p.max() >= n:
            problems.append(f"token {sf.tokens[i]!r}: postings empty, unsorted or out of range")
            break
    e = sf.entities
    if (e["nchild"][sf.settlements :] != 0).any():
        problems.append("children outside the settlements")
    if ((e["addr"].astype(np.int64) + e["naddr"]) > len(sf.addresses)).any():
        problems.append("address range out of bounds")
    has_parent = e["parent"] != NONE
    if (e["parent"][has_parent] >= n).any():
        problems.append("parent out of range")
    else:
        for i in np.flatnonzero(has_parent).tolist():
            p = sf.entities[int(e["parent"][i])]
            if not (p["child"] <= i < p["child"] + p["nchild"]):
                problems.append(f"entity {i} outside its parent's children")
                break
    addr = sf.entrances["address"].astype(np.int64)
    if (np.diff(addr) < 0).any():
        problems.append("entrances not sorted by address")
    if ((addr >= len(sf.addresses)) & (addr != NONE)).any():
        problems.append("entrance address out of range")
    if sf.places is not None:
        problems += validate_places(sf.places, sf.cells)
    if sf.hours_of is not None:
        problems += validate_hours(sf)
    return problems


def validate_hours(sf: SearchFile) -> list[str]:
    """Each place's schedule in the table; each schedule's ranges within the week, ascending and apart; 24/7 the
    flag of the whole week."""
    problems: list[str] = []
    n = len(sf.hours_first) - 1
    of = sf.hours_of.astype(np.int64)
    if ((of >= n) & (of != HOURS_NONE)).any():
        return ["place hours out of the schedules"]
    if sf.hours_first[0] != 0 or (np.diff(sf.hours_first.astype(np.int64)) < 0).any():
        problems.append("hours schedules unordered")
        return problems
    for s in range(n):
        r = sf.hours_ranges[sf.hours_first[s] : sf.hours_first[s + 1]].astype(np.int64).ravel()
        if len(r) and (r[0] < 0 or r[-1] > WEEK_MIN or (np.diff(r) <= 0).any()):
            problems.append(f"hours schedule {s}: ranges outside the week, unordered or touching")
            break
    whole = [i for i in range(len(sf.places)) if sf.hours(i) == ((0, WEEK_MIN),)]
    if any(not sf.places[i]["flags"] & FLAG_24_7 for i in whole):
        problems.append("a place open the whole week without the 24/7 flag")
    return problems


def validate_places(places: np.ndarray, cells: np.ndarray) -> list[str]:
    problems: list[str] = []
    n = len(places)
    if len(cells) == 0 or cells[-1]["key"] != NONE or cells[-1]["first"] != n:
        return ["place cells: no closing entry (NONE, place count)"]
    keys, first = cells["key"].astype(np.int64), cells["first"].astype(np.int64)
    if (np.diff(keys) <= 0).any():
        problems.append("place cells not ascending")
    if (np.diff(first) <= 0).any() or (len(first) > 1 and first[0] != 0):
        problems.append("place cell ranges empty, unordered or not starting at 0")
    if n:
        own = np.repeat(keys[:-1], np.diff(first).clip(0))
        if len(own) != n:
            problems.append("place cell ranges don't cover the places")
        else:
            lat, lon = places["lat"].astype(np.int64), places["lon"].astype(np.int64)
            at = (lat + 90_000_000) // CELL_E6 * CELL_COLS + np.minimum(CELL_COLS - 1, (lon + 180_000_000) // CELL_E6)
            if (at != own).any():
                problems.append(f"{int((at != own).sum())} places outside their cell")
        if ((places["category"] < 1) | (places["category"] > PLACE_CATEGORY_COUNT)).any():
            problems.append("place category out of 1–6")
    return problems


# --- Entry point --------------------------------------------------------------------------


def build_region_search(pbf: Path, output: Path, osm_date: str) -> dict[str, int]:
    t0 = time.monotonic()
    raw = read_objects(pbf)
    t1 = time.monotonic()
    entities = build_index(raw)
    t2 = time.monotonic()
    stats = write_index(entities, output, osm_date, loose_entrances=[e for e in raw.entrances if not e.owned], stops=raw.stops)
    t3 = time.monotonic()
    log(f"{output.name}: {stats['bytes'] / 1e6:.1f} MB, {stats['places']} places, {stats['streets']} streets, "
        f"{stats['addresses']} addresses, {stats['pois']} POIs, {stats['tokens']} tokens, "
        f"{stats['entrances']} entrances ({stats['numbered_entrances']} numbered), {stats['stops']} places to stop "
        f"({stats['stops_with_hours']} with hours, {stats['hours_schedules']} schedules; {stats['stop_bytes'] / 1e3:.0f} kB); "
        f"read {t1 - t0:.0f} s, build {t2 - t1:.0f} s, write {t3 - t2:.0f} s")
    return stats
