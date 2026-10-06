import json
import os
from pathlib import Path

import pytest

from tiles.search import (
    KIND_PLACE, KIND_POI, KIND_STREET, NONE, build_index, fold, fold_house, read_objects,
    read_search, validate, write_index,
)

REPO = Path(__file__).resolve().parents[3]
FOLD_CASES = REPO / "src" / "nav" / "search" / "__fixtures__" / "fold-cases.json"
# The app's search tests read this file (src/nav/search/__tests__). Regenerate after a
# format or fixture change: UPDATE_FIXTURES=1 python -m pytest.
TS_FIXTURE = REPO / "src" / "nav" / "search" / "__fixtures__" / "town.search.bin"


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
    # building (way 110) on Шевченка, city
    40: (at(C, 1, 1.2), {}), 41: (at(C, 1.2, 1.2), {}), 42: (at(C, 1.2, 1.4), {}), 43: (at(C, 1, 1.4), {}),
    # shop area (way 120)
    50: (at(C, 4, -1.8), {}), 51: (at(C, 4.2, -1.8), {}), 52: (at(C, 4.2, -1.6), {}),
    # address nodes
    60: (at(C, 2, 1.2), {"addr:street": "вулиця Шевченка", "addr:housenumber": "10"}),
    61: (at(C, 3, 1.2), {"addr:street": "вулиця Шевченка", "addr:housenumber": "10А"}),
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
    stats = write_index(entities, path, "2026-10-01", built_at=1_790_000_000)
    return raw, stats, path, read_search(path)


def test_reading(built):
    raw, _, _, _ = built
    assert sorted(display for p in raw.places for display in [p.names["name"]]) == ["Іванівка", "Подусівка", "Чернігів"]
    assert len(raw.streets) == 4
    assert len(raw.addresses) == 10  # 9 nodes + the building
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
    assert sf.houses(city_shev) == ["1", "2", "10", "10А", "12/2"]  # natural order


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


def test_ts_fixture_is_current(built):
    _, _, path, _ = built
    data = path.read_bytes()
    if os.environ.get("UPDATE_FIXTURES") == "1":
        TS_FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        TS_FIXTURE.write_bytes(data)
    assert TS_FIXTURE.exists() and TS_FIXTURE.read_bytes() == data, "TS fixture is stale: UPDATE_FIXTURES=1 python -m pytest"
