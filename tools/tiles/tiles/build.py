"""Build an offline map pack for one region.

Pack layout (everything the map needs, no network):

    out/<region>/
      manifest.json          format, region, OSM date, bounds, files with size + sha256
      map.pmtiles            OpenMapTiles-schema vector tiles (Planetiler)
      style.json             Liberty with `{pack}` placeholders (see style.py)
      sprites/ofm{,@2x}.{json,png}
      fonts/<slug>/<range>.pbf
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
from datetime import datetime, timezone
from pathlib import Path

from .region import read_poly
from .style import SPRITE_NAME, collect_fonts, font_slug, offline_style

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "cache"
OUT = ROOT / "out"
REGIONS = ROOT / "regions"
LIBERTY = ROOT / "style" / "liberty.json"

PLANETILER_VERSION = "0.10.2"
PLANETILER_URL = f"https://github.com/onthegomap/planetiler/releases/download/v{PLANETILER_VERSION}/planetiler.jar"
OSM_URL = "https://download.geofabrik.de/europe/ukraine-latest.osm.pbf"
USER_AGENT = "wtf.ai-tiles/0.1"
PACK_FORMAT = 1

# Glyph ranges for Ukrainian/Russian/English labels: Basic Latin … Cyrillic Supplement,
# Latin Extended Additional, General Punctuation (– „ “ …), Letterlike (№), Math.
GLYPH_RANGES = [0, 256, 512, 768, 1024, 1280, 7680, 8192, 8448, 8704]


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


def ensure_osm(refresh: bool) -> tuple[Path, str]:
    """Cached Ukraine extract and its date (Geofabrik Last-Modified, YYYY-MM-DD)."""
    pbf = CACHE / "ukraine-latest.osm.pbf"
    meta = CACHE / "ukraine-latest.osm.pbf.json"
    if refresh or not pbf.exists() or not meta.exists():
        log(f"Downloading {OSM_URL}")
        headers = download(OSM_URL, pbf)
        modified = email.utils.parsedate_to_datetime(headers["Last-Modified"])
        meta.write_text(json.dumps({"url": OSM_URL, "last_modified": modified.isoformat()}), encoding="utf-8")
    modified = datetime.fromisoformat(json.loads(meta.read_text(encoding="utf-8"))["last_modified"])
    return pbf, modified.date().isoformat()


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


def fetch_cached(url: str, cache_path: Path) -> Path | None:
    if not cache_path.exists():
        try:
            download(url, cache_path)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise
    return cache_path


def copy_glyphs(liberty: dict, pack: Path) -> None:
    base = liberty["glyphs"]
    for font in collect_fonts(liberty):
        for start in GLYPH_RANGES:
            rng = f"{start}-{start + 255}"
            url = base.replace("{fontstack}", urllib.parse.quote(font)).replace("{range}", rng)
            src = fetch_cached(url, CACHE / "glyphs" / font_slug(font) / f"{rng}.pbf")
            if src is None:
                log(f"  no glyphs for {font} {rng}")
                continue
            dest = pack / "fonts" / font_slug(font) / f"{rng}.pbf"
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dest)


def copy_sprites(liberty: dict, pack: Path) -> None:
    base = liberty["sprite"]
    sprite_id = base.rstrip("/").split("/")[-2]  # e.g. ofm_f384, pins the sprite version
    for suffix in (".json", ".png", "@2x.json", "@2x.png"):
        src = fetch_cached(base + suffix, CACHE / "sprites" / sprite_id / f"{SPRITE_NAME}{suffix}")
        if src is None:
            raise RuntimeError(f"sprite {base + suffix} not found")
        dest = pack / "sprites" / f"{SPRITE_NAME}{suffix}"
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def write_manifest(pack: Path, region: str, osm_date: str, poly: Path) -> dict:
    files = sorted(p for p in pack.rglob("*") if p.is_file() and p.name != "manifest.json")
    entries = [
        {"path": p.relative_to(pack).as_posix(), "size": p.stat().st_size, "sha256": sha256(p)} for p in files
    ]
    minx, miny, maxx, maxy = read_poly(poly).bounds
    manifest = {
        "format": PACK_FORMAT,
        "region": region,
        "version": osm_date,
        "osm_date": osm_date,
        "built_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "bounds": [round(v, 5) for v in (minx, miny, maxx, maxy)],
        "total_size": sum(e["size"] for e in entries),
        "files": entries,
    }
    (pack / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8", newline="\n")
    return manifest


def build_map(region: str, refresh_osm: bool = False, heap: str = "4g", skip_tiles: bool = False) -> Path:
    poly = REGIONS / f"{region}.poly"
    if not poly.exists():
        raise FileNotFoundError(f"{poly} missing; create it with `tiles region {region} <relation-id>`")
    liberty = json.loads(LIBERTY.read_text(encoding="utf-8"))
    pack = OUT / region
    pack.mkdir(parents=True, exist_ok=True)

    pbf, osm_date = ensure_osm(refresh_osm)
    if not skip_tiles:
        run_planetiler(ensure_planetiler(), pbf, poly, pack / "map.pmtiles", heap)

    log("Glyphs and sprites")
    shutil.rmtree(pack / "fonts", ignore_errors=True)
    copy_glyphs(liberty, pack)
    copy_sprites(liberty, pack)

    style = offline_style(liberty, f"wtf.ai Liberty offline ({region})")
    (pack / "style.json").write_text(json.dumps(style, ensure_ascii=False), encoding="utf-8", newline="\n")

    manifest = write_manifest(pack, region, osm_date, poly)
    log(f"Pack {pack}: {len(manifest['files'])} files, {manifest['total_size'] / 1e6:.1f} MB, OSM {osm_date}")
    return pack
