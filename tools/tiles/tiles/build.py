"""Build the offline map release.

One `osmium extract` pass clips the Geofabrik extract to every region polygon in
`regions/regions.json` (strategy `smart`: ways and multipolygons crossing the border stay
whole), then Planetiler builds each region from its own clipped data. So a region's tiles
contain only that region at every zoom (no neighbouring data in the big low-zoom tiles),
apart from Natural Earth context at z ≤ 6.

Output is one flat directory, published as-is as GitHub release assets (`maps-<osm_date>`)
and served by `tiles serve` for LAN testing. The app downloads the shared files once and
any number of regions:

    out/release/
      index.json                 catalog: OSM date, shared files, regions (size, md5, sha256)
      <region>.pmtiles           OpenMapTiles-schema vector tiles, one per region
      <region>.graph.bin         road graph for map matching (graph.py, MAPMATCH-SPEC §4)
      <region>.search.bin        address search index (search.py, SEARCH-SPEC)
      style.json                 Liberty with `{common}` / `{tiles}` placeholders (style.py)
      sprite-ofm{,@2x}.{json,png}
      font-<slug>-<range>.pbf

Assets are flat (release assets can't have directories); each shared file's `path` in
index.json is where the app stores it, so the style's relative URLs resolve.
"""

from __future__ import annotations

import email.utils
import hashlib
import json
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from .graph import build_region_graph
from .region import load_registry, read_poly, region_outline
from .search import build_region_search
from .style import SPRITE_NAME, collect_fonts, font_slug, offline_style

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "cache"
OUT = ROOT / "out"
RELEASE = OUT / "release"
REGIONS = ROOT / "regions"
LIBERTY = ROOT / "style" / "liberty.json"

PLANETILER_VERSION = "0.10.2"
PLANETILER_URL = f"https://github.com/onthegomap/planetiler/releases/download/v{PLANETILER_VERSION}/planetiler.jar"
CLIP_BATCH = 4  # regions per osmium pass (memory)
OSMIUM_IMAGE = "wtf-osmium"  # docker/osmium.Dockerfile, used when `osmium` is not on PATH
OSM_URL = "https://download.geofabrik.de/europe/ukraine-latest.osm.pbf"
OSM_META = CACHE / "ukraine-latest.osm.pbf.json"
USER_AGENT = "wtf.ai-tiles/0.1"
INDEX_FORMAT = 2

# Every glyph range below U+3000: all alphabets OSM names use in Ukraine plus punctuation and
# symbol blocks (☦ ✝ ①), ~2.8 MB per font. A missing range logs a MapLibre error per label.
# CJK and up would be 30 MB more per font, so above it only variation selectors (U+FE0F after
# ✝ or ❤ in names) and full-width forms.
GLYPH_RANGES = [*range(0, 0x3000, 256), 0xFE00, 0xFF00]


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def download(url: str, dest: Path) -> dict[str, str]:
    """Download to `dest` atomically; returns response headers."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as res, open(tmp, "wb") as f:
        total = int(res.headers.get("Content-Length") or 0)
        done = 0
        while chunk := res.read(1 << 20):
            f.write(chunk)
            done += len(chunk)
            if total > 50 << 20:
                print(f"\r  {dest.name}: {done >> 20}/{total >> 20} MB", end="", file=sys.stderr, flush=True)
        headers = dict(res.headers.items())
    if total > 50 << 20:
        print(file=sys.stderr)
    tmp.replace(dest)
    return headers


def remote_osm_date() -> str:
    """Date (YYYY-MM-DD) of the current Geofabrik extract, without downloading it."""
    req = urllib.request.Request(OSM_URL, method="HEAD", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as res:
        return email.utils.parsedate_to_datetime(res.headers["Last-Modified"]).date().isoformat()


def ensure_osm(refresh: bool) -> tuple[Path, str]:
    """Cached Ukraine extract and its date (Geofabrik Last-Modified, YYYY-MM-DD)."""
    pbf = CACHE / "ukraine-latest.osm.pbf"
    if refresh or not pbf.exists() or not OSM_META.exists():
        log(f"Downloading {OSM_URL}")
        headers = download(OSM_URL, pbf)
        modified = email.utils.parsedate_to_datetime(headers["Last-Modified"])
        OSM_META.write_text(json.dumps({"url": OSM_URL, "last_modified": modified.isoformat()}), encoding="utf-8")
    return pbf, osm_date()


def osm_date() -> str:
    modified = datetime.fromisoformat(json.loads(OSM_META.read_text(encoding="utf-8"))["last_modified"])
    return modified.date().isoformat()


def ensure_planetiler() -> Path:
    jar = CACHE / f"planetiler-{PLANETILER_VERSION}.jar"
    if not jar.exists():
        log(f"Downloading Planetiler {PLANETILER_VERSION}")
        download(PLANETILER_URL, jar)
    return jar


def run_planetiler(jar: Path, pbf: Path, poly: Path, output: Path, heap: str) -> None:
    cmd = [
        "java", f"-Xmx{heap}", "-jar", str(jar),
        f"--osm-path={pbf}",
        f"--polygon={poly}",
        f"--output={output}",
        "--download",
        f"--download-dir={CACHE / 'sources'}",
        f"--tmpdir={CACHE / 'tmp'}",
        "--force",
    ]
    log("Running Planetiler: " + " ".join(cmd))
    subprocess.run(cmd, check=True)


def osmium_command() -> tuple[list[str], Callable[[Path], str]]:
    """`osmium` from PATH, else the Docker image (built on first use) with ROOT mounted at /work.
    Returns the command prefix and a function mapping local paths to paths it can see."""
    if shutil.which("osmium"):
        return ["osmium"], lambda path: str(path)
    images = subprocess.run(["docker", "images", "-q", OSMIUM_IMAGE], capture_output=True, text=True, check=True)
    if not images.stdout.strip():
        log("Building the osmium Docker image")
        dockerfile = ROOT / "docker" / "osmium.Dockerfile"
        subprocess.run(["docker", "build", "-t", OSMIUM_IMAGE, "-f", str(dockerfile), str(dockerfile.parent)], check=True)
    prefix = ["docker", "run", "--rm", "-v", f"{ROOT}:/work", "-w", "/work", OSMIUM_IMAGE]
    return prefix, lambda path: "/work/" + Path(path).resolve().relative_to(ROOT).as_posix()


def clip_regions(pbf: Path, names: list[str], batch: int = CLIP_BATCH) -> dict[str, Path]:
    """cache/extracts/<region>.osm.pbf for every region, `batch` regions per osmium pass
    (each output keeps its own node/way ID sets; all 28 at once needs well over 16 GB)."""
    prefix, to_cmd = osmium_command()
    out_dir = CACHE / "extracts"
    out_dir.mkdir(parents=True, exist_ok=True)
    for i in range(0, len(names), batch):
        group = names[i : i + batch]
        config = {
            "directory": to_cmd(out_dir),
            "extracts": [
                {"output": f"{n}.osm.pbf", "polygon": {"file_name": to_cmd(REGIONS / f"{n}.poly"), "file_type": "poly"}}
                for n in group
            ],
        }
        config_path = out_dir / "config.json"
        config_path.write_text(json.dumps(config, indent=1), encoding="utf-8")
        cmd = [*prefix, "extract", "--config", to_cmd(config_path), "--strategy", "smart", "--overwrite", to_cmd(pbf)]
        log(f"Clipping {', '.join(group)}")
        subprocess.run(cmd, check=True)
    return {name: out_dir / f"{name}.osm.pbf" for name in names}


def fetch_cached(url: str, cache_path: Path) -> Path | None:
    if not cache_path.exists():
        try:
            download(url, cache_path)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise
    return cache_path


def build_common(release: Path = RELEASE) -> list[dict[str, str]]:
    """Style, sprites and glyphs shared by all regions; returns [{asset, path}]."""
    liberty = json.loads(LIBERTY.read_text(encoding="utf-8"))
    release.mkdir(parents=True, exist_ok=True)
    files: list[dict[str, str]] = []

    def put(src: Path, asset: str, path: str) -> None:
        shutil.copyfile(src, release / asset)
        files.append({"asset": asset, "path": path})

    for font in collect_fonts(liberty):
        slug = font_slug(font)
        for start in GLYPH_RANGES:
            rng = f"{start}-{start + 255}"
            url = liberty["glyphs"].replace("{fontstack}", urllib.parse.quote(font)).replace("{range}", rng)
            src = fetch_cached(url, CACHE / "glyphs" / slug / f"{rng}.pbf")
            if src is None:
                log(f"  no glyphs for {font} {rng}")
                continue
            put(src, f"font-{slug}-{rng}.pbf", f"fonts/{slug}/{rng}.pbf")

    sprite = liberty["sprite"]
    sprite_id = sprite.rstrip("/").split("/")[-2]  # e.g. ofm_f384, pins the sprite version
    for suffix in (".json", ".png", "@2x.json", "@2x.png"):
        src = fetch_cached(sprite + suffix, CACHE / "sprites" / sprite_id / f"{SPRITE_NAME}{suffix}")
        if src is None:
            raise RuntimeError(f"sprite {sprite + suffix} not found")
        put(src, f"sprite-{SPRITE_NAME}{suffix}", f"sprites/{SPRITE_NAME}{suffix}")

    style = offline_style(liberty, "wtf.ai Liberty offline")
    (release / "style.json").write_text(json.dumps(style, ensure_ascii=False), encoding="utf-8", newline="\n")
    files.append({"asset": "style.json", "path": "style.json"})
    return files


def build_region(region: str, clipped: Path, heap: str = "4g", release: Path = RELEASE) -> Path:
    """Planetiler on the region's clipped extract → out/release/<region>.pmtiles."""
    poly = REGIONS / f"{region}.poly"
    release.mkdir(parents=True, exist_ok=True)
    output = release / f"{region}.pmtiles"
    run_planetiler(ensure_planetiler(), clipped, poly, output, heap)
    log(f"{region}: {output.stat().st_size / 1e6:.1f} MB")
    return output


def build_graph(region: str, clipped: Path, release: Path = RELEASE) -> Path:
    """Road graph from the region's clipped extract → out/release/<region>.graph.bin."""
    output = release / f"{region}.graph.bin"
    build_region_graph(clipped, REGIONS / f"{region}.poly", output, osm_date())
    return output


def build_search(region: str, clipped: Path, release: Path = RELEASE) -> Path:
    """Search index from the region's clipped extract → out/release/<region>.search.bin."""
    output = release / f"{region}.search.bin"
    build_region_search(clipped, output, osm_date())
    return output


def hashes(path: Path) -> dict[str, str | int]:
    md5, sha256 = hashlib.md5(), hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            md5.update(chunk)
            sha256.update(chunk)
    return {"size": path.stat().st_size, "md5": md5.hexdigest(), "sha256": sha256.hexdigest()}


def write_index(common: list[dict[str, str]], release: Path = RELEASE) -> dict:
    """index.json for every region present in `release` (registry order)."""
    registry = load_registry(REGIONS)
    regions = []
    for name, info in registry.items():
        tiles = release / f"{name}.pmtiles"
        if not tiles.exists():
            continue
        poly = read_poly(REGIONS / f"{name}.poly")
        minx, miny, maxx, maxy = poly.bounds
        entry = {
            "region": name,
            "iso": info["iso"],
            "name": {"en": info["name_en"], "uk": info["name_uk"]},
            "bounds": [round(v, 5) for v in (minx, miny, maxx, maxy)],
            "outline": region_outline(poly),
            "asset": tiles.name,
            **hashes(tiles),
        }
        graph = release / f"{name}.graph.bin"
        if graph.exists():
            entry["graph"] = {"asset": graph.name, **hashes(graph)}
        search = release / f"{name}.search.bin"
        if search.exists():
            entry["search"] = {"asset": search.name, **hashes(search)}
        regions.append(entry)
    index = {
        "format": INDEX_FORMAT,
        "osm_date": osm_date(),
        "built_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "common": [{**f, **hashes(release / f["asset"])} for f in common],
        "regions": regions,
    }
    (release / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8", newline="\n")
    log(f"index.json: {len(regions)} regions, OSM {index['osm_date']}, "
        f"{sum(r['size'] for r in regions) / 1e9:.2f} GB")
    return index


def build_all(regions: list[str] | None = None, refresh_osm: bool = False, heap: str = "4g") -> dict:
    """Clip every region (or the given ones) from the Ukraine extract, build each, write index.json."""
    registry = load_registry(REGIONS)
    names = regions or list(registry)
    missing = [n for n in names if n not in registry or not (REGIONS / f"{n}.poly").exists()]
    if missing:
        raise FileNotFoundError(f"unknown regions or missing .poly: {missing}; see `tiles regions`")
    pbf, _ = ensure_osm(refresh_osm)
    for name, clipped in clip_regions(pbf, names).items():
        build_region(name, clipped, heap=heap)
        build_graph(name, clipped)
        build_search(name, clipped)
    return write_index(build_common())


def build_searches(regions: list[str] | None = None, refresh_osm: bool = False) -> dict:
    """Search indexes only (clipping regions whose extract is missing), then index.json."""
    registry = load_registry(REGIONS)
    names = regions or list(registry)
    unknown = [n for n in names if n not in registry]
    if unknown:
        raise FileNotFoundError(f"unknown regions: {unknown}")
    pbf, _ = ensure_osm(refresh_osm)
    missing = [n for n in names if refresh_osm or not (CACHE / "extracts" / f"{n}.osm.pbf").exists()]
    if missing:
        clip_regions(pbf, missing)
    for name in names:
        build_search(name, CACHE / "extracts" / f"{name}.osm.pbf")
    return write_index(build_common())


def build_graphs(regions: list[str] | None = None, refresh_osm: bool = False) -> dict:
    """Road graphs only (clipping regions whose extract is missing), then index.json."""
    registry = load_registry(REGIONS)
    names = regions or list(registry)
    unknown = [n for n in names if n not in registry]
    if unknown:
        raise FileNotFoundError(f"unknown regions: {unknown}")
    pbf, _ = ensure_osm(refresh_osm)
    missing = [n for n in names if refresh_osm or not (CACHE / "extracts" / f"{n}.osm.pbf").exists()]
    if missing:
        clip_regions(pbf, missing)
    for name in names:
        build_graph(name, CACHE / "extracts" / f"{name}.osm.pbf")
    return write_index(build_common())
