import math
import os
from pathlib import Path

import numpy as np
import pytest
from shapely.geometry import Polygon

from tiles.graph import (
    ATTRIBUTES, BRIDGE, CITY, CLASSES, FEATURE_ATTRIBUTES, LINK, MINOR_SERVICE, NODE_BOUNDARY, NODE_DEAD_END,
    NODE_SIGNALS, NODE_STOP, ONEWAY_BACKWARD, ONEWAY_FORWARD, ONEWAY_NONE, PRIVATE, RESTRICT_NO, RESTRICT_ONLY,
    ROUNDABOUT, SIGNALS, UNPAVED, URBAN, Settlements, population, build_graph, maxspeed_kph, read_graph, read_locations,
    read_roads, read_settlements, restriction_kind, road_attrs, segment_tiles, urban_mask, validate, write_graph,
)

# --- Tag rules ----------------------------------------------------------------------------


def test_classes_and_links():
    assert road_attrs({"highway": "primary"}).cls == CLASSES["primary"]
    link = road_attrs({"highway": "trunk_link"})
    assert link.cls == CLASSES["trunk"] and link.flags & LINK
    for dropped in ("footway", "path", "cycleway", "steps", "pedestrian", "construction", "proposed", "busway"):
        assert road_attrs({"highway": dropped}) is None
    assert road_attrs({"highway": "residential_link"}) is None
    assert road_attrs({"highway": "pedestrian", "area": "yes"}) is None
    assert road_attrs({"highway": "service", "area": "yes"}) is None


def test_access_precedence():
    assert road_attrs({"highway": "residential", "access": "no"}) is None
    assert road_attrs({"highway": "residential", "access": "no", "motor_vehicle": "yes"}) is not None
    assert road_attrs({"highway": "track", "motor_vehicle": "no"}) is None
    assert road_attrs({"highway": "service", "access": "private"}).flags & PRIVATE
    assert road_attrs({"highway": "track", "motor_vehicle": "agricultural;forestry"}).flags & PRIVATE
    assert not road_attrs({"highway": "service", "access": "destination"}).flags & PRIVATE
    assert not road_attrs({"highway": "service", "access": "private", "motorcar": "yes"}).flags & PRIVATE


def test_oneway_variants():
    def ow(**tags):
        return road_attrs({"highway": "residential", **tags}).oneway

    assert ow() == ONEWAY_NONE
    assert ow(oneway="yes") == ow(oneway="1") == ow(oneway="true") == ONEWAY_FORWARD
    assert ow(oneway="-1") == ONEWAY_BACKWARD
    assert ow(oneway="reversible") == ONEWAY_NONE
    assert ow(junction="roundabout") == ONEWAY_FORWARD
    assert ow(junction="roundabout", oneway="no") == ONEWAY_NONE
    assert road_attrs({"highway": "motorway"}).oneway == ONEWAY_FORWARD
    assert road_attrs({"highway": "motorway_link"}).oneway == ONEWAY_NONE


def test_flags():
    a = road_attrs({"highway": "service", "service": "parking_aisle", "bridge": "yes", "junction": "roundabout"})
    assert a.flags & MINOR_SERVICE and a.flags & BRIDGE and a.flags & ROUNDABOUT
    assert road_attrs({"highway": "service", "service": "alley", "bridge": "no"}).flags == ATTRIBUTES
    assert road_attrs({"highway": "track", "surface": "dirt"}).flags & UNPAVED
    assert not road_attrs({"highway": "residential", "surface": "asphalt"}).flags & UNPAVED


def test_maxspeed():
    def ms(**tags):
        return maxspeed_kph(tags)

    assert ms() == 0
    assert ms(maxspeed="90") == 90 and ms(maxspeed=" 50 ") == 50 and ms(maxspeed="60 km/h") == 60
    assert ms(maxspeed="30 mph") == 48
    assert ms(maxspeed="UA:urban") == 50 and ms(maxspeed="UA:rural") == 90 and ms(maxspeed="RU:urban") == 60
    assert ms(maxspeed="none") == ms(maxspeed="signals") == ms(maxspeed="50;30") == 0
    assert ms(**{"maxspeed:forward": "70", "maxspeed:backward": "50"}) == 70
    assert road_attrs({"highway": "primary", "maxspeed": "110"}).maxspeed == 110


def test_restriction_kind():
    assert restriction_kind({"type": "restriction", "restriction": "no_left_turn"}) == RESTRICT_NO
    assert restriction_kind({"type": "restriction", "restriction": "only_straight_on"}) == RESTRICT_ONLY
    assert restriction_kind({"type": "restriction", "restriction:hgv": "no_left_turn"}) is None
    assert restriction_kind({"type": "restriction", "restriction:motorcar": "no_u_turn", "restriction": "only_right_turn"}) == RESTRICT_NO
    assert restriction_kind({"type": "restriction", "restriction": "no_left_turn", "except": "bus;motorcar"}) is None
    assert restriction_kind({"type": "multipolygon", "restriction": "no_left_turn"}) is None


def test_segment_tiles_walks_every_crossed_tile():
    assert segment_tiles(0.5, 0.5, 0.7, 0.2) == [(0, 0)]
    assert segment_tiles(0.5, 0.5, 2.5, 0.5) == [(0, 0), (1, 0), (2, 0)]
    diag = segment_tiles(0.2, 0.1, 1.9, 1.8)
    assert diag[0] == (0, 0) and diag[-1] == (1, 1) and len(diag) == 3
    assert segment_tiles(2.5, 2.5, 0.5, 2.5) == [(2, 2), (1, 2), (0, 2)]


# --- Network fixture ----------------------------------------------------------------------
#
#        5                    grid of D = 0.0006° (~42 m east, ~67 m north) in Slavutych
#        |
#  1 --- 2 --- 3 --- 4 (outside the region polygon)
#        |           |
#        6           8 (oneway=-1 from 4)
#
#  10-11-12-10 roundabout, 11 joined by 13-11;  20-21-22-23-20 isolated service loop;
#  30-31-99-32: node 99 missing from the file; 40-41 footway (dropped); 50-51 access=no

LON0, LAT0, D = 30.75, 51.52, 0.0006

NODES = {
    1: (0, 0), 2: (1, 0), 3: (2, 0), 4: (3, 0), 5: (1, 1), 6: (1, -1), 8: (3, -1),
    10: (5, 0), 11: (6, 0), 12: (5.5, 1), 13: (7, 0),
    20: (0, 3), 21: (1, 3), 22: (1, 4), 23: (0, 4),
    30: (3, 3), 31: (4, 3), 32: (6, 3),
    40: (0, 6), 41: (1, 6), 50: (2, 6), 51: (3, 6),
}

WAYS = [
    (101, [1, 2], {"highway": "primary"}),
    (102, [2, 3, 4], {"highway": "primary", "bridge": "yes"}),
    (103, [5, 2], {"highway": "residential"}),
    (104, [2, 6], {"highway": "residential"}),
    (105, [4, 8], {"highway": "residential", "oneway": "-1"}),
    (106, [10, 11, 12, 10], {"highway": "tertiary", "junction": "roundabout"}),
    (107, [13, 11], {"highway": "tertiary"}),
    (108, [20, 21, 22, 23, 20], {"highway": "service", "service": "parking_aisle"}),
    (109, [30, 31, 99, 32], {"highway": "unclassified"}),
    (110, [40, 41], {"highway": "footway"}),
    (111, [50, 51], {"highway": "service", "access": "no"}),
]

RELATIONS = [
    (201, [("w", 101, "from"), ("n", 2, "via"), ("w", 103, "to")], {"type": "restriction", "restriction": "no_left_turn"}),
    (202, [("w", 103, "from"), ("n", 2, "via"), ("w", 104, "to")], {"type": "restriction", "restriction": "only_straight_on"}),
    # Way 102 passes through node 3 (not a graph node): dropped.
    (203, [("w", 102, "from"), ("n", 3, "via"), ("w", 102, "to")], {"type": "restriction", "restriction": "no_u_turn"}),
    # Via way: dropped.
    (204, [("w", 101, "from"), ("w", 102, "via"), ("w", 105, "to")], {"type": "restriction", "restriction": "no_right_turn"}),
]


def osm_xml() -> str:
    def tags(t: dict[str, str]) -> str:
        return "".join(f'<tag k="{k}" v="{v}"/>' for k, v in t.items())

    out = ['<?xml version="1.0" encoding="UTF-8"?>', '<osm version="0.6" generator="test">']
    for nid, (x, y) in NODES.items():
        out.append(f'<node id="{nid}" version="1" lat="{LAT0 + y * D:.7f}" lon="{LON0 + x * D:.7f}"/>')
    for wid, refs, t in WAYS:
        out.append(f'<way id="{wid}" version="1">' + "".join(f'<nd ref="{r}"/>' for r in refs) + tags(t) + "</way>")
    for rid, members, t in RELATIONS:
        m = "".join(f'<member type="{ {"w": "way", "n": "node"}[k] }" ref="{ref}" role="{role}"/>' for k, ref, role in members)
        out.append(f'<relation id="{rid}" version="1">{m}{tags(t)}</relation>')
    out.append("</osm>")
    return "\n".join(out)


REGION = Polygon([
    (LON0 - 0.01, LAT0 - 0.01), (LON0 + 2.5 * D, LAT0 - 0.01),
    (LON0 + 2.5 * D, LAT0 + 0.01), (LON0 - 0.01, LAT0 + 0.01),
]).union(Polygon([
    (LON0 + 4 * D, LAT0 - 0.01), (LON0 + 0.02, LAT0 - 0.01), (LON0 + 0.02, LAT0 + 0.01), (LON0 + 4 * D, LAT0 + 0.01),
]))


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("graph")
    pbf = tmp / "net.osm"
    pbf.write_text(osm_xml(), encoding="utf-8")
    roads = read_roads(pbf)
    graph = build_graph(roads, read_locations(pbf, np.unique(roads.refs)), REGION)
    path = tmp / "net.graph.bin"
    write_graph(graph, path, "2026-10-01", built_at=1_790_000_000)
    return roads, graph, read_graph(path)


def edges_by_way(graph) -> dict[int, list[tuple[int, int]]]:
    """way id → [(from OSM node, to OSM node)] in build order."""
    out: dict[int, list[tuple[int, int]]] = {}
    for w, a, b in zip(graph.edge_way.tolist(), graph.edge_from.tolist(), graph.edge_to.tolist()):
        out.setdefault(w, []).append((int(graph.node_ids[a]), int(graph.node_ids[b])))
    return out


def test_filter_and_restriction_reading(built):
    roads, _, _ = built
    assert set(roads.way_ids.tolist()) == {101, 102, 103, 104, 105, 106, 107, 108, 109}
    assert {(r[0], r[1], r[2]) for r in roads.restrictions} == {(101, 2, 103), (103, 2, 104), (102, 3, 102)}
    assert roads.skipped_restrictions == 1  # via way


def test_ways_split_at_graph_nodes(built):
    _, graph, _ = built
    e = edges_by_way(graph)
    assert e[101] == [(1, 2)]
    assert e[102] == [(2, 4)]  # 3 is a plain vertex
    assert e[106] == [(10, 11), (11, 10)]  # closing node 10 is a graph node; 11 shared
    assert len(e[108]) == 2 and e[108][0][0] == 20 and e[108][0][1] == e[108][1][0] == 22 and e[108][1][1] == 20
    assert e[109] == [(30, 31)]  # missing node 99 cuts the way; 32 alone is dropped


def test_edge_attributes(built):
    _, graph, _ = built
    idx = {w: i for i, w in enumerate(graph.edge_way.tolist())}
    assert graph.edge_oneway[idx[105]] == ONEWAY_BACKWARD
    assert graph.edge_oneway[idx[106]] == ONEWAY_FORWARD and graph.edge_flags[idx[106]] & ROUNDABOUT
    assert graph.edge_flags[idx[102]] & BRIDGE
    assert graph.edge_flags[idx[108]] & MINOR_SERVICE
    # 102 is two segments of D due east
    assert graph.edge_length[idx[102]] == pytest.approx(2 * D * 111_195 * np.cos(np.radians(LAT0)), rel=1e-3)


def test_simplification_drops_collinear_vertex(built):
    _, graph, _ = built
    i = graph.edge_way.tolist().index(102)
    assert graph.edge_vert[i + 1] - graph.edge_vert[i] == 2  # 2-3-4 is straight


def test_node_flags(built):
    _, graph, _ = built
    flags = dict(zip(graph.node_ids.tolist(), graph.node_flags.tolist()))
    assert flags[4] & NODE_BOUNDARY and not flags[2] & NODE_BOUNDARY
    assert flags[1] & NODE_DEAD_END and flags[8] & NODE_DEAD_END
    assert not flags[2] & NODE_DEAD_END and not flags[22] & NODE_DEAD_END


def test_restrictions_mapped_to_edges(built):
    _, graph, _ = built
    way = graph.edge_way
    got = {(int(graph.node_ids[v]), k, int(way[f]), int(way[t])) for v, k, f, t in graph.restrictions}
    assert got == {(2, RESTRICT_NO, 101, 103), (2, RESTRICT_ONLY, 103, 104)}
    assert graph.stats["restrictions_skipped"] == 2


def test_file_round_trip(built):
    _, graph, gf = built
    assert validate(gf) == []
    assert (gf.nodes, gf.edges, gf.osm_date, gf.built_at) == (len(graph.node_ids), len(graph.edge_way), "2026-10-01", 1_790_000_000)
    t = gf.tile_index(LON0 + D, LAT0)
    tile = gf.tile(t)
    lon6, lat6 = round((LON0 + D) * 1e6), round(LAT0 * 1e6)
    node2 = int(np.flatnonzero((tile["nodes"]["lon"] == lon6) & (tile["nodes"]["lat"] == lat6))[0])
    n = tile["nodes"][node2]
    assert n["ninc"] == 4  # 101 (end), 102, 103 (end), 104
    ways = set()
    for ref in tile["incidence"][n["inc"] : n["inc"] + n["ninc"]]:
        other = gf.tile(int(ref["tile"]))
        ways.add(int(other["edges"][ref["idx"]]["way"]))
    assert ways == {101, 102, 103, 104}
    restr = tile["restrictions"]
    assert len(restr) == 2 and set(restr["via"].tolist()) == {node2}
    assert set(restr["kind"].tolist()) == {RESTRICT_NO, RESTRICT_ONLY}


def test_spatial_lists_cover_crossing_edges(tmp_path: Path):
    """A long straight edge appears in every tile it crosses, not only its home tile."""
    xml = (
        '<osm version="0.6">'
        f'<node id="1" version="1" lat="{LAT0}" lon="{LON0}"/>'
        f'<node id="2" version="1" lat="{LAT0}" lon="{LON0 + 0.1}"/>'
        '<way id="1" version="1"><nd ref="1"/><nd ref="2"/><tag k="highway" v="primary"/></way>'
        "</osm>"
    )
    pbf = tmp_path / "long.osm"
    pbf.write_text(xml, encoding="utf-8")
    roads = read_roads(pbf)
    graph = build_graph(roads, read_locations(pbf, np.unique(roads.refs)), REGION.buffer(1))
    path = tmp_path / "long.graph.bin"
    write_graph(graph, path, "2026-10-01")
    gf = read_graph(path)
    assert validate(gf) == []
    assert gf.nx >= 5  # 0.1° ≈ 4.5 z14 tiles
    listed = [t for t, d in gf.tiles() if len(d["spatial"])]
    assert len(listed) == gf.nx
    middle = gf.tile(gf.tile_index(LON0 + 0.05, LAT0))
    assert len(middle["nodes"]) == 0 and len(middle["edges"]) == 0 and len(middle["spatial"]) == 1


def test_validate_catches_corruption(built, tmp_path: Path):
    _, graph, _ = built
    path = tmp_path / "bad.graph.bin"
    write_graph(graph, path, "2026-10-01")
    data = bytearray(path.read_bytes())
    gf = read_graph(path)
    t = next(t for t, d in gf.tiles() if len(d["incidence"]))
    # Point the first incidence entry of tile t at a wrong edge index.
    pos = gf.data_offset + int(gf.directory[t]) + 24 + 16 * len(gf.tile(t)["nodes"]) + 4
    data[pos : pos + 2] = (0xFFFF).to_bytes(2, "little")
    path.write_bytes(bytes(data))
    assert validate(read_graph(path))


# --- Fixture for the TS reader (src/nav/mapmatch/__tests__) -------------------------------
#
# The network above plus a road crossing several z14 tiles: 60 —160— 61 —161— 63, with 162
# from 61 north to 62. Regenerate after a format change: UPDATE_FIXTURES=1 python -m pytest.

TS_FIXTURE = Path(__file__).resolve().parents[3] / "src" / "nav" / "mapmatch" / "__fixtures__" / "net.graph.bin"
FAR_LAT = LAT0 + 0.01
FAR_NODES = {60: (LON0, FAR_LAT), 61: (LON0 + 0.025, FAR_LAT), 63: (LON0 + 0.05, FAR_LAT), 62: (LON0 + 0.025, FAR_LAT + 0.004)}
FAR_WAYS = [
    (160, [60, 61], {"highway": "primary"}),
    (161, [61, 63], {"highway": "primary"}),
    (162, [61, 62], {"highway": "secondary", "oneway": "yes"}),
]

# A junction with the density of a real one, for MAPMATCH-SPEC §15, item 14: shaped on the one 16 km into the
# 2026-10-06 jammed intercity drive (`replay:junction`), where the car turned 95° left off a southbound primary and
# the filter went off-road for 43 s. What the graph holds there, within 150 m of the node: the approach, **two**
# eastbound primaries that both leave the node heading 86° and only diverge further along, a service road at 133°,
# and a service lane 17–27 m to the side at 85–87°. So a 95° left turn is explained equally well by two roads,
# with three more candidates within 30 m — the fixture's other junctions offer one exit per direction, which is
# why they survive along-track errors that the real one did not.
# West of the rest of the fixture, so its region can hold a 2 km approach without reaching the other clusters
# (it used to end just past node 4, which `test_nodes` needs to stay a boundary node).
JUN_LAT, JUN_LON = LAT0 - 0.02, LON0 - 0.05
M_LAT = 1 / 111_195
M_LON = 1 / (111_195 * np.cos(np.radians(JUN_LAT)))


def _jn(east_m: float, north_m: float) -> tuple[float, float]:
    """Metres east/north of the junction node, as (lon, lat)."""
    return (JUN_LON + east_m * M_LON, JUN_LAT + north_m * M_LAT)


# 70: the junction. 71–72: a 2 km approach from the north, long enough to dead reckon down as the real
# drive's 1.7 km straight was. 73: on past the junction.
# 74–75 and 76–77: the two eastbound primaries. 78: the service road at 133°. 79–80: the service lane alongside.
JUNCTION_NODES = {
    70: _jn(0, 0),
    71: _jn(0, 1000),
    72: _jn(0, 2000),
    73: _jn(0, 2200),
    74: _jn(120, 4),
    75: _jn(360, 8),
    76: _jn(120, -6),
    77: _jn(360, -20),
    78: _jn(20, -19),
    79: _jn(40, -20),
    80: _jn(110, -20),
}
JUNCTION_WAYS = [
    (170, [72, 71, 70], {"highway": "primary"}),          # the approach, driven southbound
    (171, [70, 73], {"highway": "unclassified"}),         # on past the junction, as the real one continues
    (172, [70, 74, 75], {"highway": "primary"}),          # eastbound, heading 86° at the node
    (173, [70, 76, 77], {"highway": "primary"}),          # the other eastbound, same heading at the node
    (174, [70, 78], {"highway": "service"}),              # the service road at 133°
    (175, [79, 80], {"highway": "service"}),              # the lane alongside, 20 m off
]


def ts_fixture_bytes(tmp: Path) -> bytes:
    xml = osm_xml().replace("</osm>", "")
    extra_nodes = {**FAR_NODES, **JUNCTION_NODES}
    xml += "".join(f'<node id="{i}" version="1" lat="{lat:.7f}" lon="{lon:.7f}"/>' for i, (lon, lat) in extra_nodes.items())
    for wid, refs, t in [*FAR_WAYS, *JUNCTION_WAYS]:
        xml += f'<way id="{wid}" version="1">' + "".join(f'<nd ref="{r}"/>' for r in refs)
        xml += "".join(f'<tag k="{k}" v="{v}"/>' for k, v in t.items()) + "</way>"
    xml += "</osm>"
    pbf = tmp / "fixture.osm"
    pbf.write_text(xml, encoding="utf-8")
    roads = read_roads(pbf)
    region = REGION.union(Polygon([(LON0 - 0.01, LAT0 + 0.005), (LON0 + 0.06, LAT0 + 0.005), (LON0 + 0.06, LAT0 + 0.02), (LON0 - 0.01, LAT0 + 0.02)]))
    region = region.union(Polygon([(JUN_LON - 0.004, JUN_LAT - 0.004), (JUN_LON + 0.01, JUN_LAT - 0.004), (JUN_LON + 0.01, JUN_LAT + 0.025), (JUN_LON - 0.004, JUN_LAT + 0.025)]))
    graph = build_graph(roads, read_locations(pbf, np.unique(roads.refs)), region)
    out = tmp / "fixture.graph.bin"
    write_graph(graph, out, "2026-10-01", built_at=1_790_000_000)
    assert validate(read_graph(out)) == []
    return out.read_bytes()


def test_ts_fixture_is_current(tmp_path: Path):
    data = ts_fixture_bytes(tmp_path)
    if os.environ.get("UPDATE_FIXTURES") == "1":
        TS_FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        TS_FIXTURE.write_bytes(data)
    assert TS_FIXTURE.exists() and TS_FIXTURE.read_bytes() == data, "TS fixture is stale: UPDATE_FIXTURES=1 python -m pytest"


# --- Speed attributes (ROUTING-SPEC §4.1) ---------------------------------------------------
#
#  8 ---- 1 ---- 2 · 3 ---------- 4 ---------- 5      (primary 301, maxspeed 90; village point just past 5)
#         |        |
#         9 (stop) 6
#         |
#         7
# 2: a traffic light 20 m before junction 3 (its stop line); 4: a signalled crossing far from any junction.


def _m(east: float, north: float) -> tuple[float, float]:
    """Metres east/north of LON0, LAT0 as (lon, lat)."""
    return (LON0 + east / (111_195 * np.cos(np.radians(LAT0))), LAT0 + north / 111_195)


CONTROL_NODES = {
    1: (_m(0, 0), {}), 2: (_m(280, 0), {"highway": "traffic_signals"}), 3: (_m(300, 0), {}),
    4: (_m(600, 0), {"highway": "crossing", "crossing": "traffic_signals"}), 5: (_m(900, 0), {}),
    6: (_m(300, 200), {}), 7: (_m(0, -200), {}), 8: (_m(-200, 0), {}), 9: (_m(0, -10), {"highway": "stop"}),
    90: (_m(1000, 0), {"place": "village"}),
}
CONTROL_WAYS = [
    (301, [1, 2, 3, 4, 5], {"highway": "primary", "maxspeed": "90"}),
    (302, [3, 6], {"highway": "residential"}),
    (303, [1, 9, 7], {"highway": "residential", "surface": "ground"}),
    (304, [8, 1], {"highway": "tertiary"}),
]


@pytest.fixture(scope="module")
def controls(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("controls")
    xml = ['<osm version="0.6">']
    for nid, ((lon, lat), tags) in CONTROL_NODES.items():
        xml.append(f'<node id="{nid}" version="1" lat="{lat:.7f}" lon="{lon:.7f}">'
                   + "".join(f'<tag k="{k}" v="{v}"/>' for k, v in tags.items()) + "</node>")
    for wid, refs, tags in CONTROL_WAYS:
        xml.append(f'<way id="{wid}" version="1">' + "".join(f'<nd ref="{r}"/>' for r in refs)
                   + "".join(f'<tag k="{k}" v="{v}"/>' for k, v in tags.items()) + "</way>")
    xml.append("</osm>")
    pbf = tmp / "controls.osm"
    pbf.write_text("\n".join(xml), encoding="utf-8")
    roads = read_roads(pbf)
    region = Polygon([(LON0 - 0.05, LAT0 - 0.05), (LON0 + 0.05, LAT0 - 0.05), (LON0 + 0.05, LAT0 + 0.05), (LON0 - 0.05, LAT0 + 0.05)])
    return build_graph(roads, read_locations(pbf, np.unique(roads.refs)), region, settlements=read_settlements(pbf))


def test_controls_mark_junctions_and_crossings(controls):
    g = controls
    flags = dict(zip(g.node_ids.tolist(), g.node_flags.tolist()))
    assert 2 not in flags and flags[3] & NODE_SIGNALS  # the stop-line light controls junction 3
    assert flags[1] & NODE_STOP and not flags[1] & NODE_SIGNALS
    assert not flags[5] & NODE_SIGNALS  # 4 is 300 m from 3, and 5 is a dead end: a crossing, not a junction light
    by_nodes = {(int(g.node_ids[a]), int(g.node_ids[b])): f for a, b, f in zip(g.edge_from, g.edge_to, g.edge_flags.tolist())}
    assert by_nodes[(3, 5)] & SIGNALS and not by_nodes[(1, 3)] & SIGNALS


def test_urban_maxspeed_and_surface(controls):
    g = controls
    edges = {(int(g.node_ids[a]), int(g.node_ids[b])): i for i, (a, b) in enumerate(zip(g.edge_from, g.edge_to))}
    assert g.edge_flags[edges[(3, 5)]] & URBAN  # middle 400 m from the village point
    assert not g.edge_flags[edges[(1, 3)]] & URBAN  # middle 850 m from it
    assert g.edge_maxspeed[edges[(3, 5)]] == 90 and g.edge_maxspeed[edges[(8, 1)]] == 0
    assert g.edge_flags[edges[(1, 7)]] & UNPAVED
    assert all(f & ATTRIBUTES for f in g.edge_flags.tolist())
    assert g.stats["signal_nodes"] == 1 and g.stats["signal_edges"] == 1 and g.stats["stop_nodes"] == 1


def test_urban_mask_city_radius_and_size():
    def mask(population: float, *pts):
        s = Settlements({"city": np.array([_m(0, 0)])}, [], [], city_population=np.array([population]))
        return [m.tolist() for m in urban_mask(np.array([p[0] for p in pts]), np.array([p[1] for p in pts]), s)]

    # Untagged: 4 km, not big. Chernihiv-sized: still not big. Kyiv-sized: ~12 km, big.
    assert mask(math.nan, _m(3500, 0), _m(0, 4500)) == [[True, False], [True, False], [False, False]]
    assert mask(280_000, _m(3500, 0)) == [[True], [True], [False]]
    assert mask(2_950_000, _m(11_000, 0), _m(0, 13_500)) == [[True, False], [True, False], [True, False]]
    assert population({"population": "2 952 301"}) == 2_952_301 and math.isnan(population({"population": "~1M"}))


def test_header_features(built):
    _, _, gf = built
    assert gf.features == FEATURE_ATTRIBUTES
