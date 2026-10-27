// Heading-up shows the road far ahead, and far ahead the city's detail is clutter (UI-SPEC §6.1): beyond a few hundred
// metres of the car the house numbers, entrances and the POIs a driver doesn't look for go. MapLibre's `distance` expression measures each from the car,
// which moves on only every `NEAR_STEP_M`: a change rebuilds the tiles on screen. Not the buildings: for polygons it
// came out far too small and uneven (MapLibre Native 13.6: at 400 m every building stayed, at 50 m scattered far ones).

import { haversineM, type Coordinate } from "@/nav/geo";

/** House numbers and entrances show up to this far. */
export const NEAR_NUMBERS_M = 250;
/** POIs other than a driver's (the car's map's: fuel, stations) show up to this far. */
export const NEAR_POIS_M = 250;
/** The car moves on this far before the near area follows it. */
export const NEAR_STEP_M = 40;

/** The point measured from: the last one, unless the car is `NEAR_STEP_M` from it (null: nothing is cut). */
export function nearPoint(was: Coordinate | null, car: Coordinate | null): Coordinate | null {
  if (!car) return null;
  return was && haversineM(was, car) < NEAR_STEP_M ? was : { lat: car.lat, lon: car.lon };
}

const within = (at: Coordinate, m: number) => ["<", ["distance", { type: "Point", coordinates: [at.lon, at.lat] }], m];

/**
 * A layer's filter that also keeps only what is within `m` of `at`, or matches `always` wherever it is (null `at`:
 * everything, as `base` does).
 */
export function nearFilter(at: Coordinate | null, m: number, base?: unknown[], always?: unknown[]): unknown[] {
  if (!at) return base ?? ["all"];
  const near = always ? ["any", always, within(at, m)] : within(at, m);
  return base ? ["all", base, near] : near;
}
