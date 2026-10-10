import json
from functools import cache
from pathlib import Path

import shapely
from shapely.geometry import Point, Polygon, box, shape

from tiles.world import mosaic

WORLD = Path(__file__).parent.parent / "style" / "world.geojson"


@cache
def features() -> list[dict]:
    return json.loads(WORLD.read_text(encoding="utf-8"))["features"]


def at(lon: float, lat: float, kind: str) -> list[dict]:
    """Properties of the `kind` features under a point."""
    p = Point(lon, lat)
    return [f["properties"] for f in features() if f["properties"]["kind"] == kind and shape(f["geometry"]).contains(p)]


def test_mosaic_closes_gaps_and_overlaps_between_neighbours():
    left = box(0, 0, 1, 1)
    right = Polygon([(1.000001, 0), (2, 0), (2, 1), (0.999999, 1)])  # a sliver of gap below, of overlap above
    a, b = mosaic([left, right])
    assert shapely.coverage_is_valid([a, b])
    assert abs(a.union(b).area - 2) < 1e-5 and a.intersection(b).area == 0


def test_russia_is_sea_and_its_neighbours_are_land():
    for lon, lat in [(37.62, 55.75), (36.59, 50.6), (20.51, 54.71), (131.9, 43.1)]:  # Moscow, Belgorod, Kaliningrad, Vladivostok
        assert not at(lon, lat, "land") and at(lon, lat, "water"), (lon, lat)
    for lon, lat in [(27.56, 53.9), (21.01, 52.23), (24.11, 56.95), (44.79, 41.72)]:  # Minsk, Warsaw, Riga, Tbilisi
        assert at(lon, lat, "land"), (lon, lat)  # over the water, which lies under all the world but Ukraine


def test_ukraine_is_land_left_out_where_the_active_region_shows_it():
    [kyiv] = at(30.52, 50.45, "land")
    assert {"covered:ukraine", "covered:kyiv", "covered:kyiv-city"} <= set(kyiv) and "covered:lviv" not in kyiv
    for lon, lat, region in [(34.1, 44.95, "crimea"), (37.8, 48.0, "donetsk"), (39.3, 48.57, "luhansk"), (36.23, 49.99, "kharkiv")]:
        [land] = at(lon, lat, "land")
        assert f"covered:{region}" in land and "covered:ukraine" in land, region
        assert not at(lon, lat, "water"), region


def test_rings_wind_the_way_maplibre_reads_holes():
    for f in features():
        for poly in shapely.get_parts(shape(f["geometry"])):
            if poly.geom_type != "Polygon":
                continue
            assert poly.exterior.is_ccw and all(not r.is_ccw for r in poly.interiors)


def test_the_sea_is_named_on_water():
    seas = [f for f in features() if f["properties"]["kind"] == "sea-label"]
    assert len(seas) == 4 and all(f["properties"]["name"] == "Ukrainian Sea" for f in seas)
    for f in seas:
        lon, lat = f["geometry"]["coordinates"]
        assert at(lon, lat, "water") and not at(lon, lat, "land"), (lon, lat)


def test_labels_name_every_country_but_russia():
    names = {f["properties"]["name"] for f in features() if f["properties"]["kind"] == "label"}
    assert {"Ukraine", "Poland", "Belarus"} <= names and "Russia" not in names
