"""Region polygons (.poly) that clip the Ukraine extract.

`regions/regions.json` lists the regions (Ukraine plus its 27 ISO 3166-2 subdivisions) by
OSM boundary relation. Each boundary is buffered slightly (so simplification never cuts
into the region) and simplified to ~20 m, then committed as `regions/<slug>.poly` so builds
are reproducible without network lookups. Roads crossing the border stay whole anyway:
`osmium extract --strategy smart` keeps complete ways and multipolygons.
"""

from __future__ import annotations

import json
import math
import time
import urllib.request
from pathlib import Path
from typing import TypedDict

from shapely.geometry import MultiPolygon, Polygon, shape
from shapely.ops import transform, unary_union

NOMINATIM = (
    "https://nominatim.openstreetmap.org/lookup?osm_ids=R{id}&format=json"
    "&polygon_geojson=1&polygon_threshold=0.0001"
)
USER_AGENT = "wtf.ai-tiles/0.1"
M_PER_DEG_LAT = 110_540.0
M_PER_DEG_LON_EQ = 111_320.0


class RegionInfo(TypedDict):
    relation: int
    iso: str
    name_en: str
    name_uk: str


def load_registry(regions_dir: Path) -> dict[str, RegionInfo]:
    return json.loads((regions_dir / "regions.json").read_text(encoding="utf-8"))


def fetch_boundary(relation_id: int) -> Polygon | MultiPolygon:
    req = urllib.request.Request(NOMINATIM.format(id=relation_id), headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as res:
        data = json.load(res)
    if not data:
        raise ValueError(f"relation {relation_id} not found")
    return shape(data[0]["geojson"])


def buffer_simplify(geom: Polygon | MultiPolygon, buffer_m: float, tolerance_m: float) -> Polygon | MultiPolygon:
    """Buffer and simplify in metres on a local equirectangular projection."""
    lat0 = geom.centroid.y
    kx = M_PER_DEG_LON_EQ * math.cos(math.radians(lat0))
    to_m = lambda x, y, z=None: (x * kx, y * M_PER_DEG_LAT)  # noqa: E731
    to_deg = lambda x, y, z=None: (x / kx, y / M_PER_DEG_LAT)  # noqa: E731
    local = transform(to_m, geom).buffer(buffer_m).simplify(tolerance_m)
    return transform(to_deg, local)


def to_poly(name: str, geom: Polygon | MultiPolygon) -> str:
    """Osmosis .poly text of the outer rings, merged: holes (and anything inside them, like
    Kyiv oblast's enclaves within Kyiv city) belong to the region for clipping purposes."""
    parts = list(geom.geoms) if isinstance(geom, MultiPolygon) else [geom]
    merged = unary_union([Polygon(p.exterior) for p in parts])
    polygons = list(merged.geoms) if isinstance(merged, MultiPolygon) else [merged]
    lines = [name]
    for i, poly in enumerate(polygons, start=1):
        lines.append(str(i))
        lines += [f"   {x:.6f}   {y:.6f}" for x, y in poly.exterior.coords]
        lines.append("END")
    lines.append("END")
    return "\n".join(lines) + "\n"


def read_poly(path: Path) -> MultiPolygon:
    rings: list[list[tuple[float, float]]] = []
    current: list[tuple[float, float]] | None = None
    for line in path.read_text(encoding="utf-8").splitlines()[1:]:
        token = line.strip()
        if token == "END":
            if current is not None:
                rings.append(current)
            current = None
        elif current is None:
            current = []
        else:
            x, y = token.split()
            current.append((float(x), float(y)))
    return MultiPolygon([Polygon(r) for r in rings])


def write_region(name: str, relation_id: int, out_dir: Path, buffer_m: float = 500, tolerance_m: float = 20) -> Path:
    geom = buffer_simplify(fetch_boundary(relation_id), buffer_m, tolerance_m)
    path = out_dir / f"{name}.poly"
    path.write_text(to_poly(name, geom), encoding="utf-8", newline="\n")
    return path


def write_regions(regions_dir: Path, names: list[str] | None = None, buffer_m: float = 500) -> list[Path]:
    """(Re)write .poly files from the registry; Nominatim allows one request per second."""
    registry = load_registry(regions_dir)
    paths = []
    for i, name in enumerate(names or list(registry)):
        if i:
            time.sleep(1.1)
        paths.append(write_region(name, registry[name]["relation"], regions_dir, buffer_m=buffer_m))
    return paths



BORDER_BUFFER_M = 1500  # on top of the .poly's 500 m: a fix 2 km outside Ukraine's border is outside
BORDER_TOLERANCE_M = 500  # well inside the buffer, so simplifying never cuts into Ukraine


def border_ts(poly_path: Path, buffer_m: float = BORDER_BUFFER_M, tolerance_m: float = BORDER_TOLERANCE_M) -> str:
    """The country polygon for GNSS integrity (SPEC §3.3: a fix outside Ukraine is spoofed) as a
    TypeScript module, so the app and the Node replay import it without an asset loader."""
    geom = buffer_simplify(read_poly(poly_path), buffer_m, tolerance_m)
    parts = list(geom.geoms) if isinstance(geom, MultiPolygon) else [geom]
    rings = [[c for x, y in p.exterior.coords for c in (round(x, 4), round(y, 4))] for p in parts]
    body = ",\n".join("  [" + ", ".join(f"{v:.4f}" for v in ring) + "]" for ring in rings)
    return (
        f"// Generated by `python -m tiles.cli border` from tools/tiles/regions/{poly_path.name}: buffered by\n"
        f"// {buffer_m:.0f} m more and simplified to {tolerance_m:.0f} m (SPEC §3.3). Do not edit by hand.\n\n"
        "/** Outer rings as flat [lon, lat, lon, lat, …] arrays, WGS84 degrees. */\n"
        f"export const UKRAINE_BORDER: readonly (readonly number[])[] = [\n{body},\n];\n"
    )


OUTLINE_TOLERANCE_DEG = 0.01  # ~1 km: enough to tell which region a car is in


def region_outline(geom: Polygon | MultiPolygon, tolerance_deg: float = OUTLINE_TOLERANCE_DEG) -> list[list[list[float]]]:
    """The region's outer rings, simplified and rounded, for index.json: the app checks
    whether the car is inside the active region and which region it is in otherwise."""
    simple = geom.simplify(tolerance_deg, preserve_topology=True)
    polys = list(simple.geoms) if isinstance(simple, MultiPolygon) else [simple]
    return [[[round(x, 3), round(y, 3)] for x, y in p.exterior.coords] for p in polys if not p.is_empty]
