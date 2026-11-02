// A change to the trip made in one tap, with a way back (STOPS-SPEC §7.4): a stop added (from the map, the route page,
// the places on the way), a route replaced or parked elsewhere. No confirmation before it; the map's card offers Undo
// for a few seconds after.

import { useSyncExternalStore } from "react";

import { takeHeldRoute } from "@/services/navigation/route-without-adapter";
import type { RouteService, RouteSnapshot, StopInput } from "@/services/navigation/route-service";

export interface TripUndo {
  id: number;
  /** `stop`: a stop added; `route`: the route replaced by one to `name`. */
  kind: "stop" | "route";
  name: string | null;
  /** The stop added (its row on the route page glows once). */
  stopKey?: string;
  undo(): void;
}

/** How long the card offers Undo, ms. */
export const TRIP_UNDO_MS = 10_000;

let current: TripUndo | null = null;
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const tripUndo = {
  getSnapshot: (): TripUndo | null => current,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  offer(kind: TripUndo["kind"], name: string | null, undo: () => void, stopKey?: string): void {
    current = { id: nextId++, kind, name, undo, ...(stopKey ? { stopKey } : {}) };
    emit();
  },
  /** Undo tapped: the change is taken back, the offer goes. */
  take(): void {
    const u = current;
    current = null;
    emit();
    u?.undo();
  },
  /** The offer goes (its time is up, or `id`'s was replaced already). */
  clear(id?: number): void {
    if (!current || (id !== undefined && current.id !== id)) return;
    current = null;
    emit();
  },
};

export function useTripUndo(): TripUndo | null {
  return useSyncExternalStore(tripUndo.subscribe, tripUndo.getSnapshot, tripUndo.getSnapshot);
}

/** Adds `stop` at once and offers to take it out again. False: no route, or five stops already. */
export function addStopWithUndo(routes: RouteService, stop: StopInput): boolean {
  const key = stop.key ?? `u${Date.now().toString(36)}-${nextId}`;
  if (!routes.addStop({ ...stop, key })) return false;
  tripUndo.offer("stop", stop.name ?? null, () => routes.removeStop(key), key);
  return true;
}

/**
 * Before a new destination replaces `before` (the route on, if any): Undo puts that trip back, its destination and the
 * stops it hadn't reached, planned from where the car is then. Nothing to offer without a route on.
 */
export function offerRouteUndo(routes: RouteService, before: RouteSnapshot | null, name: string | null): void {
  if (!before || before.status === "failed") return;
  const { destination, stops } = before;
  tripUndo.offer("route", name, () => {
    // The new route may wait for the driver's word (no adapter): it goes with the undo.
    takeHeldRoute();
    routes.start(destination, { stops });
  });
}
