# tiles — wtf.ai offline map data

Builds offline map packs from the Geofabrik Ukraine extract (SPEC §3.8). Today: the display
pack (vector tiles + style). Next: the map-matching road graph, then Valhalla routing tiles.

Needs Python ≥ 3.11 and Java ≥ 21 (Planetiler).

```bash
pip install -e "tools/tiles[dev]"
cd tools/tiles
python -m tiles.cli region chernihiv 71249     # regions/chernihiv.poly from OSM relation (committed)
python -m tiles.cli build-map chernihiv        # → out/chernihiv/
python -m tiles.cli serve                      # http://<PC IP>:8765/ for the app
python -m pytest
```

The first build downloads ~2.3 GB into `cache/` (gitignored): the Ukraine PBF, Planetiler and
its Natural Earth / water polygon sources. Later builds reuse it; `--refresh-osm` fetches a new
extract, `--skip-tiles` only redoes style, glyphs, sprites and the manifest.

## Pack (`out/<region>/`)

| File | |
|---|---|
| `manifest.json` | `format`, `region`, `version` / `osm_date`, `bounds`, `total_size`, `files[]` (path, size, sha256) |
| `map.pmtiles` | OpenMapTiles-schema vector tiles from Planetiler, clipped to the region polygon |
| `style.json` | OpenFreeMap Liberty (`style/liberty.json`, pinned snapshot) with every URL pointing to `{pack}`; the app substitutes the pack's `file://` URL |
| `sprites/ofm{,@2x}.{json,png}` | Liberty sprite |
| `fonts/<slug>/<range>.pbf` | Noto Sans glyphs for Latin, Cyrillic and punctuation ranges; font stacks are renamed to slugs (`noto-sans-regular`) so glyph URLs have no spaces |

The OpenMapTiles schema keeps the style identical to the online Liberty map, including
the app's dark re-tint (`src/config/map-dark.ts`).

## Bundled pack (interim)

Until in-app downloads exist, one pack is embedded in the iOS app: `plugins/with-map-pack.js`
copies `tools/tiles/out/chernihiv/` into the app as `map-pack.bundle` at prebuild (skipped
with a warning if it's missing). CI gets the pack from the GitHub release named in
`bundled-pack.json`. To ship a new one:

```bash
python -m tiles.cli build-map chernihiv --refresh-osm
python -m tiles.cli pack chernihiv                  # → out/chernihiv.tar.gz
gh release create map-chernihiv-<osm_date> out/chernihiv.tar.gz --title "Map pack chernihiv <osm_date>" --notes "© OpenStreetMap contributors (ODbL), OpenMapTiles"
# then update "tag" in bundled-pack.json and push
```

The app prefers a downloaded pack (`Documents/map/`), then the bundled one, then the online map.

## Getting a pack onto the phone (dev)

Until hosted downloads exist: `tiles serve` on a PC in the same Wi-Fi, then in the app
**More → Offline data → Install from computer**, enter `http://<PC IP>:8765/chernihiv/` and
Download. The app downloads into `Documents/map.staging/`, checks each file's size and swaps it
into `Documents/map/`. From then on the map uses only the pack, with no online requests.

Windows Firewall may need to allow Python on private networks for the phone to connect.
