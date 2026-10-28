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
python -m tiles.cli cameras                    # speed cameras only (+ index.json)
python -m tiles.cli mvs                        # refresh cameras/mvs.json, the committed copy of the MVS camera list
python -m tiles.cli index                      # shared files + index.json
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

Planetiler reads the extract with a street written onto every house that has none (`tiles/streets.py`:
its `addr:place`, else its associatedStreet relation's name; an `.osc` merged by `osmium apply-changes`
into `cache/streets/`): its house-number layer keeps one label per street and number in a tile, and
houses without a street all counted as one, so most of their numbers were missing from the map.

One `osmium extract --strategy smart` pass clips the Ukraine extract to every region
(`cache/extracts/`) for the road graphs and search indexes: only data inside the polygon, with
ways and multipolygons that cross the border kept whole. They build in parallel processes
(`--jobs`, one per CPU by default), Ukraine's first.

The first build downloads ~2.3 GB into `cache/` (gitignored): the Ukraine PBF, Planetiler,
go-pmtiles and Planetiler's Natural Earth / water polygon sources. Later builds reuse it;
`--refresh-osm` fetches a new extract.

## Release (`out/release/`)

One flat directory, published as-is to the update Worker's R2 bucket (`maps/<osm_date>/`):

| Asset | |
|---|---|
| `index.json` | catalog: `format`, `osm_date`, `common[]` (asset, path, size, md5, sha256), `regions[]` (region, iso, name en/uk, bounds, outline: outer rings simplified to ~1 km, asset, size, md5, sha256) |
| `<region>.graph.bin` | road graph for map matching (below); listed as the region's `graph` entry in index.json |
| `<region>.search.bin` | address search index ([SEARCH-SPEC.md](../../docs/SEARCH-SPEC.md)); the region's `search` entry |
| `<region>.pmtiles` | OpenMapTiles-schema vector tiles: Ukraine's by Planetiler (1.2 GB), the others cut from it on the region polygon, whole tiles (oblasts ~40–90 MB) |
| `style.json` | OpenFreeMap Liberty (`style/liberty.json`, pinned snapshot); URLs use `{common}` (shared files directory) and `{tiles}` (region file), substituted by the app |
| `world.geojson` | the world drawn around the active region (`style/world.geojson`, below) |
| `cameras.json` | the speed cameras of all Ukraine, OSM's and the MVS list's (below) |
| `sprite-ofm*`, `font-<slug>-<range>.pbf` | Liberty sprite and Noto Sans glyphs (every range below U+3000: all alphabets and symbols, no CJK; plus variation selectors and full-width forms); `path` in index.json says where the app stores each |

The OpenMapTiles schema keeps the style identical to the online Liberty map, including the
app's dark re-tint (`src/config/map-dark.ts`).

`.github/workflows/map-packs.yml` runs weekly (and by hand: Actions → *Build Offline Map Packs*,
*force* to rebuild). If Geofabrik's extract is newer than the maps on the update Worker it runs
`build-all`, uploads `out/release/` to the Worker (`npm run ota:upload -- --maps …`, docs/OTA.md) and makes it the
current release there (docs/UPDATES-SPEC.md §4). The Worker keeps one release (UPDATES-SPEC §2.1).
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

## Speed cameras (`tiles/cameras.py`)

The app's camera warnings ([UI-SPEC.md](../../docs/UI-SPEC.md) §6.5), one shared file for all Ukraine: every OSM
speed camera (`highway=speed_camera` nodes, the devices of `enforcement=maxspeed` relations) and every camera on the
Interior Ministry's list of cameras in service ([mvs.gov.ua](https://mvs.gov.ua/katalog-poslug/servisi-ta-poslugi-organiv-sistemi-vnutrisnix-sprav/avtofotovideofiksaciia-porusen-pdr/adresi-kamer-fotovideofiksaciyi-ta-dozvolena-svidkist-ruxu):
a national road and km or a town address, the direction, the limit). Mappers copy the list into camera names
(`ККШ "М-06 46+050"`): a row whose road and km, or street and house, a camera's name carries is that camera and gives
it its limit. A row no camera carries is placed: a town address on its house snapped onto the street, a crossing at
the streets' shared node, a road km on the road's main path calibrated on the same road's named cameras on either
side (only within 10 km of one: past that the error grows to hundreds of metres); placed within 150 m of an OSM
camera no row names, it is that camera. OSM cameras the list lacks stay. Each camera's direction is the traffic it
checks: `direction=forward|backward` along its way, a one-way road's, an enforcement relation's `from` → device, or a
row's "у напрямку X": away from X (the list names where the camera looks). Numeric `direction` values are left out
(mappers use both the camera's view and the traffic's): without one, both ways.

The page is read at build time and used only in the list's shape: every row readable (a road's index, km and limit;
a town row's address and limit; unreadable rows are left out, but past 5 % of a kind they set the page aside: its
columns moved), at least 50 road and 50 town rows in 10 towns, and 70–200 % of each count in the committed copy
(fewer or many more at once is for someone to look at). Otherwise (unreachable, blocked, a new layout) the committed
copy of its tables `cameras/mvs.json` is used. The build never fails over it: OSM's cameras stay whole. What went
wrong, left-out rows and a copy over 60 days old are warnings in the log, in the workflow's job summary
(`GITHUB_STEP_SUMMARY`, with `::warning` annotations) and in `cameras.json` (`mvs.warnings`); `mvs.source` says which
list was used. `tiles mvs` refreshes the copy from the page with the same checks against the copy there, and writes it
only when they pass (`--force` for a list that really changed that much). On the 2026-10-03 extract with the 2026-10-28 list: 720 cameras, 685 from OSM; of 425 rows 297 named
in OSM, 57 placed, 71 not (an address not in OSM, a bridge, a km far from any named camera); 482 with a direction,
625 with a limit; 22 KB.

    {"format": 1, "osm_date": "…", "mvs": {"rows": 425, "source": "mvs.gov.ua 2026-10-28", "warnings": […]?},
     "cameras": [[lat, lon, bearing, limit, flags], …]}

`bearing`: degrees clockwise from north of the traffic checked, −1 both ways; `limit`: km/h, 0 none given (the app
takes the road's); `flags`: 1 in OSM, 2 on the list.

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

Downloads lists the regions of the update Worker's current release (`maps/latest.json` → `index.json`). It
downloads the shared files once (again when their MD5s change, even under the same OSM
date) and a region's `.pmtiles`, `.graph.bin` and `.search.bin` (iOS background session,
pause/resume across restarts), checks size and MD5, and stores them in `Documents/maps/`
(`src/services/offline-map/`). One downloaded region is active; the map uses only it, with no
online requests. Without a downloaded region the app asks for one before showing the map.
