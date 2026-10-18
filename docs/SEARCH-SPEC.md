# wtf.ai — Address Search Specification

Offline search for a destination by place, street, house number or POI in the downloaded region (`tools/tiles/tiles/
search.py`, `src/nav/search/`). Source of truth for coding agents.

## 1. Goal

1. Type "Шевченка 10", "shevchenka 10 kyiv", "Сільпо" or "Іванівка" and pick a destination to route to.
2. Offline: from a file built with the region and downloaded with it; nothing is sent anywhere.
3. Fast enough to search on every keystroke on the JS thread, also on the whole-Ukraine region.
4. Either script: a Cyrillic or Latin query finds Ukrainian names (and their English names).

## 2. Decisions

| Topic | Decision |
| --- | --- |
| Source | The region's clipped OSM extract (the one the tiles and graph come from), not the vector tiles: their house numbers have no street. |
| File | `<region>.search.bin`, a release asset listed as the region's `search` entry in `index.json` (catalog format stays 2: older apps ignore it). |
| Unit of search | *Entities*: places, streets (all ways of one name in one settlement, merged), POIs. House numbers hang off their street. |
| Settlement | Each street, POI or area belongs to the nearest settlement (`place=city/town/village/hamlet`), its distance divided by the kind's reach (15 / 6 / 2.5 / 1.2 km). No admin boundaries yet. |
| Matching | Folded tokens (§3.1). Every word of the query must match the entity's own names or its settlement's, at least one its own. The word being typed is a prefix. |
| Ranking | Name match, kind and size, distance from the car (§4.3). |
| Reading | Random access through a `ByteSource`, as the road graph: a query reads a few posting lists and the entities it matches. |

## 3. Index (`tools/tiles/tiles/search.py`)

### 3.1 Folding (`fold`, mirrored by `src/nav/search/fold.ts`)

Lower case; NFC; Cyrillic → Latin (Ukrainian national transliteration without its word-start forms, plus ё ы э ъ);
apostrophes dropped; NFD and combining accents dropped; then `ye → ie`, `yu → iu`, `ya → ia`, so either spelling of
є ю я matches; tokens are runs of `[a-z0-9]`. House numbers fold the same way keeping `/` ("10-А" → "10a", "12/2").
Both sides are tested against `src/nav/search/__fixtures__/fold-cases.json`. Street and settlement kinds (вулиця,
вул, провулок, проспект, street, село, …: `STOPWORDS`) are indexed like any word but never required in a query.

### 3.2 What is read

- **Places**: nodes or ways with `place` = city, town, village, hamlet (settlements), suburb, quarter, neighbourhood,
  isolated_dwelling, locality, and a `name` (or `name:uk`).
- **Streets**: named ways with `highway` = motorway … residential, living_street, service, road, track, pedestrian;
  merged by (folded name, settlement); shown at the middle vertex of the longest way; rank from total length and
  house count.
- **Addresses**: `addr:housenumber` with `addr:street` (on the street of that name in its settlement; else a
  same-named street within 500 m; else an address-only street shown at its middle house) or `addr:place` (on that
  settlement, a place of that name within 3 km, else an `addr:place` group). Ways at their nodes' centroid.
- **POIs**: named objects with amenity, shop, tourism, leisure, office, healthcare, craft, historic,
  `railway=station/halt` or `aeroway=aerodrome/terminal`.
- Names searched: `name`, `name:uk`, `name:en`, `name:ru`, `alt_name`, `old_name`, `official_name`. Shown: `name`
  (or `name:uk`), and `name:en` in English.
- Not yet: multipolygon relations (buildings and places mapped as relations), admin boundaries.

### 3.3 File (format 1, little-endian, sections 4-byte aligned)

| Section | Content |
| --- | --- |
| header, 76 B | `"WTFS"`, u16 format, u16 0, u32 entities, settlements, addresses, tokens, offsets of the 7 sections, 16 B OSM date, u32 build time, u32 file size |
| strings | u16 byte length + UTF-8, deduplicated |
| entities, 44 B | u8 kind (1 place, 2 street, 3 POI), u8 0, u16 rank, i32 lat, lon (1e-6°), u32 name, name_en (or NONE), tag, u32 parent (settlement or NONE), u32 first address, count, u32 first child, count |
| addresses, 12 B | u32 house number (string), i32 lat, lon |
| token offsets | u32 × (tokens + 1) into the token blob |
| token blob | the sorted tokens, ASCII |
| posting starts | u32 × (tokens + 1) into the postings |
| postings | u32 entity ids, ascending per token |

Order: settlements first (by rank), then every settlement's children (one contiguous range per settlement), then
entities without a settlement. A street's houses are contiguous, in natural order (2, 10, 10А, 12/2).
`tiles search-check` validates a file.

## 4. Search (`src/nav/search/search-index.ts`)

### 4.1 Query

Split on spaces, commas and semicolons. The last piece that starts with a digit is the house number, when other
words come with it. Each piece is folded into words; the last word is a prefix unless the query ends with a
separator. A word is *optional* when it's a street kind, one letter, or a prefix of a street kind being typed; a
query of optional words only finds nothing. With a house number the query runs twice: without it, reading the matched
streets' houses; and with it as a word ("8 Березня"). The better score wins.

### 4.2 Matching

For each required word: the entity ids of every token it matches (one token, or the range it prefixes; at most
60 000 ids), and the children ranges of the settlements among them. The word with the fewest candidates drives: its
ids and children are tested against every other word's ids (binary search) or children ranges. At most 3 000 matches.

### 4.3 Ranking

1. A cheap score per match: 8 per word matched by its own names, 5 per word matched by its settlement's; kind and
   size (places 4 + 24 · rank/65535; streets 6–10 by length and houses; POIs 3); minus 7 · log10(1 + km from the car).
2. The best 250 (60 streets with a house number) are scored in full: per word 10 if it is a word of the shown name,
   7 if it starts one, 6 if another name matched (old, Russian, alternative), 5 through the settlement; +6 if every
   word of the name was typed, −0.5 per word left out; plus kind and distance.
3. House numbers: exact +12, a number it starts +5 (≤ 5 per street), scored at the house; the street itself follows
   4 below its houses.
4. A result that reads the same as a better one (kind, name, house number, settlement) within 150 m is dropped
   (`withoutRepeats`): OSM maps one address on the building, its entrances and its shops.

Measured in Node on a synthetic Ukraine-sized index (28 000 settlements, 496 000 streets, 4.7 M addresses, 53 000
POIs: 97 MB): queries 9–25 ms. The phone is several times slower; an oblast is about a 25th of this.

## 5. App

- **Download** (`src/services/offline-map/map-packs.ts`): the region's `search` asset with its tiles and graph (size
  and MD5 checked); an update for regions installed before it. Removed with the region.
- **Reader** (`src/services/offline-map/search-file.ts`): `activeSearchIndex()` opens the active region's file
  (`FileHandle`), again when the region or file changes.
- **Route screen** (`src/app/route.tsx`, UI-SPEC §7.1): the field searches 120 ms after typing stops, near the car's
  position; each result shows its name (", 10" for an address), what it is and its settlement, distance and
  direction. Start guidance routes to it (`id` `search:<key>`, the name shown on the banner).
- **Quick picks** (empty field): saved places, recent destinations and the region's largest cities
  (`SearchIndex.majorSettlements`: the first settlements of the file, cities then towns by population).

## 6. Tools

```bash
cd tools/tiles
python -m tiles.cli search kyiv                      # out/release/kyiv.search.bin + index.json
python -m tiles.cli search-file some.osm.pbf out.search.bin
python -m tiles.cli search-check out/release/kyiv.search.bin
cd ../..
npm run search -- tools/tiles/out/release/kyiv.search.bin "Шевченка 10" "Сільпо" --near 50.45,30.52
```

## 7. Open items

1. Settlements from admin boundaries (`boundary=administrative`, admin_level 8/9) instead of the nearest place node:
   streets on a city's edge are given to a village inside it.
2. Multipolygon relations: buildings with addresses, place areas.
3. Typo tolerance (one edit for words of 5+ letters).
4. Ranking tuned from real use (`npm run search` on real queries: a village with a common name, house numbers with
   letters and slashes, a renamed street by its old name, Latin spellings, POIs by brand, a street crossing two
   settlements); timing on the phone with the Ukraine region.
5. Show the result on the map before routing; search from the map screen.
