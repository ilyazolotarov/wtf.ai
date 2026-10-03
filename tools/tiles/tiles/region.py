"""Region polygons (.poly) that clip the Ukraine extract.

A region is an OSM admin boundary, buffered so roads that cross the border
near the edge stay whole, simplified to keep the file small, and committed as
`regions/<name>.poly` so builds are reproducible without network lookups.
"""

from __future__ import annotations

import json
import math
import urllib.request
from pathlib import Path

from shapely.geometry import MultiPolygon, Polygon, shape
from shapely.ops import transform

NOMINATIM = "https://nominatim.openstreetmap.org/lookup?osm_ids=R{id}&format=json&polygon_geojson=1"
USER_AGENT = "wtf.ai-tiles/0.1"
M_PER_DEG_LAT = 110_540.0
M_PER_DEG_LON_EQ = 111_320.0


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
    """Osmosis .poly text (exterior rings only; holes are irrelevant for clipping)."""
    polygons = list(geom.geoms) if isinstance(geom, MultiPolygon) else [geom]
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


def write_region(name: str, relation_id: int, out_dir: Path, buffer_m: float = 3000, tolerance_m: float = 200) -> Path:
    geom = buffer_simplify(fetch_boundary(relation_id), buffer_m, tolerance_m)
    path = out_dir / f"{name}.poly"
    path.write_text(to_poly(name, geom), encoding="utf-8", newline="\n")
    return path
