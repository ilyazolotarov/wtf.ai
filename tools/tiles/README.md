# tiles — wtf.ai offline map data

Builds the offline map release from the Geofabrik Ukraine extract (SPEC §3.8). Today: display
maps (vector tiles + style). Next: the map-matching road graph, then Valhalla routing tiles.

Needs Python ≥ 3.11, Java ≥ 21 (Planetiler) and `osmium` (osmium-tool). Without `osmium` on
PATH (Windows) the build runs it in Docker, building `docker/osmium.Dockerfile` on first use.

```bash
pip install -e "tools/tiles[dev]"
cd tools/tiles
python -m tiles.cli regions                    # (re)write regions/*.poly from regions/regions.json
python -m tiles.cli build-all --heap 8g        # out/release/: ukraine, every region, index.json
python -m tiles.cli build-region chernihiv     # one region (+ index.json)
python -m tiles.cli index                      # shared files + index.json
python -m tiles.cli serve                      # http://<PC IP>:8765/ — app: Downloads → Map source
python -m tiles.cli osm-date                   # date of the current Geofabrik extract
python -m pytest
```

## Regions

`ukraine` plus its 27 ISO 3166-2 subdivisions (24 oblasts, Crimea, Kyiv city, Sevastopol),
listed with their OSM boundary relation in `regions/regions.json`. Each `.poly` is the
boundary's outer ring (holes filled, so enclaves belong to the surrounding region: Slavutych
is in both `chernihiv` and its own `kyiv` oblast), buffered by 500 m and simplified to ~20 m.

One `osmium extract --strategy smart` pass clips the Ukraine extract to every region
(`cache/extracts/`): only data inside the polygon, with ways and multipolygons that cross the
border kept whole. Planetiler then builds each region from its own extract, so its tiles hold
nothing from neighbouring regions at any zoom — only coarse Natural Earth context (borders,
large water) at z ≤ 6. Clipping tiles instead (Planetiler `--polygon`, `pmtiles extract`)
keeps whole tiles, which at z8 span ~150 km and showed half of Kyiv oblast in Chernihiv's map.

The first build downloads ~2.3 GB into `cache/` (gitignored): the Ukraine PBF, Planetiler and
its Natural Earth / water polygon sources. Later builds reuse it; `--refresh-osm` fetches a
new extract.

## Release (`out/release/`)

One flat directory, published as-is as GitHub release assets (release assets can't have
folders):

| Asset | |
|---|---|
| `index.json` | catalog: `format`, `osm_date`, `common[]` (asset, path, size, md5, sha256), `regions[]` (region, iso, name en/uk, bounds, asset, size, md5, sha256) |
| `<region>.pmtiles` | OpenMapTiles-schema vector tiles, clipped to the region polygon (Ukraine 1.2 GB, oblasts 36–89 MB) |
| `style.json` | OpenFreeMap Liberty (`style/liberty.json`, pinned snapshot); URLs use `{common}` (shared files directory) and `{tiles}` (region file), substituted by the app |
| `sprite-ofm*`, `font-<slug>-<range>.pbf` | Liberty sprite and Noto Sans glyphs (every range below U+3000: all alphabets and symbols, no CJK; plus variation selectors and full-width forms); `path` in index.json says where the app stores each |

The OpenMapTiles schema keeps the style identical to the online Liberty map, including the
app's dark re-tint (`src/config/map-dark.ts`).

`.github/workflows/map-packs.yml` runs weekly (and by hand: Actions → *Build Offline Map Packs*,
*force* to rebuild). If Geofabrik's extract is newer than the newest `maps-*` release it runs
`build-all` and publishes `out/release/` as release `maps-<osm_date>`, keeping the last 3.
Adding a region = an entry in `regions.json` + its `.poly`.

## In the app

Downloads lists the regions of the newest `maps-*` release (GitHub API → `index.json`). It
downloads the shared files once (again when their MD5s change, even under the same OSM
date) and any region's `.pmtiles` (iOS background session,
pause/resume across restarts), checks size and MD5, and stores them in `Documents/maps/`
(`src/services/offline-map/`). One downloaded region is active; the map uses only it, with no
online requests. Without a downloaded region the map falls back to online OpenFreeMap.

For testing, Downloads → *Map source* takes `http://<PC IP>:8765/` from `tiles serve`. Windows
Firewall may need to allow Python on private networks for the phone to connect.
