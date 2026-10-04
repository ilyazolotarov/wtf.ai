import os
from pathlib import Path

import numpy as np
import pytest
from shapely.geometry import Polygon

from tiles.graph import (
    BRIDGE, CLASSES, LINK, MINOR_SERVICE, NODE_BOUNDARY, NODE_DEAD_END, ONEWAY_BACKWARD,
    ONEWAY_FORWARD, ONEWAY_NONE, PRIVATE, RESTRICT_NO, RESTRICT_ONLY, ROUNDABOUT,
    build_graph, read_graph, read_locations, read_roads, restriction_kind, road_attrs,
    segment_tiles, validate, write_graph,
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
    assert not road_attrs({"highway": "service", "service": "alley", "bridge": "no"}).flags


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


def ts_fixture_bytes(tmp: Path) -> bytes:
    xml = osm_xml().replace("</osm>", "")
    xml += "".join(f'<node id="{i}" version="1" lat="{lat:.7f}" lon="{lon:.7f}"/>' for i, (lon, lat) in FAR_NODES.items())
    for wid, refs, t in FAR_WAYS:
        xml += f'<way id="{wid}" version="1">' + "".join(f'<nd ref="{r}"/>' for r in refs)
        xml += "".join(f'<tag k="{k}" v="{v}"/>' for k, v in t.items()) + "</way>"
    xml += "</osm>"
    pbf = tmp / "fixture.osm"
    pbf.write_text(xml, encoding="utf-8")
    roads = read_roads(pbf)
    region = REGION.union(Polygon([(LON0 - 0.01, LAT0 + 0.005), (LON0 + 0.06, LAT0 + 0.005), (LON0 + 0.06, LAT0 + 0.02), (LON0 - 0.01, LAT0 + 0.02)]))
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
