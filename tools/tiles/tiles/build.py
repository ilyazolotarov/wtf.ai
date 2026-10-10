"""Build the offline map release.

Planetiler builds Ukraine's tiles once; every other region's are cut from them (`pmtiles extract`
on the region's polygon, seconds instead of a Planetiler run each). Whole tiles are kept, so a
region's border tiles hold some of its neighbours; the app covers everything outside the region
with the world drawn around it (world.py), so none of it shows. One `osmium extract` pass clips the
Geofabrik extract to every region polygon in `regions/regions.json` (strategy `smart`: ways and
multipolygons crossing the border stay whole) for the road graphs and search indexes, built in
parallel processes.

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
import os
import platform
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from shapely.geometry import mapping

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
WORLD = ROOT / "style" / "world.geojson"  # tiles/world.py

PLANETILER_VERSION = "0.10.2"
PLANETILER_URL = f"https://github.com/onthegomap/planetiler/releases/download/v{PLANETILER_VERSION}/planetiler.jar"
PMTILES_VERSION = "1.31.2"
PMTILES_URL = "https://github.com/protomaps/go-pmtiles/releases/download/v{v}/{name}"
WHOLE = "ukraine"  # the region Planetiler builds; the others are cut from its tiles
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


def ensure_pmtiles() -> Path:
    """The go-pmtiles CLI for this machine (Windows or Linux, x86_64 or arm64)."""
    system = platform.system()
    arch = {"amd64": "x86_64", "x86_64": "x86_64", "arm64": "arm64", "aarch64": "arm64"}[platform.machine().lower()]
    exe = CACHE / f"pmtiles-{PMTILES_VERSION}" / ("pmtiles.exe" if system == "Windows" else "pmtiles")
    if not exe.exists():
        name = f"go-pmtiles_{PMTILES_VERSION}_{system}_{arch}.{'zip' if system == 'Windows' else 'tar.gz'}"
        log(f"Downloading {name}")
        archive = CACHE / name
        download(PMTILES_URL.format(v=PMTILES_VERSION, name=name), archive)
        shutil.unpack_archive(archive, exe.parent)
        exe.chmod(0o755)
    return exe


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
    """Style, sprites, glyphs and the world around the region, shared by all regions; returns [{asset, path}]."""
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

    put(WORLD, "world.geojson", "world.geojson")

    style = offline_style(liberty, "wtf.ai Liberty offline")
    (release / "style.json").write_text(json.dumps(style, ensure_ascii=False), encoding="utf-8", newline="\n")
    files.append({"asset": "style.json", "path": "style.json"})
    return files


def build_whole(clipped: Path, heap: str = "4g", release: Path = RELEASE) -> Path:
    """Planetiler on Ukraine's clipped extract → out/release/ukraine.pmtiles."""
    release.mkdir(parents=True, exist_ok=True)
    output = release / f"{WHOLE}.pmtiles"
    run_planetiler(ensure_planetiler(), clipped, REGIONS / f"{WHOLE}.poly", output, heap)
    log(f"{WHOLE}: {output.stat().st_size / 1e6:.1f} MB")
    return output


def extract_region(region: str, release: Path = RELEASE) -> Path:
    """The region's tiles cut from Ukraine's on its polygon → out/release/<region>.pmtiles."""
    whole = release / f"{WHOLE}.pmtiles"
    if not whole.exists():
        raise FileNotFoundError(f"{whole} missing: build {WHOLE} first (its tiles are cut from Ukraine's)")
    polygon = CACHE / "tmp" / f"{region}.geojson"
    polygon.parent.mkdir(parents=True, exist_ok=True)
    polygon.write_text(json.dumps(mapping(read_poly(REGIONS / f"{region}.poly"))), encoding="utf-8")
    output = release / f"{region}.pmtiles"
    subprocess.run([str(ensure_pmtiles()), "extract", str(whole), str(output), f"--region={polygon}"], check=True, capture_output=True)
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


def build_all(regions: list[str] | None = None, refresh_osm: bool = False, heap: str = "4g", jobs: int | None = None) -> dict:
    """Clip every region (or the given ones) from the Ukraine extract, build each, write index.json.
    A region other than Ukraine needs out/release/ukraine.pmtiles: its tiles are cut from it."""
    registry = load_registry(REGIONS)
    names = regions or list(registry)
    missing = [n for n in names if n not in registry or not (REGIONS / f"{n}.poly").exists()]
    if missing:
        raise FileNotFoundError(f"unknown regions or missing .poly: {missing}; see `tiles regions`")
    pbf, _ = ensure_osm(refresh_osm)
    clipped = clip_regions(pbf, names)
    if WHOLE in names:
        build_whole(clipped[WHOLE], heap=heap)
    for name in names:
        if name != WHOLE:
            extract_region(name)
    # Graphs and search indexes: one process each, the biggest regions first (Ukraine's take minutes).
    by_size = sorted(names, key=lambda n: clipped[n].stat().st_size, reverse=True)
    with ProcessPoolExecutor(jobs or os.cpu_count()) as pool:
        tasks = [pool.submit(build, name, clipped[name]) for name in by_size for build in (build_graph, build_search)]
        for task in tasks:
            task.result()
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
