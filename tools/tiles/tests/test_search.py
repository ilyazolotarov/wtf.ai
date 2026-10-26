import json
import os
from pathlib import Path

import pytest

from tiles.graph import date_stamp
from tiles.search import (
    KIND_PLACE, KIND_POI, KIND_STREET, NONE, build_index, fold, fold_house, read_objects,
    read_search, validate, write_index,
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
# Нова", an `addr:place` house in the village; a fuel station node and a shop area.

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
    70: (at(C, 2, -1.5), {"amenity": "fuel", "name": "WOG", "brand": "WOG"}),
    # unnamed fuel: dropped
    71: (at(C, 2, -2.5), {"amenity": "fuel"}),
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
                        loose_entrances=[e for e in raw.entrances if not e.owned])
    return raw, stats, path, read_search(path)


def test_a_rebuild_writes_the_same_bytes(built, tmp_path):
    # Stamped with the OSM date's midnight, not the clock (as the road graph).
    raw, _, _, _ = built
    a, b = tmp_path / "a.search.bin", tmp_path / "b.search.bin"
    for path in (a, b):
        write_index(build_index(raw), path, "2026-10-01", loose_entrances=[e for e in raw.entrances if not e.owned])
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
