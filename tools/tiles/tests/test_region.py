from pathlib import Path

from shapely.geometry import Point, Polygon

from tiles.region import buffer_simplify, load_registry, read_poly, to_poly

SQUARE = Polygon([(31.0, 51.0), (31.1, 51.0), (31.1, 51.1), (31.0, 51.1)])


def test_poly_round_trip(tmp_path: Path):
    path = tmp_path / "sq.poly"
    path.write_text(to_poly("sq", SQUARE), encoding="utf-8")
    back = read_poly(path)
    assert back.symmetric_difference(SQUARE).area < 1e-12


def test_buffer_is_in_metres():
    grown = buffer_simplify(SQUARE, buffer_m=1000, tolerance_m=10)
    minx, miny, maxx, maxy = grown.bounds
    assert abs((SQUARE.bounds[1] - miny) * 110_540 - 1000) < 20
    assert abs((maxx - SQUARE.bounds[2]) * 111_320 * 0.629 - 1000) < 30  # cos(51.05°)


def test_committed_region_is_valid():
    region = read_poly(Path(__file__).parent.parent / "regions" / "chernihiv.poly")
    assert region.is_valid and region.contains(Polygon([(31.28, 51.49), (31.30, 51.49), (31.30, 51.50)]))


def test_every_registry_region_has_a_valid_poly():
    regions = Path(__file__).parent.parent / "regions"
    registry = load_registry(regions)
    assert "ukraine" in registry and len(registry) == 28
    ukraine = read_poly(regions / "ukraine.poly")
    for name in registry:
        poly = read_poly(regions / f"{name}.poly")
        assert poly.is_valid, name
        assert ukraine.buffer(0.01).contains(poly.representative_point()), name



def test_enclaves_stay_in_their_region():
    regions = Path(__file__).parent.parent / "regions"
    slavutych = Point(30.755, 51.522)  # Kyiv oblast exclave inside Chernihiv oblast
    assert read_poly(regions / "chernihiv.poly").contains(slavutych)
    kyiv = read_poly(regions / "kyiv.poly")
    assert len(kyiv.geoms) == 2 and kyiv.contains(slavutych)
