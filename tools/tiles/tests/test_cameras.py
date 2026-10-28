import json
import math
import urllib.error
from datetime import date
from html import escape
from pathlib import Path

import pytest

from tiles import cameras
from tiles.cameras import (
    IN_OSM, ON_LIST, angle_diff, build_cameras, dist_m, house_key, km_value, mvs_rows, norm_ref, page_tables,
    parse_tables, place_name, refresh_snapshot, report, street_key, write_snapshot,
)

PAGE = """<html><body>
<p>Перелік на автомобільних дорогах</p>
<table>
<tr><th>Індекс</th><th>Назва</th><th>Місце</th><th>Швидкість</th></tr>
<tr><td>M-01</td><td>Північ - Південь (у напрямку м. Північ)</td><td>5+000</td><td>90 км/год</td></tr>
<tr><td>М-01</td><td>Північ - Південь (у напрямку м. Південь)</td><td>10+0</td><td>70 км/год</td></tr>
<tr><td>М01</td><td>Північ - Південь (у напрямку м. Північ)</td><td>15+000</td><td>90 км/год</td></tr>
<tr><td>М-01</td><td>Північ - Південь<br>(у напрямку м. Південь)</td><td>25+000</td><td>50 км/год</td></tr>
</table>
<p>Перелік у межах м. Місто</p>
<table>
<tr><th>Адреса</th><th>Швидкість</th></tr>
<tr><td>вул. Шевченка, 10 (у напрямку вул. Франка)</td><td>50 км/год70 км/год</td></tr>
<tr><td>вулиця Шевченка, 20</td><td>50 км/год</td></tr>
<tr><td>перехрестя вул. Шевченка - вул. Франка</td><td>40 км/год</td></tr>
<tr><td>Міст Південний</td><td>60 км/год</td></tr>
</table>
</body></html>"""


def test_the_page_parses_into_road_and_town_rows():
    tables = page_tables(PAGE)
    assert len(tables["roads"]) == 4 and tables["towns"][0][0] == "Місто"
    rows = parse_tables(tables)
    road = rows[0]
    assert (road["kind"], road["ref"], road["km"], road["toward"], road["limits"]) == ("road", "М-01", 5.0, "м. Північ", [90])
    assert rows[1]["km"] == 10.0 and rows[2]["ref"] == "М-01"
    assert rows[3]["toward"] == "м. Південь"
    house, plain, crossing, bridge = rows[4:]
    assert (house["city"], house["street"], house["house"], house["toward"], house["limits"]) == (
        "Місто", "вул. Шевченка", "10", "вул. Франка", [50, 70])
    assert plain["street"] == "вулиця Шевченка" and plain["house"] == "20"
    assert crossing["crossing"] == ["вул. Шевченка", "вул. Франка"]
    assert bridge["street"] == "Міст Південний" and bridge["house"] is None


def test_names():
    assert norm_ref("M-01") == norm_ref("М01") == "М-01"
    assert norm_ref("H 31") == "Н-31"
    assert km_value("113+864") == 113.864 and km_value("7+5") == 7.5 and km_value("км 7") is None
    assert street_key("просп. Князя Володимира") == street_key("проспект Князя Володимира") == "володимира князя"
    assert street_key("вул. Т. Шевченка") == street_key("Шевченка вулиця")
    assert house_key("38-А") == "38а" and house_key("12, корп. 2") == "12к2"
    assert place_name("м. Київ") == place_name("м.Київ") == "Київ" and place_name("смт. Ворзель") == "Ворзель"


# --- The list's checks -----------------------------------------------------------------------

TODAY = date(2026, 10, 28)
ROADS = [("М-01", "Північ - Південь (у напрямку м. Північ)", f"{k}+000", "90 км/год") for k in range(1, 41)]
TOWNS = [(f"Місто{i}", [(f"вул. Шевченка, {n}", "50 км/год") for n in range(1, 5)]) for i in range(10)]


def page_html(roads, towns, heading="Перелік у межах м. {town}") -> str:
    cells = lambda row: "".join(f"<td>{c}</td>" for c in row)  # noqa: E731
    out = ["<html><body><p>Перелік на автомобільних дорогах</p><table>",
           "<tr><th>Індекс</th><th>Назва</th><th>Місце</th><th>Швидкість</th></tr>"]
    out += [f"<tr>{cells(r)}</tr>" for r in roads] + ["</table>"]
    for town, rows in towns:
        out += [f"<p>{heading.format(town=town)}</p><table><tr><th>Адреса</th><th>Швидкість</th></tr>"]
        out += [f"<tr>{cells(r)}</tr>" for r in rows] + ["</table>"]
    return "".join(out) + "</body></html>"


@pytest.fixture
def small_list(monkeypatch):
    """Lists of tens of rows count as whole ones."""
    monkeypatch.setattr(cameras, "FLOOR", {"road": 10, "city": 10, "towns": 5})


def copy_of(tmp_path: Path, html: str, day: str = "2026-10-01") -> Path:
    path = tmp_path / "mvs.json"
    write_snapshot(page_tables(html), path, day)
    return path


def blocked():
    raise urllib.error.URLError("403 Forbidden")


def test_the_page_in_the_lists_shape_is_used(small_list, tmp_path: Path):
    good = page_html(ROADS, TOWNS)
    got = mvs_rows(copy_of(tmp_path, good), lambda: good, TODAY)
    assert (got.source, len(got.rows), got.warnings) == ("mvs.gov.ua 2026-10-28", 80, [])


def test_a_few_unreadable_rows_are_left_out_of_a_page_used(small_list, tmp_path: Path):
    odd = [*ROADS[:-1], ("М-01", "Північ - Південь", "біля мосту", "90 км/год")]
    got = mvs_rows(copy_of(tmp_path, page_html(ROADS, TOWNS)), lambda: page_html(odd, TOWNS), TODAY)
    assert (got.source, len(got.rows)) == ("mvs.gov.ua 2026-10-28", 79)
    assert got.warnings == ["1 unreadable rows left out: М-01 | Північ - Південь | біля мосту | 90 км/год"]


@pytest.mark.parametrize(
    "page, why",
    [
        # Town tables' headings reworded: no town rows.
        (lambda: page_html(ROADS, TOWNS, heading="Камери: {town}"), "0 town rows, fewer than 10"),
        # The km column moved: every road row unreadable.
        (lambda: page_html([(r[0], r[2], r[1], r[3]) for r in ROADS], TOWNS), "40 of 40 road rows unreadable"),
        # Half the roads gone at once: someone should look first.
        (lambda: page_html(ROADS[:20], TOWNS), "20 road rows against the copy's 40"),
        (lambda: "<html><body>Технічні роботи</body></html>", "0 road rows, fewer than 10"),
    ],
)
def test_a_page_in_another_shape_is_set_aside_for_the_copy(small_list, tmp_path: Path, page, why):
    got = mvs_rows(copy_of(tmp_path, page_html(ROADS, TOWNS)), page, TODAY)
    assert (got.source, len(got.rows)) == ("copy of 2026-10-01", 80)
    assert got.warnings[0].startswith("the MVS page was set aside") and why in got.warnings[0]


def test_an_unreachable_page_and_a_stale_copy_are_warned_of(small_list, tmp_path: Path):
    got = mvs_rows(copy_of(tmp_path, page_html(ROADS, TOWNS), "2026-07-01"), blocked, TODAY)
    assert got.source == "copy of 2026-07-01" and len(got.rows) == 80
    assert got.warnings == [
        "the MVS page could not be read: <urlopen error 403 Forbidden>",
        "the committed copy of the list is 119 days old: refresh it (`tiles mvs`)",
    ]


def test_warnings_reach_the_github_job_summary(tmp_path: Path, monkeypatch, capsys):
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    report(["the MVS page could not be read: 403"], "720 cameras")
    assert "::warning title=Speed cameras (MVS list)::the MVS page could not be read: 403" in capsys.readouterr().out
    assert summary.read_text(encoding="utf-8") == "### Speed cameras\n\n720 cameras\n\n- ⚠️ the MVS page could not be read: 403\n\n"


def test_refreshing_the_copy_takes_the_same_checks(small_list, tmp_path: Path):
    copy = copy_of(tmp_path, page_html(ROADS, TOWNS))
    moved = page_html([(r[0], r[2], r[1], r[3]) for r in ROADS], TOWNS)
    written, notes = refresh_snapshot(path=copy, fetch=lambda: moved)
    assert not written and "40 of 40 road rows unreadable" in notes
    assert len(parse_tables(json.loads(copy.read_text(encoding="utf-8")))) == 80
    grown = page_html(ROADS + [(r[0], r[1], r[2].replace("+000", "+500"), r[3]) for r in ROADS[:5]], TOWNS)
    assert refresh_snapshot(path=copy, fetch=lambda: grown) == (True, [])
    assert refresh_snapshot(path=copy, fetch=lambda: moved, force=True)[0]


# --- Cameras from a small extract ----------------------------------------------------------

LAT0, LON0 = 50.0, 30.0
KM = 1000 / (6_371_008.8 * math.pi / 180)  # one km of latitude, degrees
# The road М-01 runs north 30 km (a node every km, 1000 + k); its cameras are named as the list names them.
ROAD = [(1000 + k, LAT0 + k * KM, LON0) for k in range(31)]
CAMERA_NODES = {
    1005: {"highway": "speed_camera", "name": 'ККШ "М-01 5+000"', "direction": "forward", "maxspeed": "110"},
    1015: {"highway": "speed_camera", "name": 'ККШ "М-01 15+000"'},
    1025: {"highway": "speed_camera", "name": 'ККШ "М-01 25+000"', "direction": "both"},
}
# Places the rows head towards: Північ north of the road's end, Південь south of its start.
PLACES = [(1, "Північ", "city", LAT0 + 40 * KM, LON0), (2, "Південь", "town", LAT0 - 10 * KM, LON0)]
# A one-way street heading east with an unnamed camera, an enforcement relation's device and its `from`.
TOWN = (50.6, 31.0)
EAST = KM / 1000 / math.cos(math.radians(TOWN[0]))  # one metre east, degrees
STREET = [(2000 + i, TOWN[0], TOWN[1] + i * 100 * EAST) for i in range(6)]  # вулиця Шевченка, 500 m east
ONE_WAY = [(3000 + i, TOWN[0] + 0.01, TOWN[1] + i * 100 * EAST) for i in range(3)]
LOOSE = [
    (4000, TOWN[0] + 0.0002, TOWN[1] + 410 * EAST, {"addr:street": "вулиця Шевченка", "addr:housenumber": "10"}),
    (4001, TOWN[0] + 0.02, TOWN[1], {}),  # an enforcement relation's `from`
    (4002, TOWN[0] + 0.02 + 0.001, TOWN[1], {}),  # its device, north of it
    (4003, TOWN[0] + 0.0001, TOWN[1] + 205 * EAST,
     {"highway": "speed_camera", "name": 'ККШ "м. Місто, вул. Шевченка, 20"', "direction": "123"}),
]


def osm_xml() -> str:
    def tags(t):
        return "".join(f'<tag k="{k}" v="{escape(v)}"/>' for k, v in t.items())

    out = ['<?xml version="1.0" encoding="UTF-8"?>', '<osm version="0.6" generator="test">']
    for nid, lat, lon in ROAD:
        out.append(f'<node id="{nid}" version="1" lat="{lat:.7f}" lon="{lon:.7f}">{tags(CAMERA_NODES.get(nid, {}))}</node>')
    for nid, name, kind, lat, lon in PLACES:
        out.append(f'<node id="{nid}" version="1" lat="{lat:.7f}" lon="{lon:.7f}">{tags({"place": kind, "name": name})}</node>')
    out.append(f'<node id="3" version="1" lat="{TOWN[0]:.7f}" lon="{TOWN[1]:.7f}">{tags({"place": "city", "name": "Місто"})}</node>')
    for nid, lat, lon in STREET:
        out.append(f'<node id="{nid}" version="1" lat="{lat:.7f}" lon="{lon:.7f}"/>')
    for nid, lat, lon in ONE_WAY:
        t = {"highway": "speed_camera"} if nid == 3001 else {}
        out.append(f'<node id="{nid}" version="1" lat="{lat:.7f}" lon="{lon:.7f}">{tags(t)}</node>')
    for nid, lat, lon, t in LOOSE:
        out.append(f'<node id="{nid}" version="1" lat="{lat:.7f}" lon="{lon:.7f}">{tags(t)}</node>')
    nds = lambda ids: "".join(f'<nd ref="{i}"/>' for i in ids)  # noqa: E731
    out.append(f'<way id="1" version="1">{nds(n for n, *_ in ROAD)}{tags({"highway": "trunk", "ref": "М-01"})}</way>')
    out.append(f'<way id="2" version="1">{nds(n for n, *_ in STREET)}{tags({"highway": "residential", "name": "вулиця Шевченка"})}</way>')
    out.append(f'<way id="3" version="1">{nds(n for n, *_ in ONE_WAY)}{tags({"highway": "tertiary", "oneway": "-1"})}</way>')
    out.append('<relation id="1" version="1"><member type="node" ref="4002" role="device"/>'
               '<member type="node" ref="4001" role="from"/>' + tags({"type": "enforcement", "enforcement": "maxspeed", "maxspeed": "60"}) + "</relation>")
    out.append("</osm>")
    return "\n".join(out)


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("cameras")
    pbf = tmp / "net.osm"
    pbf.write_text(osm_xml(), encoding="utf-8")
    copy = tmp / "mvs.json"
    write_snapshot(page_tables(PAGE), copy, "2026-10-01")
    output = tmp / "cameras.json"
    with pytest.MonkeyPatch.context() as mp:
        # The test page's 8 rows are a whole list.
        mp.setattr(cameras, "FLOOR", {"road": 1, "city": 1, "towns": 1})
        stats = build_cameras(pbf, output, "2026-10-03", copy, lambda: PAGE)
    return json.loads(output.read_text(encoding="utf-8")), stats


def near(cameras, lat, lon, within_m=5.0):
    found = [c for c in cameras if dist_m((c[0], c[1]), (lat, lon)) < within_m]
    assert len(found) == 1, (lat, lon, found)
    return found[0]


def test_the_file(built):
    data, stats = built
    assert data["format"] == 1 and data["osm_date"] == "2026-10-03"
    assert data["mvs"]["rows"] == 8 and data["mvs"]["source"].startswith("mvs.gov.ua")
    assert data["cameras"] == sorted(data["cameras"])
    assert stats["cameras"] == len(data["cameras"])


def test_a_named_road_camera_takes_the_rows_limit_and_keeps_its_own_direction(built):
    cams = built[0]["cameras"]
    lat, lon, bearing, limit, flags = near(cams, LAT0 + 5 * KM, LON0)
    # Its row says 90, its tag 110: the list's. `forward` along the way north.
    assert (limit, flags) == (90, IN_OSM | ON_LIST)
    assert angle_diff(bearing, 0) < 1


def test_a_row_towards_a_place_gives_a_camera_without_direction_its_own(built):
    # 15+000 has no `direction`; its row says "у напрямку м. Північ": it looks north, at the traffic going south.
    assert angle_diff(near(built[0]["cameras"], LAT0 + 15 * KM, LON0)[2], 180) < 1
    # 25+000 says both ways: its row doesn't narrow it.
    assert near(built[0]["cameras"], LAT0 + 25 * KM, LON0)[2:] == [-1, 50, IN_OSM | ON_LIST]


def test_a_road_row_no_camera_names_is_placed_by_its_km_between_its_neighbours(built):
    lat, lon, bearing, limit, flags = near(built[0]["cameras"], LAT0 + 10 * KM, LON0, within_m=20)
    assert (limit, flags) == (70, ON_LIST)
    assert angle_diff(bearing, 0) < 1  # looking towards Південь, at the traffic going north


def test_town_rows_by_name_and_by_address(built):
    cams = built[0]["cameras"]
    # Named by its OSM camera: its numeric direction tells nothing.
    assert near(cams, TOWN[0] + 0.0001, TOWN[1] + 205 * EAST)[2:] == [-1, 50, IN_OSM | ON_LIST]
    # House 10, snapped onto its street; the lower of a seasonal pair.
    assert near(cams, TOWN[0], TOWN[1] + 410 * EAST, within_m=3)[2:] == [-1, 50, ON_LIST]
    # The crossing's streets don't meet in OSM and the bridge has no address: not placed.
    assert built[1]["town rows without their address in OSM"] == 2


def test_one_way_roads_and_enforcement_relations_give_the_direction(built):
    cams = built[0]["cameras"]
    # `oneway=-1` on a way drawn east: traffic goes west.
    assert near(cams, TOWN[0] + 0.01, TOWN[1] + 100 * EAST)[2:] == [270, 0, IN_OSM]
    # The relation's device, approached from the south; its maxspeed.
    assert near(cams, TOWN[0] + 0.021, TOWN[1])[2:] == [0, 60, IN_OSM]
