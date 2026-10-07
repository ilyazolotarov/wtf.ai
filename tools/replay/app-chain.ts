// What the app works out for a trip log before it replays: where its region is (so which road graph), and which car
// it is. Shared by the viewer (viewer/server.ts) and the regression check (regress.ts), so both replay a drive as the
// phone would have.

import path from "node:path";

import type { ActiveRoadGraph } from "../../src/services/offline-map/road-graph-file";
import type { TripLog } from "../../src/triplog/trip-log-reader";
import { findGraph, openGraph } from "./graph-file";

/**
 * Where a log's region is, to pick its road graph: the first fix within 500 m, else any fix, else the first
 * position the app published. The app has its region's graph whatever the fixes, so a jammed log without one good
 * fix must still get it here, or its replay runs without map matching and drives through the blocks.
 */
export function regionPoint(trip: TripLog): { lat: number; lon: number } | null {
  const fix = trip.gnss.find((f) => f.hAccM <= 500) ?? trip.gnss[0];
  if (fix) return fix;
  const shown = trip.navEstimate.find((r) => Number.isFinite(r.latDeg) && Number.isFinite(r.lonDeg));
  return shown ? { lat: shown.latDeg, lon: shown.lonDeg } : null;
}

/** The road graph a log's region has (`graphFile` overrides; null: none), opened for one replay. */
export function graphFor(trip: TripLog, graphFile?: string): { active: ActiveRoadGraph; close(): void } | null {
  const first = regionPoint(trip);
  const file = first ? (graphFile ?? findGraph(first)) : null;
  if (!first || !file) return null;
  const opened = openGraph(file, first);
  return { active: { key: file, region: path.basename(file, ".graph.bin"), graph: opened.graph }, close: opened.close };
}

/** The car as the app identifies it (vehicle-link-core): its VIN, else the car last seen on the same OBD protocol. */
export function carOf(trip: TripLog, byProtocol: Map<string, string>): string | null {
  const vin = typeof trip.info.vehicle_vin === "string" && trip.info.vehicle_vin ? trip.info.vehicle_vin : null;
  const protocol = String(trip.info.obd_protocol ?? "").replace(/^A/, "");
  if (vin && protocol) byProtocol.set(protocol, vin);
  return vin ?? (protocol ? (byProtocol.get(protocol) ?? null) : null);
}
