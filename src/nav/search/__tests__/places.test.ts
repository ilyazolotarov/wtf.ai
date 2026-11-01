import { readFileSync } from "node:fs";
import path from "node:path";

import { bufferByteSource, type ByteSource } from "@/nav/mapmatch/graph/byte-source";
import { PlaceFlag, SearchIndex, type PlaceCategory, type StopPlace } from "@/nav/search/search-index";

// town.search.bin (tools/tiles tests/test_search.py) has seven places to stop at around Chernihiv: WOG (24/7, diesel,
// LPG, 95), an unnamed fuel station, a café named by its brand only (Aroma Kava), an unnamed 24/7 pharmacy, a fast-food
// kiosk, a public parking area (a private one is left out), all in one 0.01° cell, and a charging station in the cell
// east of it. areas.search.bin has the section, empty.
const FIXTURE = new Uint8Array(readFileSync(path.join(__dirname, "../__fixtures__/town.search.bin")));
const AREAS = new Uint8Array(readFileSync(path.join(__dirname, "../__fixtures__/areas.search.bin")));
const CITY = { lat: 51.4939, lon: 31.2947 };
const D = 0.001;
const WORLD = { south: -90, west: -180, north: 90, east: 180 };

/** The source, logging each read's [offset, length]. */
function logged(bytes: Uint8Array): { source: ByteSource; reads: [number, number][] } {
  const inner = bufferByteSource(bytes);
  const reads: [number, number][] = [];
  return {
    reads,
    source: {
      size: inner.size,
      read(offset, length) {
        reads.push([offset, length]);
        return inner.read(offset, length);
      },
    },
  };
}

/** The file as written before places: the section, its cells and trailer cut out, flag 2 cleared. */
function withoutPlaces(file: Uint8Array): Uint8Array {
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const placesAt = v.getUint32(file.byteLength - 24, true);
  const out = new Uint8Array(placesAt + 12);
  out.set(file.subarray(0, placesAt));
  out.set(file.subarray(file.byteLength - 12), placesAt);
  const o = new DataView(out.buffer);
  o.setUint16(6, o.getUint16(6, true) & ~2, true);
  o.setUint32(72, out.byteLength, true);
  return out;
}

const open = (bytes: Uint8Array = FIXTURE) => new SearchIndex(bufferByteSource(bytes));
const row = (p: StopPlace) => `${p.category}:${p.name ?? "-"}:${p.flags}`;

describe("places to stop at", () => {
  it("reads every place with its category, name and flags", () => {
    const index = open();
    expect(index.hasPlaces).toBe(true);
    const all = index.placesIn(WORLD);
    expect(all.map(row).sort()).toEqual(
      [
        "fuel:WOG:23",
        "fuel:-:0",
        "cafe:Aroma Kava:0",
        "pharmacy:-:1",
        "food:-:0",
        "parking:-:0",
        "charging:-:0",
      ].sort(),
    );
    const wog = all.find((p) => p.name === "WOG")!;
    expect(wog.flags & PlaceFlag.open24h && wog.flags & PlaceFlag.diesel && wog.flags & PlaceFlag.lpg).toBeTruthy();
    expect(wog.flags & (PlaceFlag.octane92 | PlaceFlag.octane98)).toBe(0);
    expect(wog.lat).toBeCloseTo(CITY.lat - 1.5 * D, 6);
    expect(wog.lon).toBeCloseTo(CITY.lon + 2 * D, 6);
    expect(new Set(all.map((p) => p.key)).size).toBe(all.length);
    expect(all.every((p) => /^p\d+$/.test(p.key))).toBe(true);
    // The same place, the same key, whatever the box.
    const box = { south: wog.lat - 1e-5, west: wog.lon - 1e-5, north: wog.lat + 1e-5, east: wog.lon + 1e-5 };
    expect(index.placesIn(box)).toEqual([wog]);
  });

  it("keeps only the categories asked for", () => {
    const index = open();
    const fuel = index.placesIn(WORLD, new Set<PlaceCategory>(["fuel"]));
    expect(fuel.map(row).sort()).toEqual(["fuel:-:0", "fuel:WOG:23"]);
    expect(index.placesIn(WORLD, new Set<PlaceCategory>(["cafe", "pharmacy"])).map((p) => p.category).sort()).toEqual([
      "cafe",
      "pharmacy",
    ]);
    expect(index.placesIn(WORLD, new Set<PlaceCategory>())).toEqual([]);
  });

  it("reads only the cells of the box, and only what is inside it", () => {
    const { source, reads } = logged(FIXTURE);
    const index = new SearchIndex(source);
    index.placesIn(WORLD); // the cell table, read once
    reads.length = 0;
    // The charging station, alone in the cell east of the town's.
    const charging = { lat: CITY.lat, lon: CITY.lon + 8 * D };
    const box = { south: charging.lat - 2 * D, west: charging.lon - D, north: charging.lat + 2 * D, east: charging.lon + D };
    expect(index.placesIn(box).map(row)).toEqual(["charging:-:0"]);
    expect(reads).toHaveLength(1);
    expect(reads[0][1]).toBe(16); // one place's bytes
    // A box in the town's cell around the pharmacy and the fast-food kiosk only (the cell holds six).
    const near = { south: CITY.lat - 1.3 * D, west: CITY.lon - 1.1 * D, north: CITY.lat - 0.9 * D, east: CITY.lon - 0.9 * D };
    expect(index.placesIn(near).map(row).sort()).toEqual(["food:-:0", "pharmacy:-:1"]);
    // Nowhere near: nothing read.
    reads.length = 0;
    expect(index.placesIn({ south: 50, west: 30, north: 50.1, east: 30.1 })).toEqual([]);
    expect(reads).toEqual([]);
    expect(index.placesIn({ south: 52, west: 31, north: 51, east: 32 })).toEqual([]); // south above north
  });

  it("finds a place on a cell's edge from either side", () => {
    const index = open();
    for (const p of index.placesIn(WORLD)) {
      expect(index.placesIn({ south: p.lat, west: p.lon, north: p.lat, east: p.lon })).toEqual([p]);
    }
  });

  it("an empty section: places, none", () => {
    const index = open(AREAS);
    expect(index.hasPlaces).toBe(true);
    expect(index.placesIn(WORLD)).toEqual([]);
  });

  it("reads a file from before places as before", () => {
    const old = withoutPlaces(FIXTURE);
    const index = open(old);
    expect(index.hasPlaces).toBe(false);
    expect(index.placesIn(WORLD)).toEqual([]);
    expect(index.entrancesIn(-180, -90, 180, 90).map((e) => e.ref)).toEqual(["1", "2", null]);
    expect(index.search("Шевченка 10", { near: CITY })[0]).toMatchObject({ kind: "address", house: "10" });
    // And this app's file, as a reader from before places reads it: the entrances' trailer still last.
    const v = new DataView(FIXTURE.buffer, FIXTURE.byteOffset, FIXTURE.byteLength);
    expect(String.fromCharCode(...FIXTURE.subarray(FIXTURE.byteLength - 4))).toBe("WTFE");
    expect(v.getUint32(FIXTURE.byteLength - 12, true)).toBe(new DataView(old.buffer).getUint32(old.byteLength - 12, true));
    expect(open().entrancesIn(-180, -90, 180, 90)).toEqual(index.entrancesIn(-180, -90, 180, 90));
  });
});
