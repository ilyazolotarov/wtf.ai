// "I'm here" on a place picked away from the map (the route screen's search, UI-SPEC §7.1): the map screen
// takes it and starts putting the car on the map there (NAVIGATOR-SPEC §6.2).

import type { Coordinate } from "@/nav/geo";

/** Below this the car stands: the driver may put it on the map. */
export const STANDING_MPS = 1;

/** `at`: where the placing starts; null: from the dot, or the region's middle without one (the map itself). */
export interface PlacingRequest {
  at: Coordinate | null;
}

let pending: PlacingRequest | null = null;
const listeners = new Set<() => void>();

/** Ask the map screen to start a placing at `at` (null: on the map as it is). A newer request replaces one not taken yet. */
export function requestPlacing(at: Coordinate | null): void {
  pending = { at: at && { lat: at.lat, lon: at.lon } };
  listeners.forEach((listener) => listener());
}

/** The pending request, once: taking it clears it. */
export function takePlacingRequest(): PlacingRequest | null {
  const request = pending;
  pending = null;
  return request;
}

export function onPlacingRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
