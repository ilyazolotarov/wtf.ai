import { useSyncExternalStore } from "react";

import type { Coordinate } from "@/nav/geo";
import { PlacesStore, type PlacesSnapshot } from "@/services/navigation/places-store";
import { kvStore } from "@/services/kv-store";

/** Saved places and recent destinations, on the phone (kv-store). */
export const places = new PlacesStore(kvStore);

export function usePlaces(): PlacesSnapshot {
  return useSyncExternalStore(places.subscribe, places.getSnapshot, places.getSnapshot);
}

/** Inside a region's bounds ([minLon, minLat, maxLon, maxLat]): a route can reach it. */
export function inBounds(bounds: [number, number, number, number] | null | undefined, p: Coordinate): boolean {
  if (!bounds) return false;
  const [w, s, e, n] = bounds;
  return p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n;
}
