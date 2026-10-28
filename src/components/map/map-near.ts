// Heading-up shows the road far ahead, and far ahead the city's detail is clutter (UI-SPEC §6.1): beyond a few hundred
// metres of the car the house numbers, entrances and the POIs a driver doesn't look for go. MapLibre's `distance` expression measures each from the car,
// which moves on only every `NEAR_STEP_M`: a change rebuilds the tiles on screen. Not the buildings: for polygons it
// came out far too small and uneven (MapLibre Native 13.6: at 400 m every building stayed, at 50 m scattered far ones).
// Not the tiles' house numbers either: a tile (z14, ~1.5 km) merges its houses of one number into one MultiPoint, which
// the filter keeps or drops whole, by its first point (MapLibre Native reads no other): houses by the car went while
// far ones stayed. In heading-up the numbers come from the search file instead, a point a house (`nearHouses`).
// Past its distance each fades out over `NEAR_FADE_M` rather than going at once: coming nearer, one step at a time,
// it shows faint, then fuller (the same `distance`, in the layer's opacity; a house's from the search file, worked out here).

import { haversineM, type Coordinate } from "@/nav/geo";
import type { SearchIndex } from "@/nav/search/search-index";

/** House numbers and entrances show in full up to this far. */
export const NEAR_NUMBERS_M = 250;
/** POIs other than a driver's (the car's map's: fuel, stations) show in full up to this far. */
export const NEAR_POIS_M = 250;
/** …and fade out over this far beyond it. */
export const NEAR_FADE_M = 70;
/** The car moves on this far before the near area follows it. */
export const NEAR_STEP_M = 40;

/** The point measured from: the last one, unless the car is `NEAR_STEP_M` from it (null: nothing is cut). */
export function nearPoint(was: Coordinate | null, car: Coordinate | null): Coordinate | null {
  if (!car) return null;
  return was && haversineM(was, car) < NEAR_STEP_M ? was : { lat: car.lat, lon: car.lon };
}

const within = (at: Coordinate, m: number) => ["<", ["distance", { type: "Point", coordinates: [at.lon, at.lat] }], m];

/**
 * A layer's filter that also keeps only what is within `m` of `at` and its fade beyond, or matches `always` wherever
 * it is (null `at`: everything, as `base` does).
 */
export function nearFilter(at: Coordinate | null, m: number, base?: unknown[], always?: unknown[]): unknown[] {
  if (!at) return base ?? ["all"];
  const near = always ? ["any", always, within(at, m + NEAR_FADE_M)] : within(at, m + NEAR_FADE_M);
  return base ? ["all", base, near] : near;
}

/** The opacity of what `nearFilter` keeps: full within `m` of `at`, fading out beyond; full for `always` (and null `at`). */
export function nearOpacity(at: Coordinate | null, m: number, always?: unknown[]): unknown {
  if (!at) return 1;
  const fade = ["interpolate", ["linear"], ["distance", { type: "Point", coordinates: [at.lon, at.lat] }], m, 1, m + NEAR_FADE_M, 0];
  return always ? ["case", always, 1, fade] : fade;
}

/** A house number's opacity `m` from the point, as `nearOpacity`'s. */
const houseOpacity = (m: number) => Math.min(1, Math.max(0, (NEAR_NUMBERS_M + NEAR_FADE_M - m) / NEAR_FADE_M));

export type NearHouses = { type: "FeatureCollection"; features: unknown[] };

/**
 * The houses within `NEAR_NUMBERS_M` of `at` and its fade as points with their numbers (`n`) and opacity (`o`), from
 * the search file; null without a point or a search file (the tiles' numbers then, all of them).
 */
export function nearHouses(index: SearchIndex | null, at: Coordinate | null): NearHouses | null {
  if (!index || !at) return null;
  return {
    type: "FeatureCollection",
    features: index.housesNear(at, NEAR_NUMBERS_M + NEAR_FADE_M).map((h) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [h.lon, h.lat] },
      properties: { n: h.house, o: houseOpacity(haversineM(at, h)) },
    })),
  };
}
