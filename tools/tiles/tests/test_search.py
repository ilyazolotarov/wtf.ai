import json
import os
from pathlib import Path

import numpy as np
import pytest

from tiles.graph import date_stamp
from tiles.search import (
    CELL_DT, ENTRANCE_DT, FLAG_ENTRANCES, HEADER, KIND_PLACE, KIND_POI, KIND_STREET, NONE, PLACE_DT, TRAILER,
    build_index, cell_key, fold, fold_house, read_objects, read_search, stop_place, validate, write_index,
)

REPO = Path(__file__).resolve().parents[3]
FOLD_CASES = REPO / "src" / "nav" / "search" / "__fixtures__" / "fold-cases.json"
# The app's search tests read this file (src/nav/search/__tests__). Regenerate after a
# format or fixture change: UPDATE_FIXTURES=1 python -m pytest.
TS_FIXTURE = REPO / "src" / "nav" / "search" / "__fixtures__" / "town.search.bin"
AREAS_FIXTURE = REPO / "src" / "nav" / "search" / "__fixtures__" / "areas.search.bin"


def test_fold_cases_shared_with_the_app():
    cases = json.loads(FOLD_CASES.read_text(encoding="utf-8"))
    for text, tokens in cases["tokens"]:
        assert fold(text) == tokens, text
    for text, house in cases["houses"]:
        assert fold_house(text) == house, text


# --- Fixture: a city, a village 12 km away, a suburb ---------------------------------------
#
# Chernihiv (city) at C; Ivanivka (village) at V, ~12 km south-west; Podusivka (suburb) in
# the city. "вулиця Шевченка" in both the city (two ways, merged) and the village; "проспект
# Миру" with name:en and old_name; houses on both Шевченка, an address-only street "вулиця
# Нова", an `addr:place` house in the village; a fuel station node and a shop area. Places to
# stop at: the fuel stations (one unnamed), a café with a brand only, a 24/7 pharmacy, a fast-food
# kiosk, a charging station in another cell, a public parking area and a private one (left out).

C = (31.2947, 51.4939)
V = (31.15, 51.41)
D = 0.001


def at(base, dx, dy):
    return (base[0] + dx * D, base[1] + dy * D)


NODES = {
    1: (C, {"place": "city", "name": "Чернігів", "name:en": "Chernihiv", "population": "285234"}),
    2: (V, {"place": "village", "name": "Іванівка", "name:en": "Ivanivka"}),
    3: (at(C, 3, 3), {"place": "suburb", "name": "Подусівка"}),
    # Шевченка (city): way 101 = 10–12, way 102 = 12–15
    10: (at(C, 0, 1), {}), 11: (at(C, 1, 1), {}), 12: (at(C, 2, 1), {}), 13: (at(C, 3, 1), {}), 14: (at(C, 4, 1), {}), 15: (at(C, 5, 1), {}),
    # Миру
    20: (at(C, 0, -2), {}), 21: (at(C, 5, -2), {}),
    # Шевченка (village)
    30: (at(V, -1, 0), {}), 31: (at(V, 1, 0), {}),
    # building (way 110) on Шевченка, city; entrances 1 and 2 on its outline, a garage door (left out)
    40: (at(C, 1, 1.2), {"entrance": "staircase", "ref": "2"}), 41: (at(C, 1.2, 1.2), {"entrance": "staircase", "ref": "1"}),
    42: (at(C, 1.2, 1.4), {"entrance": "garage", "ref": "9"}), 43: (at(C, 1, 1.4), {}),
    # an entrance of no addressed building, without a number
    72: (at(C, 6, 6), {"entrance": "yes"}),
    # shop area (way 120)
    50: (at(C, 4, -1.8), {}), 51: (at(C, 4.2, -1.8), {}), 52: (at(C, 4.2, -1.6), {}),
    # address nodes
    60: (at(C, 2, 1.2), {"addr:street": "вулиця Шевченка", "addr:housenumber": "10"}),
    61: (at(C, 3, 1.2), {"addr:street": "вулиця Шевченка", "addr:housenumber": "10А"}),
    # "10" mapped three more times beside it (its shops, an address point): one house in search
    73: (at(C, 2.02, 1.2), {"addr:street": "вулиця Шевченка", "addr:housenumber": "10", "shop": "bakery"}),
    74: (at(C, 2.04, 1.2), {"addr:street": "вулиця Шевченка", "addr:housenumber": "10"}),
    75: (at(C, 2.06, 1.2), {"addr:street": "вулиця Шевченка", "addr:housenumber": "10"}),
    62: (at(C, 0.5, 1.2), {"addr:street": "вулиця Шевченка", "addr:housenumber": "2"}),
    63: (at(C, 4, 1.2), {"addr:street": "вулиця Шевченка", "addr:housenumber": "12/2"}),
    64: (at(V, 0, 0.2), {"addr:street": "вулиця Шевченка", "addr:housenumber": "10"}),
    65: (at(C, -3, 0), {"addr:street": "вулиця Нова", "addr:housenumber": "7"}),
    66: (at(C, -3, 0.2), {"addr:street": "вулиця Нова", "addr:housenumber": "5"}),
    67: (at(V, 0.5, -0.5), {"addr:place": "Іванівка", "addr:housenumber": "5"}),
    68: (at(C, 1, -2.2), {"addr:street": "проспект Миру", "addr:housenumber": "1"}),
    # POI
    70: (at(C, 2, -1.5), {"amenity": "fuel", "name": "WOG", "brand": "WOG", "opening_hours": "24/7",
                          "fuel:diesel": "yes", "fuel:lpg": "yes", "fuel:octane_95": "yes", "fuel:octane_98": "no"}),
    # unnamed fuel: no POI, a place to stop at
    71: (at(C, 2, -2.5), {"amenity": "fuel"}),
    76: (at(C, -2, -1), {"amenity": "cafe", "brand": "Aroma Kava"}),
    77: (at(C, -2, -3), {"amenity": "parking", "access": "private"}),
    78: (at(C, -1, -1), {"amenity": "pharmacy", "opening_hours": " 24/7 "}),
    79: (at(C, 8, 0), {"amenity": "charging_station"}),
    84: (at(C, -1, -1.2), {"amenity": "fast_food"}),
    # public parking area (way 140)
    80: (at(C, -1, -3), {}), 81: (at(C, -0.6, -3), {}), 82: (at(C, -0.6, -2.6), {}), 83: (at(C, -1, -2.6), {}),
}

WAYS = [
    (101, [10, 11, 12], {"highway": "residential", "name": "вулиця Шевченка", "name:en": "Shevchenka Street"}),
    (102, [12, 13, 14, 15], {"highway": "tertiary", "name": "вулиця Шевченка"}),
    (103, [20, 21], {"highway": "secondary", "name": "проспект Миру", "name:en": "Myru Avenue", "old_name": "проспект Леніна"}),
    (104, [30, 31], {"highway": "residential", "name": "вулиця Шевченка"}),
    (110, [40, 41, 42, 43, 40], {"building": "yes", "addr:street": "вулиця Шевченка", "addr:housenumber": "1"}),
    (120, [50, 51, 52, 50], {"shop": "supermarket", "name": "Сільпо", "name:en": "Silpo"}),
    # unnamed road: dropped
    (130, [20, 30], {"highway": "track"}),
    (140, [80, 81, 82, 83, 80], {"amenity": "parking", "access": "yes"}),
]


def osm_xml() -> str:
    def tags(t: dict[str, str]) -> str:
        return "".join(f'<tag k="{k}" v="{v}"/>' for k, v in t.items())

    out = ['<?xml version="1.0" encoding="UTF-8"?>', '<osm version="0.6" generator="test">']
    for nid, ((lon, lat), t) in NODES.items():
        out.append(f'<node id="{nid}" version="1" lat="{lat:.7f}" lon="{lon:.7f}">{tags(t)}</node>')
    for wid, refs, t in WAYS:
        out.append(f'<way id="{wid}" version="1">' + "".join(f'<nd ref="{r}"/>' for r in refs) + tags(t) + "</way>")
    out.append("</osm>")
    return "\n".join(out)


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("search")
    osm = tmp / "town.osm"
    osm.write_text(osm_xml(), encoding="utf-8")
    raw = read_objects(osm)
    entities = build_index(raw)
    path = tmp / "town.search.bin"
    stats = write_index(entities, path, "2026-10-01", built_at=1_790_000_000,
                        loose_entrances=[e for e in raw.entrances if not e.owned], stops=raw.stops)
    return raw, stats, path, read_search(path)


def test_a_rebuild_writes_the_same_bytes(built, tmp_path):
    # Stamped with the OSM date's midnight, not the clock (as the road graph).
    raw, _, _, _ = built
    a, b = tmp_path / "a.search.bin", tmp_path / "b.search.bin"
    for path in (a, b):
        write_index(build_index(raw), path, "2026-10-01", loose_entrances=[e for e in raw.entrances if not e.owned], stops=raw.stops)
    assert a.read_bytes() == b.read_bytes()
    assert read_search(a).built_at == date_stamp("2026-10-01")


def test_reading(built):
    raw, _, _, _ = built
    assert sorted(display for p in raw.places for display in [p.names["name"]]) == ["Іванівка", "Подусівка", "Чернігів"]
    assert len(raw.streets) == 4
    assert len(raw.addresses) == 13  # 12 nodes + the building
    assert [p.names["name"] for p in raw.pois] == ["Сільпо", "WOG"]
    shop = next(p for p in raw.pois if p.names["name"] == "Сільпо")
    assert shop.lon == pytest.approx(int((C[0] + (4 + 0.4 / 3) * D) * 1e7), abs=20)  # centroid, closing node once


def test_file_is_valid(built):
    _, stats, _, sf = built
    assert validate(sf) == []
    assert sf.osm_date == "2026-10-01" and sf.built_at == 1_790_000_000
    assert stats["places"] == 3 and stats["pois"] == 2


def test_settlements_first_and_children_contiguous(built):
    _, _, _, sf = built
    (city,) = sf.find("Чернігів")
    (village,) = sf.find("Іванівка", KIND_PLACE)
    assert (city, village) == (0, 1) and sf.settlements == 2  # by rank
    c = sf.entities[city]
    kids = range(int(c["child"]), int(c["child"] + c["nchild"]))
    names = {sf.string(int(sf.entities[i]["name"])) for i in kids}
    assert names == {"Подусівка", "вулиця Шевченка", "проспект Миру", "вулиця Нова", "WOG", "Сільпо"}
    assert sf.entities[city]["parent"] == NONE


def test_streets_merged_per_settlement(built):
    _, _, _, sf = built
    shev = sf.find("вулиця Шевченка", KIND_STREET)
    assert len(shev) == 2
    parents = {sf.string(int(sf.entities[int(sf.entities[i]["parent"])]["name"])) for i in shev}
    assert parents == {"Чернігів", "Іванівка"}
    city_shev = next(i for i in shev if sf.string(int(sf.entities[int(sf.entities[i]["parent"])]["name"])) == "Чернігів")
    e = sf.entities[city_shev]
    assert sf.string(int(e["name_en"])) == "Shevchenka Street"
    assert sf.string(int(e["tag"])) == "highway=tertiary"  # the longer way's class
    assert sf.houses(city_shev) == ["1", "2", "10", "10", "10", "10", "10А", "12/2"]  # natural order


def test_address_only_street_and_addr_place(built):
    _, _, _, sf = built
    (nova,) = sf.find("вулиця Нова")
    assert sf.entities[nova]["kind"] == KIND_STREET and sf.string(int(sf.entities[nova]["tag"])) == "addr:street"
    assert sf.houses(nova) == ["5", "7"]
    (village,) = sf.find("Іванівка", KIND_PLACE)
    assert sf.houses(village) == ["5"]


def test_tokens_cover_every_name(built):
    _, _, _, sf = built
    (myru,) = sf.find("проспект Миру")
    for token in ("myru", "avenue", "lenina", "prospekt"):
        assert myru in sf.posting(token), token
    (wog,) = sf.find("WOG")
    assert sf.entities[wog]["kind"] == KIND_POI and sf.string(int(sf.entities[wog]["tag"])) == "amenity=fuel"
    assert sf.find("Сільпо")[0] in sf.posting("silpo")


def test_entrances_hang_off_their_address(built):
    _, stats, _, sf = built
    assert validate(sf) == [] and stats["entrances"] == 3 and stats["numbered_entrances"] == 2
    shev = sf.find("вулиця Шевченка", KIND_STREET)
    city_shev = next(i for i in shev if sf.houses(i)[0] == "1")
    first = int(sf.entities[city_shev]["addr"])  # house "1": the building with the entrances
    mine = sf.entrances[sf.entrances["address"] == first]
    assert [sf.string(int(r)) for r in mine["ref"]] == ["1", "2"]  # in order, the garage left out
    loose = sf.entrances[sf.entrances["address"] == NONE]
    assert len(loose) == 1 and loose[0]["ref"] == NONE
    assert sf.entrances["address"][-1] == NONE  # sorted: the loose ones last


def test_stop_place_tags():
    def place(**tags):
        item = stop_place({k.replace("_", ":", 1) if k.startswith("fuel_") else k: v for k, v in tags.items()})
        return None if item is None else (int(item.tags["category"]), int(item.tags["flags"]), item.tags["name"])

    assert place(amenity="fuel") == (1, 0, "")
    assert place(amenity="charging_station") == (2, 0, "")
    assert place(amenity="cafe", name="Кава") == (3, 0, "Кава")
    assert place(amenity="fast_food") == place(amenity="restaurant") == (4, 0, "")
    assert place(amenity="pharmacy", opening_hours=" 24/7") == (5, 1, "")
    assert place(amenity="parking") == (6, 0, "")
    assert place(amenity="bank", name="Банк") is None and place(shop="kiosk") is None
    # name, else name:uk, else brand
    assert place(amenity="fuel", **{"name:uk": "ОККО"}, brand="OKKO")[2] == "ОККО"
    assert place(amenity="fuel", brand="OKKO")[2] == "OKKO"
    assert place(amenity="fuel", name="WOG", brand="ВОГ")[2] == "WOG"
    # fuels: = yes only, and only at a fuel station
    assert place(amenity="fuel", fuel_diesel="yes", fuel_lpg="yes", fuel_octane_92="yes", fuel_octane_95="yes",
                 fuel_octane_98="yes", opening_hours="24/7") == (1, 63, "")
    assert place(amenity="fuel", fuel_diesel="no", fuel_octane_95="yes", opening_hours="Mo-Su 06:00-23:00") == (1, 16, "")
    assert place(amenity="cafe", fuel_diesel="yes", opening_hours="24/7")[1] == 1
    # parking only where anyone may park
    for access in ("private", "customers", "no"):
        assert place(amenity="parking", access=access) is None
    assert place(amenity="parking", access="yes") == place(amenity="parking", access="permissive") == (6, 0, "")
    assert place(amenity="cafe", access="private") is not None


def test_places_by_cell(built):
    _, stats, _, sf = built
    assert validate(sf) == [] and stats["stops"] == 7
    pl, cells = sf.places, sf.cells
    rows = {(int(c), sf.string(int(n)), int(f)) for c, n, f in zip(pl["category"], pl["name"], pl["flags"])}
    # named or not; the private parking left out; WOG: 24/7, diesel, LPG, 95 (98 = no)
    assert rows == {(1, "WOG", 1 | 2 | 4 | 16), (1, None, 0), (3, "Aroma Kava", 0), (5, None, 1), (2, None, 0),
                    (4, None, 0), (6, None, 0)}
    assert (pl["reserved"] == 0).all()
    # the parking area at its nodes' centroid (the closing node once)
    (parking,) = pl[pl["category"] == 6]
    assert (int(parking["lon"]), int(parking["lat"])) == (round((C[0] - 0.8 * D) * 1e6), round((C[1] - 2.8 * D) * 1e6))
    # by cell, then lat, lon, category; the cells ascending, each range its cell's places, closed by (NONE, count)
    keys = [cell_key(int(p["lat"]), int(p["lon"])) for p in pl]
    order = sorted(range(len(pl)), key=lambda i: (keys[i], int(pl[i]["lat"]), int(pl[i]["lon"]), int(pl[i]["category"])))
    assert order == list(range(len(pl)))
    assert len(cells) == 2 + 1  # the town's and, east of it, the charging station's
    assert cells["key"].tolist()[:-1] == sorted(set(keys)) and tuple(cells[-1]) == (NONE, len(pl))
    for c in range(len(cells) - 1):
        lo, hi = int(cells[c]["first"]), int(cells[c + 1]["first"])
        assert lo < hi and all(keys[i] == int(cells[c]["key"]) for i in range(lo, hi))
    # the key: 0.01° rows from -90°, columns from -180°
    assert cell_key(51_493_900, 31_294_700) == 14149 * 36_000 + 21129
    assert cell_key(-90_000_000, -180_000_000) == 0 and cell_key(0, 179_999_999) == 9000 * 36_000 + 35_999


def test_place_section_checked(built, tmp_path):
    _, _, path, sf = built
    data = bytearray(path.read_bytes())
    at = len(data) - 2 * TRAILER.size
    o_places, n, magic = TRAILER.unpack_from(data, at)
    assert magic == b"WTFP" and n == len(sf.places)
    bad = bytearray(data)
    bad[o_places + 14] = 7  # the first place's category
    p = tmp_path / "bad.search.bin"
    p.write_bytes(bytes(bad))
    assert validate(read_search(p)) == ["place category out of 1–6"]
    bad = bytearray(data)
    o_cells = o_places + n * PLACE_DT.itemsize  # the first cell's key, moved off its places
    bad[o_cells : o_cells + 4] = (int(sf.cells[0]["key"]) + 1).to_bytes(4, "little")
    p.write_bytes(bytes(bad))
    assert any("outside their cell" in x for x in validate(read_search(p)))


def test_a_reader_before_places_reads_the_file_as_before(built):
    # The app before places: the header's size, flag 1 and the last 12 bytes (the entrances' trailer).
    _, _, path, sf = built
    data = path.read_bytes()
    fields = HEADER.unpack_from(data)
    flags, size = fields[2], fields[-1]
    assert size == len(data) and flags & FLAG_ENTRANCES and flags == 3
    o_entr, n_entr, magic = TRAILER.unpack_from(data, len(data) - TRAILER.size)
    assert magic == b"WTFE" and n_entr == 3
    entrances = np.frombuffer(data, dtype=ENTRANCE_DT, count=n_entr, offset=o_entr)
    assert entrances.tobytes() == sf.entrances.tobytes()
    assert o_entr + n_entr * ENTRANCE_DT.itemsize == TRAILER.unpack_from(data, len(data) - 2 * TRAILER.size)[0]
    # the places run up to their cells, the cells up to the places' trailer
    o_pl, n_pl, _ = TRAILER.unpack_from(data, len(data) - 2 * TRAILER.size)
    assert o_pl + n_pl * PLACE_DT.itemsize + len(sf.cells) * CELL_DT.itemsize == len(data) - 2 * TRAILER.size


def test_a_file_without_places_to_stop(tmp_path):
    # A region with none still has the section (flag 2): empty, its cell table only the closing entry.
    path = tmp_path / "none.search.bin"
    osm = tmp_path / "none.osm"
    osm.write_text('<?xml version="1.0" encoding="UTF-8"?><osm version="0.6">'
                   f'<node id="1" version="1" lat="{C[1]}" lon="{C[0]}"><tag k="place" v="city"/><tag k="name" v="Чернігів"/></node>'
                   "</osm>", encoding="utf-8")
    raw = read_objects(osm)
    write_index(build_index(raw), path, "2026-10-01", stops=raw.stops)
    sf = read_search(path)
    assert validate(sf) == [] and len(sf.places) == 0 and sf.cells.tolist() == [(NONE, 0)]


def test_associated_street_gives_houses_their_street(tmp_path):
    # Houses tagged with a number only, listed in an associatedStreet relation: as "house", with
    # no role, and one with its own addr:street (which wins). A relation's street way is no house.
    nodes = {
        1: (C, {"place": "city", "name": "Чернігів"}),
        10: (at(C, 0, 1), {}), 11: (at(C, 5, 1), {}),
        20: (at(C, 1, 1.2), {}), 21: (at(C, 1.2, 1.2), {}), 22: (at(C, 1.2, 1.4), {}),
        30: (at(C, 2, 1.2), {"addr:housenumber": "30"}),
        31: (at(C, 3, 1.2), {"addr:housenumber": "5", "addr:street": "вулиця Нова"}),
        32: (at(C, 4, 1.2), {"addr:housenumber": "99"}),  # in no relation: no street, dropped
    }
    ways = [
        (101, [10, 11], {"highway": "secondary", "name": "проспект Миру"}),
        (110, [20, 21, 22, 20], {"building": "apartments", "addr:housenumber": "28"}),
    ]
    out = ['<?xml version="1.0" encoding="UTF-8"?>', '<osm version="0.6" generator="test">']
    for nid, ((lon, lat), t) in nodes.items():
        out.append(f'<node id="{nid}" version="1" lat="{lat:.7f}" lon="{lon:.7f}">'
                   + "".join(f'<tag k="{k}" v="{v}"/>' for k, v in t.items()) + "</node>")
    for wid, refs, t in ways:
        out.append(f'<way id="{wid}" version="1">' + "".join(f'<nd ref="{r}"/>' for r in refs)
                   + "".join(f'<tag k="{k}" v="{v}"/>' for k, v in t.items()) + "</way>")
    out.append('<relation id="1" version="1"><member type="way" ref="101" role="street"/>'
               '<member type="way" ref="110" role="house"/><member type="node" ref="30" role=""/>'
               '<member type="node" ref="31" role="house"/>'
               '<tag k="type" v="associatedStreet"/><tag k="name" v="проспект Миру"/></relation>')
    out.append("</osm>")
    osm = tmp_path / "assoc.osm"
    osm.write_text("\n".join(out), encoding="utf-8")
    raw = read_objects(osm)
    assert sorted((a.tags["street"], a.tags["house"]) for a in raw.addresses) == [
        ("вулиця Нова", "5"), ("проспект Миру", "28"), ("проспект Миру", "30")]
    path = tmp_path / "assoc.search.bin"
    write_index(build_index(raw), path, "2026-10-01")
    sf = read_search(path)
    (myru,) = sf.find("проспект Миру", KIND_STREET)
    assert sf.houses(myru) == ["28", "30"]


def km(dx: float, dy: float) -> tuple[float, float]:
    """A point dx km east and dy km north of C."""
    return (C[0] + dx / (111.32 * 0.6225), C[1] + dy / 111.32)


def test_settlement_from_the_area_around_it(tmp_path):
    # A town with no area; village A's boundary (a relation) reaches a street nearer the town's
    # point; village B's (a closed way) holds a street nearer A's point. A hromada around them all
    # bears neither name. Outside every area: the nearest settlement with no area, else any.
    nodes = {
        1: (km(0, 0), {"place": "town", "name": "Залісся"}),
        2: (km(-3, 1), {"place": "village", "name": "Петрівка"}),
        3: (km(-6, 2.5), {"place": "village", "name": "Степове"}),
        10: (km(-0.2, 3), {}), 11: (km(0.2, 3), {}),  # S1: in A's area, 3 km from the town, 3.6 from A
        12: (km(-5, 1), {}), 13: (km(-4.6, 1), {}),  # S2: in B's area, 1.8 km from A, 1.9 from B
        14: (km(2, -1), {}), 15: (km(2.4, -1), {}),  # S3: in no area, by the town
        16: (km(-6.2, 4.5), {}), 17: (km(-5.8, 4.5), {}),  # S4: in no area, 2 km from B, 7.5 from the town
        30: (km(0.1, 3.05), {"addr:street": "вулиця Садова", "addr:housenumber": "7-А"}),
        # A's boundary 20–23, B's 24–27, the hromada's 40–43
        20: (km(-4.5, 0), {}), 21: (km(0.5, 0), {}), 22: (km(0.5, 4), {}), 23: (km(-4.5, 4), {}),
        24: (km(-8, 0), {}), 25: (km(-4.5, 0), {}), 26: (km(-4.5, 4), {}), 27: (km(-8, 4), {}),
        40: (km(-10, -5), {}), 41: (km(5, -5), {}), 42: (km(5, 8), {}), 43: (km(-10, 8), {}),
    }
    ways = [
        (101, [10, 11], {"highway": "residential", "name": "вулиця Садова"}),
        (102, [12, 13], {"highway": "residential", "name": "вулиця Садова"}),
        (103, [14, 15], {"highway": "residential", "name": "вулиця Лугова"}),
        (104, [16, 17], {"highway": "residential", "name": "вулиця Лісова"}),
        (120, [20, 21, 22, 23, 20], {}),
        (121, [24, 25, 26, 27, 24], {"boundary": "administrative", "admin_level": "9", "name": "Степове"}),
        (122, [40, 41, 42, 43, 40], {}),
    ]
    out = ['<?xml version="1.0" encoding="UTF-8"?>', '<osm version="0.6" generator="test">']
    for nid, ((lon, lat), t) in nodes.items():
        out.append(f'<node id="{nid}" version="1" lat="{lat:.7f}" lon="{lon:.7f}">'
                   + "".join(f'<tag k="{k}" v="{v}"/>' for k, v in t.items()) + "</node>")
    for wid, refs, t in ways:
        out.append(f'<way id="{wid}" version="1">' + "".join(f'<nd ref="{r}"/>' for r in refs)
                   + "".join(f'<tag k="{k}" v="{v}"/>' for k, v in t.items()) + "</way>")
    for rid, way, tags in ((1, 120, {"admin_level": "9", "name": "Петрівка", "place": "village"}),
                           (2, 122, {"admin_level": "7", "name": "Петрівська сільська громада"})):
        out.append(f'<relation id="{rid}" version="1"><member type="way" ref="{way}" role="outer"/>'
                   + "".join(f'<tag k="{k}" v="{v}"/>' for k, v in {"type": "boundary", "boundary": "administrative", **tags}.items())
                   + "</relation>")
    out.append("</osm>")
    osm = tmp_path / "areas.osm"
    osm.write_text("\n".join(out), encoding="utf-8")
    raw = read_objects(osm)
    assert sorted(min(a.keys) for a in raw.areas) == ["petrivka", "petrivska silska hromada", "stepove"]
    path = tmp_path / "areas.search.bin"
    write_index(build_index(raw), path, "2026-10-01", built_at=1_790_000_000)
    sf = read_search(path)
    assert validate(sf) == []
    if os.environ.get("UPDATE_FIXTURES") == "1":
        AREAS_FIXTURE.write_bytes(path.read_bytes())
    assert AREAS_FIXTURE.exists() and AREAS_FIXTURE.read_bytes() == path.read_bytes(), "TS fixture is stale: UPDATE_FIXTURES=1 python -m pytest"

    def settlement(entity: int) -> str:
        return sf.string(int(sf.entities[int(sf.entities[entity]["parent"])]["name"]))

    by_settlement = {settlement(i): i for i in sf.find("вулиця Садова", KIND_STREET)}
    assert set(by_settlement) == {"Петрівка", "Степове"}  # by nearest points: Залісся and Петрівка
    assert sf.houses(by_settlement["Петрівка"]) == ["7-А"]
    assert [settlement(i) for i in sf.find("вулиця Лугова")] == ["Залісся"]
    assert [settlement(i) for i in sf.find("вулиця Лісова")] == ["Степове"]
    # The reach carries A past a village's 2.5 km to its street's shown point 3.8 km away (+ 100 m for a pin).
    (village,) = sf.find("Петрівка", KIND_PLACE)
    assert 3_870 <= int(sf.entities[village]["reach"]) * 250 <= 4_000
    (town,) = sf.find("Залісся", KIND_PLACE)
    assert int(sf.entities[town]["reach"]) * 250 == 6_000  # its kind's: nothing farther


def test_ts_fixture_is_current(built):
    _, _, path, _ = built
    data = path.read_bytes()
    if os.environ.get("UPDATE_FIXTURES") == "1":
        TS_FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        TS_FIXTURE.write_bytes(data)
    assert TS_FIXTURE.exists() and TS_FIXTURE.read_bytes() == data, "TS fixture is stale: UPDATE_FIXTURES=1 python -m pytest"
