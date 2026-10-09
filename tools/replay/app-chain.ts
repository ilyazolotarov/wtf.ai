// What the app works out for a trip log before it replays: where its region is (so which road graph), and which car
// it is. Shared by the viewer (viewer/server.ts) and the regression check (regress.ts), so both replay a drive as the
// phone would have.

import path from "node:path";

import { wrapAngle } from "../../src/nav/ekf/dr-ekf";
import { bearingRad } from "../../src/nav/geo";
import type { ParkedPose } from "../../src/nav/navigator";
import { drawnTruthTrack, type DrawnTruth } from "../../src/nav/replay/drawn-truth";
import { obdOdometer } from "../../src/nav/replay/truth-match";
import { LocalFrame } from "../../src/nav/geo/local-frame";
import { planRoute } from "../../src/nav/routing/router";
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

/**
 * A drawn start's heading: along the drawing where the car first drives straight (the road within `straightRad` over
 * ±`windowM`, turning slower than `maxRateRad` per s) after `afterM` and before `withinM` on the odometer.
 */
const DRAWN_HEADING = { afterM: 120, withinM: 1500, windowM: 30, straightRad: (5 * Math.PI) / 180, maxRateRad: (2 * Math.PI) / 180, posSigmaM: 10, headingSigmaRad: (5 * Math.PI) / 180 };

/**
 * Where the drawing starts, and how the car stood there: the drawing's direction once the car drives straight on it
 * (`DRAWN_HEADING`), less what the gyro turned since the log started (backing out of a bay included). The parked spot
 * the app should have saved.
 */
export function drawnStartPose(trip: TripLog, drawn: DrawnTruth | null): ParkedPose | null {
  if (!drawn || drawn.path.length < 2) return null;
  const timed = drawnTruthTrack(trip, drawn);
  const odo = obdOdometer(trip);
  const at = (s: number) => {
    let i = 1;
    while (i < timed.cum.length - 1 && timed.cum[i] < s) i++;
    const f = (s - timed.cum[i - 1]) / Math.max(1e-9, timed.cum[i] - timed.cum[i - 1]);
    const [a, b] = [timed.path[i - 1], timed.path[i]];
    return { lat: a[0] + f * (b[0] - a[0]), lon: a[1] + f * (b[1] - a[1]) };
  };
  // Heading change clockwise from north since the log's start, at each of the timed points: the gyro about the vertical.
  const turned: number[] = [];
  let sum = 0;
  let k = 0;
  const imu = trip.imu;
  for (const [t] of timed.points) {
    for (const tUs = trip.startUs + t * 1e6; k + 1 < imu.length && imu[k + 1].tUs <= tUs; k++) {
      const { gyro, gravity } = imu[k];
      const g = Math.hypot(...gravity) || 1;
      sum += ((gyro[0] * gravity[0] + gyro[1] * gravity[1] + gyro[2] * gravity[2]) / g) * ((imu[k + 1].tUs - imu[k].tUs) / 1e6);
    }
    turned.push(sum);
  }
  const c = DRAWN_HEADING;
  for (let i = 1; i + 1 < timed.points.length; i++) {
    const [t, , , s] = timed.points[i];
    const tUs = trip.startUs + t * 1e6;
    if (odo(tUs) < c.afterM || s + c.windowM > timed.pathM) continue;
    if (odo(tUs) > c.withinM) return null;
    const ahead = bearingRad(at(s - c.windowM), at(s));
    const behind = bearingRad(at(s), at(s + c.windowM));
    if (Math.abs(wrapAngle(ahead - behind)) > c.straightRad) continue;
    const rate = Math.abs(turned[i + 1] - turned[i - 1]) / (timed.points[i + 1][0] - timed.points[i - 1][0]);
    if (rate > c.maxRateRad) continue;
    const h = wrapAngle(behind - turned[i]);
    return { lat: timed.path[0][0], lon: timed.path[0][1], headingRad: h < 0 ? h + 2 * Math.PI : h, posSigmaM: c.posSigmaM, headingSigmaRad: c.headingSigmaRad };
  }
  return null;
}

/** A route the replay hands the app (phone-only mode follows it), from `fromS` on (null points: none from then). */
export interface ReplayRoute {
  fromS: number;
  points: { lat: number; lon: number }[] | null;
}

/** Of the drawn drive's moving seconds while a plan was in force, this share within this of it: the driver followed it. */
const FOLLOWED_SHARE = 0.9;
const FOLLOWED_M = 30;

/**
 * The route a phone-only replay takes the driver to follow: the routes the app planned on the drive (its log), when
 * the drawn truth says the driver followed them; otherwise, or without any, the drawn route itself (a driver who
 * follows the navigator). Without a drawing, the logged routes as they are.
 */
export function phoneRouteFor(trip: TripLog, drawn: DrawnTruth | null): { source: "log" | "drawn" | "none"; routes: ReplayRoute[]; rebuilt: boolean } {
  const before = routeBeforeLog(trip, drawn ? drawnStartPose(trip, drawn) : null);
  const logged = trip.navRoute
    .filter((p) => p.status === "done")
    .map((p) => ({
      fromS: (p.tUs - trip.startUs) / 1e6,
      points: trip.navRoutePoints.filter((q) => q.planId === p.planId && q.tUs === p.tUs).map((q) => ({ lat: q.latDeg, lon: q.lonDeg })),
    }))
    .filter((p) => p.points.length >= 2);
  const plans = before ? [{ fromS: 0, points: before.points }, ...logged] : logged;
  const rebuilt = before !== null;
  if (!drawn || drawn.path.length < 2) return plans.length ? { source: "log", routes: plans, rebuilt } : { source: "none", routes: [], rebuilt };
  const drawnRoute = { source: "drawn" as const, routes: [{ fromS: 0, points: drawn.path.map(([lat, lon]) => ({ lat, lon })) }], rebuilt: false };
  if (!plans.length) return drawnRoute;
  const timed = drawnTruthTrack(trip, drawn);
  const odo = obdOdometer(trip);
  let on = 0;
  let all = 0;
  plans.forEach((plan, i) => {
    const untilS = plans[i + 1]?.fromS ?? Infinity;
    for (const [t, lat, lon] of timed.points) {
      if (t < plan.fromS || t >= untilS) continue;
      if (odo(trip.startUs + (t + 0.5) * 1e6) - odo(trip.startUs + (t - 0.5) * 1e6) < 2) continue;
      all++;
      if (distanceToLineM({ lat, lon }, plan.points) <= FOLLOWED_M) on++;
    }
  });
  return all > 0 && on / all >= FOLLOWED_SHARE ? { source: "log", routes: plans, rebuilt } : drawnRoute;
}

/**
 * A route the app guided along before its plan reached the log: progress under a plan the log doesn't have, before
 * its first logged one (planned with the engine off: until 2026-10-09 a trip's log missed it). Planned again, as the
 * app does, from where the drive starts (the drawn start, else the first position the app showed) to the destination
 * of the log's first plan, on the region's graph. Null when nothing is missing or it can't be planned.
 */
export function routeBeforeLog(trip: TripLog, start: { lat: number; lon: number; headingRad?: number } | null = null): { points: { lat: number; lon: number }[]; lengthM: number } | null {
  const first = trip.navRoute.find((p) => p.status === "done");
  const earliest = trip.navRouteProgress[0];
  if (!first || !earliest || earliest.tUs >= first.tUs || earliest.planId === first.planId) return null;
  const shown = trip.navEstimate.find((r) => Number.isFinite(r.latDeg) && Number.isFinite(r.lonDeg));
  const from = start ?? (shown ? { lat: shown.latDeg, lon: shown.lonDeg, ...(Number.isFinite(shown.headingRad) ? { headingRad: shown.headingRad } : {}) } : null);
  const file = from ? findGraph(from) : null;
  if (!from || !file) return null;
  const { graph, close } = openGraph(file, from);
  try {
    const frame = new LocalFrame(from);
    graph.setFrame(frame);
    const r = planRoute(graph, frame, from, { lat: first.toLatDeg, lon: first.toLonDeg });
    return r.status === "done" ? { points: r.plan.coordinates, lengthM: r.plan.lengthM } : null;
  } finally {
    close();
  }
}

/** From a point to a polyline, m (flat around the point). */
function distanceToLineM(p: { lat: number; lon: number }, line: { lat: number; lon: number }[]): number {
  const kx = 111_195 * Math.cos((p.lat * Math.PI) / 180);
  const ky = 111_195;
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const ax = (line[i - 1].lon - p.lon) * kx;
    const ay = (line[i - 1].lat - p.lat) * ky;
    const dx = (line[i].lon - p.lon) * kx - ax;
    const dy = (line[i].lat - p.lat) * ky - ay;
    const l2 = dx * dx + dy * dy;
    const f = l2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + f * dx, ay + f * dy));
  }
  return best;
}
