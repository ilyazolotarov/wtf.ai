# wtf.ai — Address Search Specification

Status: v2 (2026-10-10). Implements ROUTING-SPEC §10.2: search for a destination by place,
street, house number or POI, offline, in the downloaded region. Source of truth for coding agents.

## 1. Goal

1. Type "Шевченка 10", "shevchenka 10 kyiv", "Сільпо" or "Іванівка" and pick a destination to route to.
2. Offline: from a file built with the region and downloaded with it; nothing is sent anywhere.
3. Fast enough to search on every keystroke on the JS thread, also on the whole-Ukraine region.
4. Either script: a Cyrillic or Latin query finds Ukrainian names (and their English names).

## 2. Status

- **S1 built:** this spec; the index builder (`tools/tiles/tiles/search.py`, `tiles search`), part
  of every release build; the reader and ranking (`src/nav/search/`); download with the region;
  the route screen's search (UI-SPEC §7.1); `npm run search` on the PC. Tested on synthetic data
  only: no OSM extract could be fetched where it was written.
- **S2 done (2026-10-06):** the index is built for every region of the map release and downloads with it;
  tried briefly on the phone, it finds what was searched for.
- Next: tune ranking from real use (the queries of §8 with `npm run search`); multipolygon relations (§4.2).

## 3. Decisions

| Topic | Decision |
| --- | --- |
| Source | The region's clipped OSM extract (the one the tiles and graph come from), not the vector tiles: their house numbers have no street (ROUTING-SPEC §10.2). |
| File | `<region>.search.bin`, a release asset listed as the region's `search` entry in index.json (format stays 2: older apps ignore it). |
| Unit of search | *Entities*: places, streets (all ways of one name in one settlement, merged), POIs. House numbers hang off their street. |
| Settlement | Each street, POI or area belongs to the nearest settlement (`place=city/town/village/hamlet`), its distance divided by the kind's reach (15 / 6 / 2.5 / 1.2 km). No admin boundaries in v1. |
| Matching | Folded tokens (§4.1). Every word of the query must match the entity's own names or its settlement's, at least one its own. The word being typed is a prefix. |
| Ranking | Name match, kind and size, distance from the car (§5.3). |
| Reading | Random access through a `ByteSource`, as the road graph: a query reads a few posting lists and the entities it matches. |

## 4. Index (`tools/tiles/tiles/search.py`)

### 4.1 Folding (`fold`, mirrored by `src/nav/search/fold.ts`)

Lower case; NFC; Cyrillic → Latin (Ukrainian national transliteration without its word-start
forms, plus ё ы э ъ); apostrophes dropped; NFD and combining accents (U+0300–036F) dropped; then
`ye → ie`, `yu → iu`, `ya → ia`, so either spelling of є ю я matches; tokens are runs of
`[a-z0-9]`. House numbers fold the same way keeping `/` ("10-А" → "10a", "12/2"). Both sides
are tested against `src/nav/search/__fixtures__/fold-cases.json`.

Street and settlement kinds (вулиця, вул, провулок, проспект, street, село, …: `STOPWORDS`) are
indexed like any word but never required in a query: "вул. Шевченка" and "Шевченка" find the same.

### 4.2 What is read

- **Places**: nodes or ways with `place` = city, town, village, hamlet (settlements), suburb,
  quarter, neighbourhood, isolated_dwelling, locality, and a `name` (or `name:uk`).
- **Streets**: named ways with `highway` = motorway … residential, living_street, service, road,
  track, pedestrian. Merged by (folded name, settlement); shown at the middle vertex of the longest
  way, with its class; rank from total length and house count.
- **Addresses**: `addr:housenumber` with `addr:street` (on the street of that name in its
  settlement; else a same-named street whose extent is within 500 m; else an address-only street,
  tag `addr:street`, shown at its middle house) or `addr:place` (on that settlement, or a place of
  that name within 3 km, else an `addr:place` group). Ways at their nodes' centroid.
- **POIs**: named objects with amenity, shop, tourism, leisure, office, healthcare, craft,
  historic, `railway=station/halt` or `aeroway=aerodrome/terminal`.
- Names searched: `name`, `name:uk`, `name:en`, `name:ru`, `alt_name`, `old_name` (renamed streets),
  `official_name`. Shown: `name` (or `name:uk`), and `name:en` in English.
- Not yet: multipolygon relations (buildings and places mapped as relations), admin boundaries.

### 4.3 File (format 1, little-endian, sections 4-byte aligned)

| Section | Content |
| --- | --- |
| header, 76 B | `"WTFS"`, u16 format, u16 0, u32 entities, settlements, addresses, tokens, offsets of the 7 sections, 16 B OSM date, u32 build time, u32 file size |
| strings | u16 byte length + UTF-8, deduplicated (names, tags, house numbers) |
| entities, 44 B | u8 kind (1 place, 2 street, 3 POI), u8 0, u16 rank, i32 lat, lon (1e-6°), u32 name, name_en (or NONE), tag (strings), u32 parent (settlement entity or NONE), u32 first address, count, u32 first child, count |
| addresses, 12 B | u32 house number (string), i32 lat, lon |
| token offsets | u32 × (tokens + 1) into the token blob |
| token blob | the sorted tokens, ASCII |
| posting starts | u32 × (tokens + 1) into the postings |
| postings | u32 entity ids, ascending per token |

Order: settlements first (by rank), then every settlement's children (one contiguous range per
settlement: its `child`/`count`), then entities without a settlement. A street's houses are
contiguous, in natural order (2, 10, 10А, 12/2). `tiles search-check` validates a file.

## 5. Search (`src/nav/search/search-index.ts`)

### 5.1 Query

Split on spaces, commas and semicolons. The last piece that starts with a digit is the house
number, when other words come with it. Each piece is folded into words; the last word is a
prefix unless the query ends with a separator. A word is *optional* when it's a street kind, one
letter, or a prefix of a street kind being typed ("вули"); a query of optional words only finds
nothing.

With a house number the query runs twice: without it, reading the matched streets' houses; and
with it as a word ("8 Березня", "Квартал 50 років"). The better score of each result wins.

### 5.2 Matching

For each required word: the entity ids of every token it matches (one token, or the range it
prefixes; at most 60 000 ids), and the children ranges of the settlements among them. The word
with the fewest candidates drives: its ids and children are tested against every other word's
ids (binary search) or children ranges. At most 3 000 matches.

### 5.3 Ranking

1. Every match gets a cheap score from what the ids and record tell: 8 per word matched by its own
   names, 5 per word matched by its settlement's; kind and size (places 4 + 24 · rank/65535;
   streets 6–10 by length and houses; POIs 3); minus 7 · log10(1 + km from the car).
2. The best 250 (60 streets with a house number) are scored in full: per word 10 if it is a word
   of the shown name, 7 if it starts one (the word being typed), 6 if another name matched (old,
   Russian, alternative), 5 through the settlement; +6 if every word of the name was typed, −0.5 per
   word left out; plus kind and distance as above.
3. House numbers: exact +12, a number it starts +5 (≤ 5 per street), scored at the house; the
   street itself follows 4 below its houses (the number may be unmapped).

### 5.4 Measured (`npm run search`, Node, synthetic Ukraine-sized index)

28 000 settlements, 496 000 streets (60 % from 30 common names), 4.7 M addresses, 53 000 POIs:
97 MB, built in 2.5 min. Queries: 9–25 ms ("Шевченка": 10 000 streets of that name; "ше";
"Миру 1"), the first one including the token table (0.5 MB here). The phone (Hermes) is
expected several times slower; an oblast is about a 25th of this.

## 6. App

- **Download** (`src/services/offline-map/map-packs.ts`): the region's `search` asset is fetched
  with its tiles and graph (`<region>.search.bin`, size and MD5 checked), and is an update for
  regions installed before it ("Update available"). Removed with the region.
- **Reader** (`src/services/offline-map/search-file.ts`): `activeSearchIndex()` opens the active
  region's file (expo-file-system `FileHandle`), again when the region or the file changes.
- **Route screen** (`src/app/route.tsx`, UI-SPEC §7.1): with an index, the search field searches
  it 120 ms after typing stops, near the car's position; each result shows its name (", 10" for an
  address), what it is and its settlement, distance and direction. Picking one shows the
  destination card; Start guidance routes to it (`id` `search:<key>`, the name shown on the
  banner). Without one, the built-in city list and a note to download the region.
- **Quick picks** (empty field): saved places, recent destinations and the region's largest cities
  (`SearchIndex.majorSettlements`: the first settlements of the file, cities then towns by population),
  all limited to the active region (UI-SPEC §7.1).

## 7. Tools

```bash
cd tools/tiles
python -m tiles.cli search kyiv                      # out/release/kyiv.search.bin + index.json
python -m tiles.cli search-file some.osm.pbf out.search.bin
python -m tiles.cli search-check out/release/kyiv.search.bin
cd ../..
npm run search -- tools/tiles/out/release/kyiv.search.bin "Шевченка 10" "Сільпо" --near 50.45,30.52
```

## 8. To check on real data

1. Sizes and build time per oblast and for Ukraine.
2. Queries: a city, a village with a common name ("Іванівка"), a street in a city and a village,
   house numbers with letters and slashes, a renamed street by its old name, Latin spellings,
   POIs by brand, a street that crosses two settlements.
3. Wrong settlements: streets on a city's edge given to a village inside it, villages near a
   city's centre. Admin boundaries (`boundary=administrative`, admin_level 8/9) would fix them.
4. Timing on the iPhone (Ukraine region).

## 9. Open items

1. Settlements from admin boundaries instead of the nearest place node.
2. Relations: multipolygon buildings with addresses, place areas.
3. Typo tolerance (one edit for words of 5+ letters).
4. Show the result on the map before routing; search from the map screen.
