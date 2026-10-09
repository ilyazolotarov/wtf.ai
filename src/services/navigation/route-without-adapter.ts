// A route asked for without an adapter (phone-only mode, NAVIGATOR-SPEC §9.6): it waits for the driver on the map
// screen, which says first to set the position and to follow the route exactly, and plans it once the driver has
// said they will (UI-SPEC §6.3). Picked on the route screen or from a pin, it is held here until then.

import type { RouteDestination } from "./route-service";

let pending: RouteDestination | null = null;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((listener) => listener());

/** Hold `destination` for the guide (a newer one replaces it). */
export function holdRouteForGuide(destination: RouteDestination): void {
  pending = destination;
  emit();
}

export function heldRoute(): RouteDestination | null {
  return pending;
}

/** The held route, once: taking it (to plan it, or to drop it) clears it. */
export function takeHeldRoute(): RouteDestination | null {
  const d = pending;
  pending = null;
  if (d) emit();
  return d;
}

export function onHeldRoute(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
