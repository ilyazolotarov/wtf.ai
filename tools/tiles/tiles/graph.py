"""Road graph for map matching (MAPMATCH-SPEC §4): <region>.graph.bin.

Two passes over the region's extract with pyosmium: drivable ways and turn-restriction
relations first, then the locations of only the nodes those ways use (no location index of
every node, so Ukraine fits in memory). Ways are split at graph nodes (way ends, shared nodes,
nodes a way visits twice) into undirected edges, simplified to 1 m, and written as a tiled
binary file that the app reads by random access:

    header      64 B: magic "WTFG", format, zoom, tile range, counts, OSM date, build time, features
    directory   u32[nx·ny + 1] tile blob offsets (relative to the data start)
    tiles       per non-empty tile: nodes, incidence, edges, geometry, restrictions, spatial

Ids are (tile index, local index); tile index = (y − y0)·nx + (x − x0) at `ZOOM`. An edge
lives in the tile of its first node (way order), a node in the tile that contains it.

Speed attributes (ROUTING-SPEC §4.1, `FEATURE_ATTRIBUTES`; files before 2026-10-10 lack them and
readers fall back to the road class): each edge's speed limit in what was its padding byte, flags
for unpaved, urban and a traffic light along it, and node flags for junctions with traffic lights
or stop / give-way signs. A third pass reads settlements (place points and areas, built-up landuse)
for the urban flag.
"""

from __future__ import annotations

import math
import re
import struct
import time
from array import array
from collections import defaultdict
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import osmium
import shapely

from .region import read_poly

ZOOM = 14
FORMAT = 1
MAGIC = b"WTFG"
HEADER = struct.Struct("<4sHHIIIIIIII16sII")  # 64 bytes
TILE_HEADER = struct.Struct("<6I")
SIMPLIFY_M = 1.0
EARTH_R = 6_371_008.8

CLASSES = {
    "motorway": 0, "trunk": 1, "primary": 2, "secondary": 3, "tertiary": 4,
    "unclassified": 5, "residential": 6, "living_street": 7, "service": 8, "track": 9, "road": 10,
}
LINKED = ("motorway", "trunk", "primary", "secondary", "tertiary")

ONEWAY_NONE, ONEWAY_FORWARD, ONEWAY_BACKWARD = 0, 1, 2

LINK, ROUNDABOUT, TUNNEL, BRIDGE, PRIVATE, MINOR_SERVICE = 1, 2, 4, 8, 16, 32
# Speed attributes: UNPAVED, URBAN and SIGNALS mean something only on an edge with ATTRIBUTES.
UNPAVED, URBAN, SIGNALS, ATTRIBUTES, CITY, BIG_CITY = 64, 128, 256, 512, 1024, 2048
NODE_BOUNDARY, NODE_DEAD_END, NODE_SIGNALS, NODE_STOP = 1, 2, 4, 8
RESTRICT_NO, RESTRICT_ONLY = 1, 2
FEATURE_ATTRIBUTES = 1

UNPAVED_SURFACES = {
    "unpaved", "gravel", "fine_gravel", "compacted", "dirt", "earth", "ground", "grass", "sand", "mud", "pebblestone",
}
# Implicit limits (Ukrainian traffic rules §12.4–12.6; RU: in Crimea and old imports).
MAXSPEED_NAMED = {
    "UA:urban": 50, "UA:rural": 90, "UA:trunk": 110, "UA:motorway": 130, "UA:living_street": 20,
    "RU:urban": 60, "RU:rural": 90, "RU:motorway": 110, "RU:living_street": 20, "walk": 5,
}
MAXSPEED_RE = re.compile(r"^(\d+(?:\.\d+)?)\s*(mph|km/h|kmh)?$")
# A traffic light or stop sign this close to a junction (along the way) controls it: OSM maps them
# on the junction node or at the stop line before it.
CONTROL_NODE_M = 40.0
# Urban: within a place area, this close to built-up landuse, or this close to a place point.
URBAN_LANDUSE = {"residential", "commercial", "retail"}
URBAN_LANDUSE_M = 100.0
URBAN_PLACE_M = {"city": 4000.0, "town": 1500.0, "village": 600.0, "hamlet": 300.0}
# Rush hours slow traffic in cities this big (ROUTING-SPEC §4.3): a smaller city's evening peak drove free-flowing.
BIG_CITY_POPULATION = 500_000

# Access precedence: the most specific key present wins.
ACCESS_KEYS = ("motorcar", "motor_vehicle", "vehicle", "access")
ACCESS_OPEN = {"yes", "designated", "permissive", "destination", "customers", "official", "unknown"}
MINOR_SERVICES = {"driveway", "parking_aisle", "drive-through", "emergency_access"}

NODE_DT = np.dtype([("lon", "<i4"), ("lat", "<i4"), ("inc", "<u4"), ("ninc", "<u2"), ("flags", "<u2")])
REF_DT = np.dtype([("tile", "<u4"), ("idx", "<u2"), ("end", "<u2")])
EDGE_DT = np.dtype([
    ("from", "<u2"), ("cls", "u1"), ("oneway", "u1"), ("flags", "<u2"), ("nvert", "<u2"),
    ("to_tile", "<u4"), ("to_idx", "<u2"), ("maxspeed", "u1"), ("pad", "u1"),
    ("length", "<f4"), ("geom", "<u4"), ("way", "<u4"),
])
VERT_DT = np.dtype([("lon", "<i4"), ("lat", "<i4")])
RESTR_DT = np.dtype([
    ("via", "<u2"), ("kind", "u1"), ("pad", "u1"),
    ("from_tile", "<u4"), ("from_idx", "<u2"), ("pad2", "<u2"),
    ("to_tile", "<u4"), ("to_idx", "<u2"), ("pad3", "<u2"),
])
assert (NODE_DT.itemsize, REF_DT.itemsize, EDGE_DT.itemsize, VERT_DT.itemsize, RESTR_DT.itemsize) == (16, 8, 28, 8, 20)
assert HEADER.size == 64


def log(msg: str) -> None:
    print(f"[graph] {msg}", flush=True)


# --- OSM tag rules (MAPMATCH-SPEC §4.1, §4.3) ---------------------------------------------


@dataclass(frozen=True)
class RoadAttrs:
    cls: int
    oneway: int
    flags: int
    maxspeed: int = 0  # km/h, 0: not tagged


def road_attrs(tags: Mapping[str, str]) -> RoadAttrs | None:
    """Class, one-way and flags of a drivable way; None when the way isn't kept."""
    highway = tags.get("highway")
    flags = 0
    if highway in CLASSES:
        cls = CLASSES[highway]
    elif highway and highway.endswith("_link") and highway[:-5] in LINKED:
        cls, flags = CLASSES[highway[:-5]], LINK
    else:
        return None
    if tags.get("area") == "yes":
        return None
    access = next((tags.get(k) for k in ACCESS_KEYS if tags.get(k)), None)
    if access is not None:
        values = {v.strip() for v in access.split(";")}
        if values == {"no"}:
            return None
        if not values & ACCESS_OPEN:
            flags |= PRIVATE
    junction = tags.get("junction")
    if junction in ("roundabout", "circular"):
        flags |= ROUNDABOUT
    if tags.get("tunnel") not in (None, "no"):
        flags |= TUNNEL
    if tags.get("bridge") not in (None, "no"):
        flags |= BRIDGE
    if highway == "service" and tags.get("service") in MINOR_SERVICES:
        flags |= MINOR_SERVICE
    if tags.get("surface") in UNPAVED_SURFACES:
        flags |= UNPAVED
    return RoadAttrs(cls, oneway_of(tags, highway, flags), flags | ATTRIBUTES, maxspeed_kph(tags))


def maxspeed_kph(tags: Mapping[str, str]) -> int:
    """The way's speed limit, km/h (`maxspeed`, else the forward one); 0 when untagged or unreadable."""
    value = tags.get("maxspeed") or tags.get("maxspeed:forward") or tags.get("maxspeed:backward")
    if not value:
        return 0
    value = value.strip()
    if value in MAXSPEED_NAMED:
        return MAXSPEED_NAMED[value]
    m = MAXSPEED_RE.match(value)
    if not m:
        return 0  # "none", "signals", "50;30", …
    kph = float(m.group(1)) * (1.609344 if m.group(2) == "mph" else 1.0)
    return int(min(250, max(1, round(kph))))


def oneway_of(tags: Mapping[str, str], highway: str, flags: int) -> int:
    value = tags.get("oneway")
    if value in ("yes", "1", "true"):
        return ONEWAY_FORWARD
    if value in ("-1", "reverse"):
        return ONEWAY_BACKWARD
    if value is None and (flags & ROUNDABOUT or highway == "motorway"):
        return ONEWAY_FORWARD
    return ONEWAY_NONE  # "no", "reversible", "alternating", unknown


def restriction_kind(tags: Mapping[str, str]) -> int | None:
    """RESTRICT_NO / RESTRICT_ONLY for a turn restriction that applies to cars, else None."""
    if tags.get("type") != "restriction":
        return None
    value = tags.get("restriction:motorcar") or tags.get("restriction")
    if not value:
        return None
    if "motorcar" in {v.strip() for v in tags.get("except", "").split(";")}:
        return None
    if value.startswith("no_"):
        return RESTRICT_NO
    if value.startswith("only_"):
        return RESTRICT_ONLY
    return None


# --- Reading ------------------------------------------------------------------------------


@dataclass
class Roads:
    way_ids: np.ndarray  # int64[W]
    offsets: np.ndarray  # int64[W + 1] into refs
    refs: np.ndarray  # int64 node ids, consecutive duplicates removed
    cls: np.ndarray  # uint8[W]
    oneway: np.ndarray  # uint8[W]
    flags: np.ndarray  # uint16[W]
    maxspeed: np.ndarray  # uint8[W], km/h, 0: untagged
    restrictions: list[tuple[int, int, int, int]]  # (from way, via node, to way, kind)
    skipped_restrictions: int


def read_roads(pbf: Path) -> Roads:
    """Pass 1: drivable ways and turn restrictions with a via node."""
    way_ids, offsets, refs = array("q"), array("q", [0]), array("q")
    cls, oneway, flags, maxspeed = array("B"), array("B"), array("H"), array("B")
    restrictions: list[tuple[int, int, int, int]] = []
    skipped = 0
    fp = osmium.FileProcessor(str(pbf), osmium.osm.WAY | osmium.osm.RELATION).with_filter(
        osmium.filter.KeyFilter("highway", "type")
    )
    for obj in fp:
        if obj.is_way():
            attrs = road_attrs(obj.tags)
            if attrs is None:
                continue
            nodes = [n.ref for n in obj.nodes]
            nodes = [r for i, r in enumerate(nodes) if i == 0 or r != nodes[i - 1]]
            if len(nodes) < 2:
                continue
            way_ids.append(obj.id)
            refs.extend(nodes)
            offsets.append(len(refs))
            cls.append(attrs.cls)
            oneway.append(attrs.oneway)
            flags.append(attrs.flags)
            maxspeed.append(attrs.maxspeed)
        elif obj.is_relation():
            kind = restriction_kind(obj.tags)
            if kind is None:
                continue
            members = {(m.role, m.type): m.ref for m in obj.members}
            frm, via, to = members.get(("from", "w")), members.get(("via", "n")), members.get(("to", "w"))
            if frm is None or via is None or to is None:
                skipped += 1  # via-way restrictions and broken relations
                continue
            restrictions.append((frm, via, to, kind))
    return Roads(
        np.frombuffer(way_ids, dtype=np.int64).copy(),
        np.frombuffer(offsets, dtype=np.int64).copy(),
        np.frombuffer(refs, dtype=np.int64).copy(),
        np.frombuffer(cls, dtype=np.uint8).copy(),
        np.frombuffer(oneway, dtype=np.uint8).copy(),
        np.frombuffer(flags, dtype=np.uint16).copy(),
        np.frombuffer(maxspeed, dtype=np.uint8).copy(),
        restrictions,
        skipped,
    )


@dataclass
class Locations:
    ids: np.ndarray  # int64, sorted
    lon: np.ndarray  # int32, 1e-7°
    lat: np.ndarray
    signals: np.ndarray  # ids of traffic lights (junction lights and signalled crossings)
    stops: np.ndarray  # ids of stop and give-way signs


def read_locations(pbf: Path, node_ids: np.ndarray) -> Locations:
    """Pass 2: locations (sorted by id, 1e-7°) of the given nodes that exist, and which of them
    are traffic lights or stop / give-way signs."""
    tracker = osmium.IdTracker()
    for node_id in node_ids.tolist():
        tracker.add_node(node_id)
    ids, lon, lat, signals, stops = array("q"), array("i"), array("i"), array("q"), array("q")
    for node in osmium.FileProcessor(str(pbf), osmium.osm.NODE).with_filter(tracker.id_filter()):
        loc = node.location
        if loc.valid():
            ids.append(node.id)
            lon.append(loc.x)
            lat.append(loc.y)
            highway = node.tags.get("highway")
            if highway == "traffic_signals" or (highway == "crossing" and node.tags.get("crossing") == "traffic_signals"):
                signals.append(node.id)
            elif highway in ("stop", "give_way"):
                stops.append(node.id)
    ids_a = np.frombuffer(ids, dtype=np.int64)
    order = np.argsort(ids_a, kind="stable")
    return Locations(
        ids_a[order], np.frombuffer(lon, dtype=np.int32)[order], np.frombuffer(lat, dtype=np.int32)[order],
        np.frombuffer(signals, dtype=np.int64).copy(), np.frombuffer(stops, dtype=np.int64).copy(),
    )


@dataclass
class Settlements:
    """What makes a road urban: place points by kind, place areas and built-up landuse (lon/lat °),
    and the population of each place=city point and area (NaN: untagged)."""
    points: dict[str, np.ndarray]  # kind → float64[n, 2]
    areas: list  # shapely geometries
    landuse: list
    city_areas: list = field(default_factory=list)  # the place=city ones among `areas`
    city_population: np.ndarray = field(default_factory=lambda: np.zeros(0))  # per points["city"]
    city_area_population: np.ndarray = field(default_factory=lambda: np.zeros(0))  # per city_areas


def population(tags: Mapping[str, str]) -> float:
    """The `population` tag (digits, spaces and separators allowed), NaN when absent or unreadable."""
    digits = re.sub(r"[\s,.']", "", tags.get("population") or "")
    return float(digits) if digits.isdigit() else math.nan


def read_settlements(pbf: Path) -> Settlements:
    """Pass 3: place=city/town/village/hamlet points and areas, residential/commercial/retail landuse."""
    points: dict[str, list[tuple[float, float]]] = {k: [] for k in URBAN_PLACE_M}
    areas, landuse, city_areas = [], [], []
    city_pop, city_area_pop = [], []
    wkb = osmium.geom.WKBFactory()
    keep = osmium.filter.TagFilter(*[("place", k) for k in URBAN_PLACE_M], *[("landuse", k) for k in URBAN_LANDUSE])
    fp = osmium.FileProcessor(str(pbf)).with_areas(keep).with_filter(osmium.filter.KeyFilter("place", "landuse"))
    for obj in fp:
        if obj.is_node():
            kind = obj.tags.get("place")
            if kind in points and obj.location.valid():
                points[kind].append((obj.location.lon, obj.location.lat))
                if kind == "city":
                    city_pop.append(population(obj.tags))
        elif obj.is_area():
            try:
                geom = shapely.from_wkb(wkb.create_multipolygon(obj))
            except RuntimeError:
                continue  # broken multipolygon
            place = obj.tags.get("place")
            (areas if place in URBAN_PLACE_M else landuse).append(geom)
            if place == "city":
                city_areas.append(geom)
                city_area_pop.append(population(obj.tags))
    return Settlements(
        {k: np.array(v, dtype=np.float64).reshape(-1, 2) for k, v in points.items()}, areas, landuse, city_areas,
        np.array(city_pop, dtype=np.float64), np.array(city_area_pop, dtype=np.float64),
    )


def city_radius_m(population: np.ndarray) -> np.ndarray:
    """How far a city reaches from its point: `URBAN_PLACE_M["city"]` for 300 000 people, the area growing with the
    population (Kyiv ~12 km), within 3–15 km; untagged cities the plain radius."""
    r = URBAN_PLACE_M["city"] * np.sqrt(np.nan_to_num(population, nan=300_000.0) / 300_000.0)
    return np.clip(r, 3000.0, 15_000.0)


def urban_mask(lon: np.ndarray, lat: np.ndarray, s: Settlements) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(urban, city, big city) for points (°). Urban: in a place area, near built-up landuse or near
    a place point; scored on the main roads with a tagged limit (≤ 60 urban, ≥ 80 rural): 80 % right
    in the test oblast, 86 % in Kyiv oblast (ROUTING-SPEC §4.1). City: in a place=city area or near
    its point (`city_radius_m`). Big city: one of `BIG_CITY_POPULATION` or more, where rush hours
    slow traffic. Distances in a local frame (x scaled by the cosine of the mean latitude)."""
    urban = np.zeros(len(lon), dtype=bool)
    city = np.zeros(len(lon), dtype=bool)
    big = np.zeros(len(lon), dtype=bool)
    if not len(lon):
        return urban, city, big
    k = math.cos(math.radians(float(np.mean(lat))))
    to_m = EARTH_R * math.pi / 180
    pts = shapely.points(lon * k, lat)
    local = lambda geoms: [shapely.transform(g, lambda xy: xy * [k, 1.0]) for g in geoms]  # noqa: E731
    if s.areas:
        urban[np.unique(shapely.STRtree(local(s.areas)).query(pts, predicate="intersects")[0])] = True
    if s.city_areas:
        hit = shapely.STRtree(local(s.city_areas)).query(pts, predicate="intersects")
        city[np.unique(hit[0])] = True
        pop = s.city_area_population if len(s.city_area_population) == len(s.city_areas) else np.full(len(s.city_areas), np.nan)
        big[np.unique(hit[0][pop[hit[1]] >= BIG_CITY_POPULATION])] = True
    if s.landuse:
        hit = shapely.STRtree(local(s.landuse)).query(pts, predicate="dwithin", distance=URBAN_LANDUSE_M / to_m)
        urban[np.unique(hit[0])] = True
    for kind, radius in URBAN_PLACE_M.items():
        p = s.points.get(kind)
        if p is None or not len(p):
            continue
        tree = shapely.STRtree(shapely.points(p[:, 0] * k, p[:, 1]))
        if kind != "city":
            urban[np.unique(tree.query(pts, predicate="dwithin", distance=radius / to_m)[0])] = True
            continue
        pop = s.city_population if len(s.city_population) == len(p) else np.full(len(p), np.nan)
        reach = city_radius_m(pop)
        hit = tree.query(pts, predicate="dwithin", distance=float(reach.max()) / to_m)
        d = shapely.distance(pts[hit[0]], shapely.points(p[hit[1], 0] * k, p[hit[1], 1])) * to_m
        inside = d <= reach[hit[1]]
        city[np.unique(hit[0][inside])] = True
        big[np.unique(hit[0][inside & (pop[hit[1]] >= BIG_CITY_POPULATION)])] = True
    return urban | city, city, big


# --- Topology -----------------------------------------------------------------------------


def tile_xy(lon_deg: np.ndarray, lat_deg: np.ndarray, zoom: int = ZOOM) -> tuple[np.ndarray, np.ndarray]:
    """Fractional Web Mercator tile coordinates."""
    n = 1 << zoom
    lat = np.radians(lat_deg)
    x = (lon_deg + 180.0) / 360.0 * n
    y = (1.0 - np.log(np.tan(lat) + 1.0 / np.cos(lat)) / math.pi) / 2.0 * n
    return x, y


@dataclass
class Graph:
    zoom: int
    x0: int
    y0: int
    nx: int
    ny: int
    # nodes
    node_ids: np.ndarray  # OSM ids
    node_lon: np.ndarray  # 1e-7°
    node_lat: np.ndarray
    node_flags: np.ndarray
    # edges (undirected; geometry in way direction)
    edge_way: np.ndarray  # OSM way id
    edge_from: np.ndarray  # node index
    edge_to: np.ndarray
    edge_cls: np.ndarray
    edge_oneway: np.ndarray
    edge_flags: np.ndarray
    edge_maxspeed: np.ndarray  # km/h, 0: untagged
    edge_length: np.ndarray  # m, unsimplified
    edge_vert: np.ndarray  # int64[E + 1] offsets into vert_lon/vert_lat (simplified)
    vert_lon: np.ndarray  # 1e-7°
    vert_lat: np.ndarray
    restrictions: list[tuple[int, int, int, int]]  # (via node, kind, from edge, to edge)
    stats: dict[str, int]


def split_ways(roads: Roads, loc_ids: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Edges as (way index, start, end) positions in roads.refs (inclusive). A loop with one
    graph node is split in the middle; a node missing from the extract splits its way there."""
    refs = roads.refs
    pos = np.searchsorted(loc_ids, refs)
    pos[pos >= len(loc_ids)] = 0
    located = loc_ids[pos] == refs if len(loc_ids) else np.zeros(len(refs), dtype=bool)
    # Graph nodes: used ≥ 2 times over all kept ways (shared, or visited twice by one way —
    # including the closing node of a closed way) plus every way end.
    _, inverse, counts = np.unique(refs, return_inverse=True, return_counts=True)
    is_node = counts[inverse] >= 2
    starts, ends = roads.offsets[:-1], roads.offsets[1:] - 1
    is_node[starts] = True
    is_node[ends] = True

    e_way, e_start, e_end = array("q"), array("q"), array("q")
    for w in range(len(roads.way_ids)):
        a, b = int(starts[w]), int(ends[w])
        ok = located[a : b + 1]
        if not ok.all():
            runs = np.split(np.arange(a, b + 1), np.flatnonzero(np.diff(ok.astype(np.int8))) + 1)
            pieces = [(int(r[0]), int(r[-1])) for r in runs if located[r[0]] and len(r) >= 2]
        else:
            pieces = [(a, b)]
        for pa, pb in pieces:
            cuts = (np.flatnonzero(is_node[pa : pb + 1]) + pa).tolist()
            if cuts[0] != pa:
                cuts.insert(0, pa)
            if cuts[-1] != pb:
                cuts.append(pb)
            for s, e in zip(cuts, cuts[1:]):
                if refs[s] == refs[e]:
                    # Self-loop (a closed way with one graph node): split in the middle.
                    mid = (s + e) // 2
                    e_way.extend((w, w))
                    e_start.extend((s, mid))
                    e_end.extend((mid, e))
                else:
                    e_way.append(w)
                    e_start.append(s)
                    e_end.append(e)
    return tuple(np.frombuffer(a, dtype=np.int64).copy() for a in (e_way, e_start, e_end))


def build_graph(roads: Roads, loc: Locations, region_poly, zoom: int = ZOOM, settlements: Settlements | None = None) -> Graph:
    loc_ids, loc_lon, loc_lat = loc.ids, loc.lon, loc.lat
    e_way, e_start, e_end = split_ways(roads, loc_ids)
    refs = roads.refs

    node_ids = np.unique(np.concatenate([refs[e_start], refs[e_end]]))
    li = np.searchsorted(loc_ids, node_ids)
    node_lon, node_lat = loc_lon[li], loc_lat[li]
    edge_from = np.searchsorted(node_ids, refs[e_start])
    edge_to = np.searchsorted(node_ids, refs[e_end])

    # Full-resolution vertices per edge.
    counts = e_end - e_start + 1
    first = np.cumsum(counts) - counts
    vert_ref = refs[np.repeat(e_start - first, counts) + np.arange(counts.sum())]
    vi = np.searchsorted(loc_ids, vert_ref)
    vlon, vlat = loc_lon[vi].astype(np.float64), loc_lat[vi].astype(np.float64)
    del vert_ref, vi
    length, cum = edge_lengths(vlon, vlat, counts)
    edge_flags = roads.flags[e_way].copy()
    # Urban: the edge's middle (the full-resolution vertex nearest half its length).
    mid = np.clip(np.searchsorted(cum, cum[first] + length / 2), first, first + counts - 1)
    if settlements is not None:
        urban, city, big = urban_mask(vlon[mid] * 1e-7, vlat[mid] * 1e-7, settlements)
        edge_flags[urban] |= URBAN
        edge_flags[city] |= CITY
        edge_flags[big] |= BIG_CITY
    vert_lon, vert_lat, edge_vert = simplify_edges(vlon, vlat, counts)
    del vlon, vlat, mid

    # Node flags.
    degree = np.bincount(edge_from, minlength=len(node_ids)) + np.bincount(edge_to, minlength=len(node_ids))
    node_flags = np.where(degree == 1, NODE_DEAD_END, 0).astype(np.uint16)
    inside = shapely.contains_xy(region_poly, node_lon * 1e-7, node_lat * 1e-7)
    node_flags[~inside] |= NODE_BOUNDARY
    controls = map_controls(refs, node_ids, degree, e_start, e_end, first, counts, cum, edge_from, edge_to,
                            loc.signals, loc.stops)
    node_flags |= controls[0]
    edge_flags[controls[1]] |= SIGNALS
    del cum

    # Tile range over all vertices.
    tx, ty = tile_xy(vert_lon * 1e-7, vert_lat * 1e-7, zoom)
    x0, y0 = int(np.floor(tx.min())), int(np.floor(ty.min()))
    nx, ny = int(np.floor(tx.max())) - x0 + 1, int(np.floor(ty.max())) - y0 + 1

    restrictions, skipped = map_restrictions(roads, node_ids, e_way, edge_from, edge_to)
    stats = {
        "ways": len(roads.way_ids), "nodes": len(node_ids), "edges": len(e_way),
        "vertices": int(counts.sum()), "vertices_simplified": len(vert_lon),
        "restrictions": len(restrictions), "restrictions_skipped": roads.skipped_restrictions + skipped,
        "boundary_nodes": int((~inside).sum()), "dead_ends": int((degree == 1).sum()),
        "urban_edges": int((edge_flags & URBAN != 0).sum()), "city_edges": int((edge_flags & CITY != 0).sum()),
        "big_city_edges": int((edge_flags & BIG_CITY != 0).sum()),
        "maxspeed_edges": int((roads.maxspeed[e_way] > 0).sum()),
        "signal_nodes": int((node_flags & NODE_SIGNALS != 0).sum()), "signal_edges": int((edge_flags & SIGNALS != 0).sum()),
        "stop_nodes": int((node_flags & NODE_STOP != 0).sum()),
    }
    return Graph(
        zoom, x0, y0, nx, ny,
        node_ids, node_lon, node_lat, node_flags,
        roads.way_ids[e_way], edge_from, edge_to,
        roads.cls[e_way], roads.oneway[e_way], edge_flags, roads.maxspeed[e_way], length,
        edge_vert, vert_lon, vert_lat, restrictions, stats,
    )


def map_controls(refs, node_ids, degree, e_start, e_end, first, counts, cum, edge_from, edge_to, signals, stops):
    """(node flags, edges with a traffic light along them). A light or sign on a graph node marks
    it; one on a way within `CONTROL_NODE_M` of a junction (3+ edges) marks that junction (the stop
    line before it); a light farther from any junction (a signalled crossing) marks its edge.
    Signs away from junctions are dropped."""
    node_flags = np.zeros(len(node_ids), dtype=np.uint16)
    signal_edges = np.zeros(len(e_start), dtype=bool)
    for ids, flag in ((signals, NODE_SIGNALS), (stops, NODE_STOP)):
        if not len(ids):
            continue
        pos = np.flatnonzero(np.isin(refs, ids))
        n = np.searchsorted(node_ids, refs[pos])
        is_node = (n < len(node_ids)) & (node_ids[np.minimum(n, len(node_ids) - 1)] == refs[pos])
        node_flags[n[is_node]] |= flag
        p = pos[~is_node]
        e = np.searchsorted(e_start, p, side="right") - 1
        ok = (e >= 0) & (p < e_end[np.maximum(e, 0)])
        p, e = p[ok], e[ok]
        v = first[e] + (p - e_start[e])
        from_m, to_m = cum[v] - cum[first[e]], cum[first[e] + counts[e] - 1] - cum[v]
        at_from = (from_m <= to_m) & (from_m <= CONTROL_NODE_M) & (degree[edge_from[e]] >= 3)
        at_to = ~at_from & (to_m <= CONTROL_NODE_M) & (degree[edge_to[e]] >= 3)
        node_flags[edge_from[e[at_from]]] |= flag
        node_flags[edge_to[e[at_to]]] |= flag
        if flag == NODE_SIGNALS:
            signal_edges[e[~at_from & ~at_to]] = True
    return node_flags, signal_edges


def edge_lengths(vlon: np.ndarray, vlat: np.ndarray, counts: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Haversine length (m) of each edge's full-resolution geometry (vertices in 1e-7°), and the
    distance along all vertices (monotonic; differences within an edge are along it)."""
    lon, lat = np.radians(vlon * 1e-7), np.radians(vlat * 1e-7)
    h = np.sin(np.diff(lat) / 2) ** 2 + np.cos(lat[:-1]) * np.cos(lat[1:]) * np.sin(np.diff(lon) / 2) ** 2
    seg = 2 * EARTH_R * np.arcsin(np.sqrt(np.minimum(h, 1.0)))
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    last = np.cumsum(counts) - 1
    return cum[last] - cum[last - counts + 1], cum


def simplify_edges(vlon: np.ndarray, vlat: np.ndarray, counts: np.ndarray, chunk: int = 200_000):
    """Douglas–Peucker at SIMPLIFY_M in a local metric frame per edge (x scaled by the cosine
    of the edge's first latitude). Kept vertices are original ones, recovered exactly from the
    scaled coordinates. In chunks of edges: GEOS geometries for all of Ukraine at once need
    ~9 GB. Returns (lon, lat) in 1e-7° and per-edge offsets."""
    ky = EARTH_R * math.pi / 180 * 1e-7
    first = np.cumsum(counts) - counts
    out_lon, out_lat, out_n = [], [], []
    for c0 in range(0, len(counts), chunk):
        c1 = min(c0 + chunk, len(counts))
        a, b = int(first[c0]), int(first[c1 - 1] + counts[c1 - 1])
        n = counts[c0:c1]
        edge = np.repeat(np.arange(c1 - c0), n)
        kx = ky * np.cos(np.radians(vlat[first[c0:c1]] * 1e-7))
        x, y = vlon[a:b] * kx[edge], vlat[a:b] * ky
        lines = shapely.linestrings(np.column_stack([x, y]), indices=edge)
        coords, s_edge = shapely.get_coordinates(
            shapely.simplify(lines, SIMPLIFY_M, preserve_topology=False), return_index=True
        )
        s_n = np.bincount(s_edge, minlength=c1 - c0)
        lon = np.rint(coords[:, 0] / kx[s_edge]).astype(np.int64)
        lat = np.rint(coords[:, 1] / ky).astype(np.int64)
        bad = np.flatnonzero(s_n < 2)
        if bad.size:
            # Zero-length edges (distinct nodes at one position) collapse: keep both ends.
            keep = ~np.isin(s_edge, bad)
            ends = np.concatenate([[first[c0 + e] - a, first[c0 + e] - a + counts[c0 + e] - 1] for e in bad.tolist()])
            s_edge = np.concatenate([s_edge[keep], np.repeat(bad, 2)])
            lon = np.concatenate([lon[keep], vlon[a:b][ends].astype(np.int64)])
            lat = np.concatenate([lat[keep], vlat[a:b][ends].astype(np.int64)])
            order = np.argsort(s_edge, kind="stable")
            lon, lat = lon[order], lat[order]
            s_n = np.bincount(s_edge, minlength=c1 - c0)
        out_lon.append(lon)
        out_lat.append(lat)
        out_n.append(s_n)
    n_all = np.concatenate(out_n) if out_n else np.zeros(0, np.int64)
    edge_vert = np.concatenate([[0], np.cumsum(n_all)]).astype(np.int64)
    empty = np.zeros(0, np.int64)
    return (np.concatenate(out_lon) if out_lon else empty), (np.concatenate(out_lat) if out_lat else empty), edge_vert


def map_restrictions(roads: Roads, node_ids, e_way, edge_from, edge_to) -> tuple[list[tuple[int, int, int, int]], int]:
    """(via node, kind, from edge, to edge). The from/to edge is the piece of the way that
    touches the via node; dropped when the via node isn't a graph node or that is ambiguous
    (the way passes through the via node)."""
    way_index = {int(w): i for i, w in enumerate(roads.way_ids)}
    via_ids = {r[1] for r in roads.restrictions}
    pos = np.searchsorted(node_ids, np.fromiter(via_ids, dtype=np.int64, count=len(via_ids)))
    via_node = {}
    for vid, p in zip(via_ids, pos.tolist()):
        if p < len(node_ids) and node_ids[p] == vid:
            via_node[vid] = p
    touching: dict[tuple[int, int], list[int]] = defaultdict(list)
    via_set = set(via_node.values())
    for e, (w, a, b) in enumerate(zip(e_way.tolist(), edge_from.tolist(), edge_to.tolist())):
        for n in {a, b}:
            if n in via_set:
                touching[(w, n)].append(e)
    out, skipped = [], 0
    for frm, via, to, kind in roads.restrictions:
        n = via_node.get(via)
        fw, tw = way_index.get(frm), way_index.get(to)
        if n is None or fw is None or tw is None:
            skipped += 1
            continue
        fe, te = touching.get((fw, n), []), touching.get((tw, n), [])
        if len(fe) != 1 or len(te) != 1:
            skipped += 1
            continue
        out.append((n, kind, fe[0], te[0]))
    return out, skipped


# --- Spatial ------------------------------------------------------------------------------


def segment_tiles(ax: float, ay: float, bx: float, by: float) -> list[tuple[int, int]]:
    """Every tile a straight segment in tile coordinates passes through (grid traversal)."""
    x, y = int(math.floor(ax)), int(math.floor(ay))
    ex, ey = int(math.floor(bx)), int(math.floor(by))
    out = [(x, y)]
    dx, dy = bx - ax, by - ay
    sx, sy = (1 if dx > 0 else -1), (1 if dy > 0 else -1)
    tdx = abs(1 / dx) if dx else math.inf
    tdy = abs(1 / dy) if dy else math.inf
    tmx = ((x + 1 - ax) if dx > 0 else (ax - x)) * tdx if dx else math.inf
    tmy = ((y + 1 - ay) if dy > 0 else (ay - y)) * tdy if dy else math.inf
    while (x, y) != (ex, ey) and len(out) < 100_000:
        if tmx < tmy:
            x, tmx = x + sx, tmx + tdx
        else:
            y, tmy = y + sy, tmy + tdy
        out.append((x, y))
    return out


def edge_tiles(g: Graph) -> tuple[np.ndarray, np.ndarray]:
    """(edge, tile index) for every tile an edge's simplified geometry crosses."""
    tx, ty = tile_xy(g.vert_lon * 1e-7, g.vert_lat * 1e-7, g.zoom)
    tile = (np.floor(ty).astype(np.int64) - g.y0) * g.nx + (np.floor(tx).astype(np.int64) - g.x0)
    first = g.edge_vert[:-1]
    n = np.diff(g.edge_vert)
    edge_of = np.repeat(np.arange(len(n)), n)
    differs = np.zeros(len(n), dtype=bool)
    np.logical_or.at(differs, edge_of, tile != tile[first][edge_of])
    single = np.flatnonzero(~differs)
    edges, tiles = [single], [tile[first[single]]]
    multi_e, multi_t = array("q"), array("q")
    for e in np.flatnonzero(differs).tolist():
        seen: set[int] = set()
        for i in range(int(g.edge_vert[e]), int(g.edge_vert[e + 1]) - 1):
            for x, y in segment_tiles(tx[i], ty[i], tx[i + 1], ty[i + 1]):
                if 0 <= x - g.x0 < g.nx and 0 <= y - g.y0 < g.ny:
                    seen.add((y - g.y0) * g.nx + (x - g.x0))
        multi_e.extend([e] * len(seen))
        multi_t.extend(sorted(seen))
    edges.append(np.frombuffer(multi_e, dtype=np.int64))
    tiles.append(np.frombuffer(multi_t, dtype=np.int64))
    e_all, t_all = np.concatenate(edges), np.concatenate(tiles)
    order = np.lexsort((e_all, t_all))
    return e_all[order], t_all[order]


# --- Writing ------------------------------------------------------------------------------


def write_graph(g: Graph, path: Path, osm_date: str, built_at: int | None = None) -> dict[str, int]:
    """Write the tiled file; returns size stats."""
    nx, ny = g.nx, g.ny

    def tile_of(lon, lat):
        tx, ty = tile_xy(lon * 1e-7, lat * 1e-7, g.zoom)
        return (np.floor(ty).astype(np.int64) - g.y0) * nx + (np.floor(tx).astype(np.int64) - g.x0)

    node_tile = tile_of(g.node_lon, g.node_lat)
    # Local order: nodes by OSM id, edges by (way id, position) = build order within the tile.
    node_order = np.lexsort((g.node_ids, node_tile))
    node_local = np.empty(len(node_order), dtype=np.int64)
    node_start = np.searchsorted(node_tile[node_order], np.arange(nx * ny + 1))
    node_local[node_order] = np.arange(len(node_order)) - node_start[node_tile[node_order]]

    edge_tile = node_tile[g.edge_from]
    edge_order = np.argsort(edge_tile, kind="stable")
    edge_local = np.empty(len(edge_order), dtype=np.int64)
    edge_start = np.searchsorted(edge_tile[edge_order], np.arange(nx * ny + 1))
    edge_local[edge_order] = np.arange(len(edge_order)) - edge_start[edge_tile[edge_order]]

    for name, local in (("nodes", node_local), ("edges", edge_local)):
        if len(local) and local.max() > 0xFFFF:
            raise ValueError(f"a tile has more than 65535 {name}; use a higher zoom")

    # Incidence per node: every edge touching it, (edge, end) in edge order.
    inc_node = np.concatenate([g.edge_from, g.edge_to])
    inc_edge = np.concatenate([np.arange(len(g.edge_from)), np.arange(len(g.edge_to))])
    inc_end = np.concatenate([np.zeros(len(g.edge_from), np.int64), np.ones(len(g.edge_to), np.int64)])
    inc_order = np.lexsort((inc_end, inc_edge, inc_node))
    inc_node, inc_edge, inc_end = inc_node[inc_order], inc_edge[inc_order], inc_end[inc_order]
    inc_start = np.searchsorted(inc_node, np.arange(len(g.node_ids) + 1))

    sp_edge, sp_tile = edge_tiles(g)
    sp_start = np.searchsorted(sp_tile, np.arange(nx * ny + 1))

    restr_by_tile: dict[int, list[tuple[int, int, int, int]]] = defaultdict(list)
    for via, kind, fe, te in g.restrictions:
        restr_by_tile[int(node_tile[via])].append((via, kind, fe, te))

    def refs(edges: np.ndarray) -> np.ndarray:
        r = np.zeros(len(edges), dtype=REF_DT)
        r["tile"], r["idx"] = edge_tile[edges], edge_local[edges]
        return r

    def blob(t: int) -> bytes:
        nodes = node_order[node_start[t] : node_start[t + 1]]
        edges = edge_order[edge_start[t] : edge_start[t + 1]]

        n_rec = np.zeros(len(nodes), dtype=NODE_DT)
        n_rec["lon"], n_rec["lat"] = q6(g.node_lon[nodes]), q6(g.node_lat[nodes])
        n_rec["flags"] = g.node_flags[nodes]
        n_inc = inc_start[nodes + 1] - inc_start[nodes]
        n_rec["ninc"] = n_inc
        n_rec["inc"] = np.cumsum(n_inc) - n_inc
        isel = ranges(inc_start[nodes], n_inc)
        inc = refs(inc_edge[isel])
        inc["end"] = inc_end[isel]

        e_rec = np.zeros(len(edges), dtype=EDGE_DT)
        e_rec["from"] = node_local[g.edge_from[edges]]
        e_rec["cls"], e_rec["oneway"], e_rec["flags"] = g.edge_cls[edges], g.edge_oneway[edges], g.edge_flags[edges]
        to = g.edge_to[edges]
        e_rec["to_tile"], e_rec["to_idx"] = node_tile[to], node_local[to]
        e_rec["maxspeed"] = g.edge_maxspeed[edges]
        e_rec["length"] = g.edge_length[edges]
        e_rec["way"] = g.edge_way[edges]
        nvert = g.edge_vert[edges + 1] - g.edge_vert[edges]
        if len(nvert) and nvert.max() > 0xFFFF:
            raise ValueError("edge with more than 65535 vertices")
        e_rec["nvert"] = nvert
        e_rec["geom"] = np.cumsum(nvert) - nvert
        vsel = ranges(g.edge_vert[edges], nvert)
        verts = np.zeros(len(vsel), dtype=VERT_DT)
        verts["lon"], verts["lat"] = q6(g.vert_lon[vsel]), q6(g.vert_lat[vsel])

        rs = sorted(restr_by_tile.get(t, []), key=lambda r: (node_local[r[0]], r[2], r[3]))
        r_rec = np.zeros(len(rs), dtype=RESTR_DT)
        for i, (via, kind, fe, te) in enumerate(rs):
            r_rec[i]["via"], r_rec[i]["kind"] = node_local[via], kind
            r_rec[i]["from_tile"], r_rec[i]["from_idx"] = edge_tile[fe], edge_local[fe]
            r_rec[i]["to_tile"], r_rec[i]["to_idx"] = edge_tile[te], edge_local[te]

        sp = refs(sp_edge[sp_start[t] : sp_start[t + 1]])
        return b"".join([
            TILE_HEADER.pack(len(n_rec), len(inc), len(e_rec), len(verts), len(r_rec), len(sp)),
            n_rec.tobytes(), inc.tobytes(), e_rec.tobytes(), verts.tobytes(), r_rec.tobytes(), sp.tobytes(),
        ])

    # Header and directory last: blobs stream to the file in tile order.
    offsets = np.zeros(nx * ny + 1, dtype=np.int64)
    data_offset = HEADER.size + 4 * (nx * ny + 1)
    has_data = (np.diff(node_start) > 0) | (np.diff(sp_start) > 0)
    sizes: list[int] = []
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "wb") as f:
        f.seek(data_offset)
        total = 0
        for t in range(nx * ny):
            offsets[t] = total
            if has_data[t]:
                data = blob(t)
                f.write(data)
                total += len(data)
                sizes.append(len(data))
        offsets[nx * ny] = total
        if total > 0xFFFFFFFF:
            raise ValueError("graph file over 4 GB")
        f.seek(0)
        f.write(HEADER.pack(
            MAGIC, FORMAT, g.zoom, g.x0, g.y0, nx, ny, len(g.node_ids), len(g.edge_from),
            HEADER.size, data_offset, osm_date.encode("ascii").ljust(16, b"\0"),
            int(built_at if built_at is not None else time.time()), FEATURE_ATTRIBUTES,
        ))
        f.write(offsets.astype("<u4").tobytes())
    tmp.replace(path)
    return {
        "bytes": data_offset + total, "directory_bytes": data_offset - HEADER.size, "tiles": len(sizes),
        "tile_bytes_max": max(sizes, default=0), "tile_bytes_median": int(np.median(sizes)) if sizes else 0,
    }


def ranges(starts: np.ndarray, counts: np.ndarray) -> np.ndarray:
    """Concatenation of arange(s, s + n) for each (s, n)."""
    first = np.cumsum(counts) - counts
    return np.repeat(starts - first, counts) + np.arange(int(counts.sum()))


def q6(e7: np.ndarray) -> np.ndarray:
    """1e-7° → 1e-6°, rounded."""
    return np.floor_divide(e7.astype(np.int64) + 5, 10).astype(np.int32)


# --- Reading the file back (tests, inspection) ---------------------------------------------


@dataclass
class GraphFile:
    zoom: int
    x0: int
    y0: int
    nx: int
    ny: int
    nodes: int
    edges: int
    osm_date: str
    built_at: int
    features: int
    data: bytes
    directory: np.ndarray
    data_offset: int

    def tile(self, index: int) -> dict[str, np.ndarray] | None:
        a, b = int(self.directory[index]), int(self.directory[index + 1])
        if a == b:
            return None
        blob = self.data[self.data_offset + a : self.data_offset + b]
        counts = TILE_HEADER.unpack_from(blob)
        out, pos = {}, TILE_HEADER.size
        for name, dt, n in zip(("nodes", "incidence", "edges", "vertices", "restrictions", "spatial"),
                               (NODE_DT, REF_DT, EDGE_DT, VERT_DT, RESTR_DT, REF_DT), counts):
            out[name] = np.frombuffer(blob, dtype=dt, count=n, offset=pos)
            pos += n * dt.itemsize
        return out

    def tile_index(self, lon: float, lat: float) -> int:
        tx, ty = tile_xy(np.array([lon]), np.array([lat]), self.zoom)
        return (int(ty[0]) - self.y0) * self.nx + (int(tx[0]) - self.x0)

    def tiles(self):
        for t in np.flatnonzero(np.diff(self.directory)).tolist():
            yield t, self.tile(t)


def validate(gf: GraphFile) -> list[str]:
    """Internal consistency of a graph file; returns problems (empty = valid)."""
    problems: list[str] = []
    cache: dict[int, dict[str, np.ndarray] | None] = {}

    def tile(t: int):
        if t not in cache:
            cache[t] = gf.tile(t) if 0 <= t < gf.nx * gf.ny else None
        return cache[t]

    nodes = edges = 0
    for t, d in gf.tiles():
        cache.clear()
        cache[t] = d
        nodes += len(d["nodes"])
        edges += len(d["edges"])
        e, n, v = d["edges"], d["nodes"], d["vertices"]
        if len(e):
            if (e["from"] >= len(n)).any():
                problems.append(f"tile {t}: edge from-node out of range")
                continue
            start = v[e["geom"]]
            if (start["lon"] != n["lon"][e["from"]]).any() or (start["lat"] != n["lat"][e["from"]]).any():
                problems.append(f"tile {t}: edge geometry doesn't start at its from-node")
            if (e["nvert"] < 2).any() or (e["length"] < 0).any():
                problems.append(f"tile {t}: degenerate edge")
            end = v[e["geom"] + e["nvert"] - 1]
            for to_t, to_i, lon, lat in zip(e["to_tile"].tolist(), e["to_idx"].tolist(), end["lon"].tolist(), end["lat"].tolist()):
                other = tile(to_t)
                if other is None or to_i >= len(other["nodes"]):
                    problems.append(f"tile {t}: to-node ({to_t}, {to_i}) missing")
                elif (other["nodes"]["lon"][to_i], other["nodes"]["lat"][to_i]) != (lon, lat):
                    problems.append(f"tile {t}: edge geometry doesn't end at its to-node")
        inc = d["incidence"]
        if len(n) and (n["inc"] + n["ninc"] > len(inc)).any():
            problems.append(f"tile {t}: incidence out of range")
            continue
        # Every incidence entry points at an edge whose from (end 0) or to (end 1) is this node.
        owner = np.repeat(np.arange(len(n)), n["ninc"])
        for i, (et, ei, end) in enumerate(zip(inc["tile"].tolist(), inc["idx"].tolist(), inc["end"].tolist())):
            other = tile(et)
            if other is None or ei >= len(other["edges"]):
                problems.append(f"tile {t}: incidence edge ({et}, {ei}) missing")
                continue
            edge = other["edges"][ei]
            ok = (et == t and edge["from"] == owner[i]) if end == 0 else (edge["to_tile"] == t and edge["to_idx"] == owner[i])
            if not ok:
                problems.append(f"tile {t}: incidence of node {owner[i]} doesn't match edge ({et}, {ei})")
        # Each edge homed here is listed in this tile's spatial index (its first vertex is here).
        sp = d["spatial"]
        own = set(sp["idx"][sp["tile"] == t].tolist())
        if len(own) != len(e) or (len(e) and max(own) != len(e) - 1):
            problems.append(f"tile {t}: spatial list misses edges homed here")
        if len(problems) > 50:
            break
    if (nodes, edges) != (gf.nodes, gf.edges):
        problems.append(f"counts: header {gf.nodes}/{gf.edges}, tiles {nodes}/{edges}")
    return problems


def read_graph(path: Path) -> GraphFile:
    data = path.read_bytes()
    magic, fmt, zoom, x0, y0, nx, ny, nodes, edges, dir_off, data_off, date, built, features = HEADER.unpack_from(data)
    if magic != MAGIC or fmt != FORMAT:
        raise ValueError(f"not a format-{FORMAT} graph file: {path}")
    directory = np.frombuffer(data, dtype="<u4", count=nx * ny + 1, offset=dir_off)
    return GraphFile(zoom, x0, y0, nx, ny, nodes, edges, date.rstrip(b"\0").decode(), built, features, data, directory, data_off)


# --- Entry point --------------------------------------------------------------------------


def build_region_graph(pbf: Path, poly: Path, output: Path, osm_date: str) -> dict[str, int]:
    t0 = time.monotonic()
    roads = read_roads(pbf)
    t1 = time.monotonic()
    loc = read_locations(pbf, np.unique(roads.refs))
    t2 = time.monotonic()
    settlements = read_settlements(pbf)
    t3 = time.monotonic()
    graph = build_graph(roads, loc, read_poly(poly), settlements=settlements)
    t4 = time.monotonic()
    sizes = write_graph(graph, output, osm_date)
    t5 = time.monotonic()
    stats = {**graph.stats, **sizes}
    share = lambda key: f"{stats[key] / max(1, stats['edges']) * 100:.0f}"  # noqa: E731
    log(f"{output.name}: {sizes['bytes'] / 1e6:.1f} MB, {stats['edges']} edges, {stats['nodes']} nodes, "
        f"{sizes['tiles']} tiles (max {sizes['tile_bytes_max'] / 1e3:.0f} kB); "
        f"urban {share('urban_edges')} % of edges (city {share('city_edges')} %, big city {share('big_city_edges')} %), "
        f"limit tagged {share('maxspeed_edges')} %, {stats['signal_nodes']} signalled junctions, "
        f"{stats['signal_edges']} signalled crossings, {stats['stop_nodes']} stop/give-way; "
        f"ways {t1 - t0:.0f} s, nodes {t2 - t1:.0f} s, settlements {t3 - t2:.0f} s, topology {t4 - t3:.0f} s, "
        f"write {t5 - t4:.0f} s")
    return stats
