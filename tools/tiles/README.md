# tiles — wtf.ai offline map data

Builds the offline map release from the Geofabrik Ukraine extract (SPEC §3.8): display maps
(vector tiles + style) and the road graph for map matching and routing.

Needs Python ≥ 3.11, Java ≥ 21 (Planetiler) and `osmium` (osmium-tool). Without `osmium` on
PATH (Windows) the build runs it in Docker, building `docker/osmium.Dockerfile` on first use.

```bash
pip install -e "tools/tiles[dev]"
cd tools/tiles
python -m tiles.cli regions                    # (re)write regions/*.poly from regions/regions.json
python -m tiles.cli border                     # the app's Ukraine border for GNSS integrity (src/nav/integrity/ukraine-border.ts)
python -m tiles.cli world                      # style/world.geojson: the world drawn around a region (below)
python -m tiles.cli build-all --heap 8g        # out/release/: ukraine, every region, index.json
python -m tiles.cli build-region kyiv     # one region (+ index.json; its tiles are cut from ukraine.pmtiles)
python -m tiles.cli graph kyiv            # road graph only, from the cached extract (+ index.json)
python -m tiles.cli graph-check out/release/kyiv.graph.bin
python -m tiles.cli search kyiv            # address search index only (+ index.json)
python -m tiles.cli search-check out/release/kyiv.search.bin
python -m tiles.cli index                      # shared files + index.json
python -m tiles.cli serve                      # http://<PC IP>:8765/ — app: Downloads → Map source
python -m tiles.cli osm-date                   # date of the current Geofabrik extract
python -m pytest
```

## Regions

`ukraine` plus its 27 ISO 3166-2 subdivisions (24 oblasts, Crimea, Kyiv city, Sevastopol),
listed with their OSM boundary relation in `regions/regions.json`. Each `.poly` is the
boundary's outer ring (holes filled, so enclaves belong to the surrounding region as
well as to their own), buffered by 500 m and simplified to ~20 m.

Planetiler builds Ukraine's tiles once; every other region's are cut from them by
`pmtiles extract` on its `.poly` (under a second each, against ~80 s for a Planetiler run;
~6 % larger). Whole tiles are kept, so a region's border tiles, up to ~150 km at z8, hold parts
of its neighbours: the app covers everything outside the region with the world drawn around
it (below), so none of it shows. Building `kyiv` alone therefore needs `out/release/ukraine.pmtiles`.

One `osmium extract --strategy smart` pass clips the Ukraine extract to every region
(`cache/extracts/`) for the road graphs and search indexes: only data inside the polygon, with
ways and multipolygons that cross the border kept whole. They build in parallel processes
(`--jobs`, one per CPU by default), Ukraine's first.

The first build downloads ~2.3 GB into `cache/` (gitignored): the Ukraine PBF, Planetiler,
go-pmtiles and Planetiler's Natural Earth / water polygon sources. Later builds reuse it;
`--refresh-osm` fetches a new extract.

## Release (`out/release/`)

One flat directory, published as-is as GitHub release assets (release assets can't have
folders):

| Asset | |
|---|---|
| `index.json` | catalog: `format`, `osm_date`, `common[]` (asset, path, size, md5, sha256), `regions[]` (region, iso, name en/uk, bounds, outline: outer rings simplified to ~1 km, asset, size, md5, sha256) |
| `<region>.graph.bin` | road graph for map matching (below); listed as the region's `graph` entry in index.json |
| `<region>.search.bin` | address search index ([SEARCH-SPEC.md](../../docs/SEARCH-SPEC.md)); the region's `search` entry |
| `<region>.pmtiles` | OpenMapTiles-schema vector tiles: Ukraine's by Planetiler (1.2 GB), the others cut from it on the region polygon, whole tiles (oblasts ~40–90 MB) |
| `style.json` | OpenFreeMap Liberty (`style/liberty.json`, pinned snapshot); URLs use `{common}` (shared files directory) and `{tiles}` (region file), substituted by the app |
| `world.geojson` | the world drawn around the active region (`style/world.geojson`, below) |
| `sprite-ofm*`, `font-<slug>-<range>.pbf` | Liberty sprite and Noto Sans glyphs (every range below U+3000: all alphabets and symbols, no CJK; plus variation selectors and full-width forms); `path` in index.json says where the app stores each |

The OpenMapTiles schema keeps the style identical to the online Liberty map, including the
app's dark re-tint (`src/config/map-dark.ts`).

`.github/workflows/map-packs.yml` runs weekly (and by hand: Actions → *Build Offline Map Packs*,
*force* to rebuild). If Geofabrik's extract is newer than the newest `maps-*` release it runs
`build-all` and publishes `out/release/` as release `maps-<osm_date>`, keeping the last 3.
Adding a region = an entry in `regions.json` + its `.poly`.

## Road graph (`tiles/graph.py`)

The map-matching particle filter's road network ([MAPMATCH-SPEC.md](../../docs/MAPMATCH-SPEC.md) §4):
drivable OSM ways split at junctions into edges, simplified to 1 m, with class, one-way, flags,
turn restrictions and speed attributes for route times (speed limit, unpaved, urban / city / big
city, traffic lights and stop signs; ROUTING-SPEC §4.1). pyosmium reads the region's clipped
extract in three passes (ways and restrictions; locations and controls of only the nodes those
ways use; settlements: place points and areas, built-up landuse), so Ukraine builds in ~8 min
with a ~3 GB peak, an oblast in seconds.

The file is tiled at z14 with a directory, so the app reads only the tiles near its position
hypotheses: the 452 MB Ukraine graph costs about what a 15 MB oblast does. Byte layout:
MAPMATCH-SPEC §4.5; sizes: §4.7.

## World around the region (`tiles/world.py`)

A region's tiles end at its border, and at z ≤ 6 they carry whatever Natural Earth context their
few tiles hold, so outside the region the map changed with zoom. `style/world.geojson` (committed;
`tiles world` rewrites it) is drawn over the tiles instead, by `src/config/map-world.ts`, with
the pack style's own colours and line and label styles:

- `water` under the whole world but Ukraine, and the sea inside each oblast's boundary;
- `land`: Natural Earth countries (`ne_10m_admin_0_countries_ukr`, the Ukrainian point of view:
  Crimea and the occupied oblasts are Ukraine), ~250 m detail near Ukraine and ~4 km elsewhere,
  grown to meet Ukraine's OSM border; and each oblast's land;
- `border`: Natural Earth country borders, Ukraine's from its oblasts; `region-border`: oblast
  borders on land;
- `label`: country names (Natural Earth label point and rank), replacing the tiles' own.

Russia is neither land nor border: it is the Ukrainian Sea (`sea-label`: «Ukrainian Sea / Українське море», at its middle and, from z5, off Ukraine's border).

Oblasts are their OSM boundaries (Nominatim at ~1 m, cached in `cache/boundaries/`), rebuilt as a
gapless mosaic and simplified together (~40 m, shared edges kept shared): an oblast edge is where a
region's real map meets the drawn one. Each separate piece of an oblast carries `covered:<region>`
for every region whose `.poly` holds it (`ukraine` holds all, `kyiv` holds Kyiv city, an exclave is
held by the oblast around it too); the app leaves those out, so the active region's tiles show
through. A pack without `world.geojson` gets the plain style.

## In the app

Downloads lists the regions of the newest `maps-*` release (GitHub API → `index.json`). It
downloads the shared files once (again when their MD5s change, even under the same OSM
date) and a region's `.pmtiles`, `.graph.bin` and `.search.bin` (iOS background session,
pause/resume across restarts), checks size and MD5, and stores them in `Documents/maps/`
(`src/services/offline-map/`). One downloaded region is active; the map uses only it, with no
online requests. Without a downloaded region the app asks for one before showing the map.

For testing, Downloads → *Map source* takes `http://<PC IP>:8765/` from `tiles serve`. Windows
Firewall may need to allow Python on private networks for the phone to connect.
