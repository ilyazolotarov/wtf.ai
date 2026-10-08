// "I'm here" on a place picked away from the map (the route screen's search, UI-SPEC §7.1): the map screen
// takes it and starts putting the car on the map there (NAVIGATOR-SPEC §6.2).

import type { Coordinate } from "@/nav/geo";

/** Below this the car stands: the driver may put it on the map. */
export const STANDING_MPS = 1;

let pending: Coordinate | null = null;
const listeners = new Set<() => void>();

/** Ask the map screen to start a placing at `at`. A newer request replaces one not taken yet. */
export function requestPlacing(at: Coordinate): void {
  pending = { lat: at.lat, lon: at.lon };
  listeners.forEach((listener) => listener());
}

/** The pending request, once: taking it clears it. */
export function takePlacingRequest(): Coordinate | null {
  const at = pending;
  pending = null;
  return at;
}

export function onPlacingRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
