// How a drive went (tools/replay viewer): where the dot was against where GPS says the car was,
// over the stretches without GPS. Pure TS; times are seconds since log start.

import type { TripLog } from "../../triplog/trip-log-reader";
import { haversineM } from "../geo";
import type { MapMatchState } from "../mapmatch/particle-filter";
import { FUSED_WINDOW_US, puckAccuracyM, puckHypothesis } from "../position/puck";
import { isSatelliteFix } from "../types";
import type { ReplayResult } from "./replay";

/** A position the map showed (or would show): the dot and its ~68 % radius. */
export interface ShownPoint {
  t: number;
  lat: number;
  lon: number;
  acc: number;
}

export interface TruthFix {
  t: number;
  lat: number;
  lon: number;
}

export type OutageKind = "no-gps" | "app-cut" | "replay-cut";

export interface OutageWindow {
  kind: OutageKind;
  fromS: number;
  toS: number;
}

/** One track over one outage. Errors are against GPS fixes the track didn't get (or the first one after). */
export interface OutageScore {
  /** Clean satellite fixes inside the window (none in a real outage). */
  truthFixes: number;
  maxErrorM: number | null;
  /** At the last fix inside the window. */
  endErrorM: number | null;
  /** Share of those fixes inside the track's circle. */
  insideShare: number | null;
  /** At the first clean fix after the window (within `AFTER_MAX_S`), before the track used it. */
  afterErrorM: number | null;
  afterInside: boolean | null;
}

export interface DriveOutage extends OutageWindow {
  /** OBD distance driven in the window, m. */
  distanceM: number;
  scores: Record<string, OutageScore | null>;
}

/** Satellite fixes this accurate are the truth (the replay's rule). */
export const TRUTH_ACCURACY_M = 10;
/** A gap between clean fixes longer than this is an outage (jamming, a tunnel). */
export const NO_GPS_MIN_S = 15;
/** Real outages shorter than this in OBD distance are left out (parked, or GPS still starting). */
export const NO_GPS_MIN_DISTANCE_M = 30;
/** The "after" fix must come this soon after the window ends. */
const AFTER_MAX_S = 10;
/** A track sample farther than this from the asked time doesn't count (the track wasn't running). */
const TRACK_GAP_S = 2;

export function truthFixes(trip: TripLog): TruthFix[] {
  return trip.gnss
    .filter((f) => isSatelliteFix(f) && f.hAccM <= TRUTH_ACCURACY_M)
    .map((f) => ({ t: (f.tUs - trip.startUs) / 1e6, lat: f.lat, lon: f.lon }));
}

/** Published positions (the trip log's `nav_estimate`, or an app replay's) as a track. */
export function estimateTrack(records: { tUs: number; latDeg: number; lonDeg: number; accuracyM: number }[], startUs: number): ShownPoint[] {
  return records.map((p) => ({ t: (p.tUs - startUs) / 1e6, lat: p.latDeg, lon: p.lonDeg, acc: p.accuracyM }));
}

/** What the phone showed, from the log's `nav_estimate` (empty in logs before it was recorded). */
export function phoneTrack(trip: TripLog): ShownPoint[] {
  return estimateTrack(trip.navEstimate, trip.startUs);
}

/**
 * What the app would have shown for a replay: the EKF, except while dead-reckoning (no satellite fix
 * accepted in the last 3 s) with map matching placing the car, when it shows the dominant hypothesis
 * (MAPMATCH-SPEC §11, NavigatorService.publish).
 */
export function replayShownTrack(result: ReplayResult): ShownPoint[] {
  return replayPuck(result).map(({ t, lat, lon, acc }) => ({ t, lat, lon, acc }));
}

/** The published position for a replay, as route guidance gets it: the dot, plus its heading, speed and map match. */
export interface PuckPoint extends ShownPoint {
  headingRad?: number;
  speedMps?: number;
  mapMatch?: MapMatchState;
  /** Dead-reckoning (no satellite fix accepted in the last 3 s). */
  dr: boolean;
}

/** `replayShownTrack` with the rest of what NavigatorService publishes. */
export function replayPuck(result: ReplayResult): PuckPoint[] {
  const accepted = result.fixes.filter((f) => f.status === "accepted" && f.satellite).map((f) => f.tS);
  let k = -1;
  return result.track.map((p) => {
    while (k + 1 < accepted.length && accepted[k + 1] <= p.tS) k++;
    // The app also needs GPS trust for "fused" (its GnssTrustTracker); a navigator-only replay goes by the fixes.
    const dr = p.mode === "dr" && (k < 0 || (p.tS - accepted[k]) * 1e6 >= FUSED_WINDOW_US);
    const top = puckHypothesis(p, dr);
    const common = { t: p.tS, speedMps: p.speedMps, mapMatch: p.mapMatch?.state, dr };
    return top
      ? { ...common, lat: top.lat, lon: top.lon, acc: puckAccuracyM(p, top), headingRad: top.headingRad }
      : { ...common, lat: p.lat, lon: p.lon, acc: puckAccuracyM(p, top), headingRad: p.headingRad };
  });
}

/** Last index with arr[i].t ≤ t, or −1. */
function indexAt<T extends { t: number }>(arr: T[], t: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** The track at `t`, interpolated between its samples; null outside it or across a gap. */
export function trackAt(track: ShownPoint[], t: number): ShownPoint | null {
  const i = indexAt(track, t);
  if (i < 0) return null;
  const a = track[i];
  const b = track[i + 1];
  if (!b) return t - a.t <= TRACK_GAP_S ? a : null;
  if (b.t - a.t > TRACK_GAP_S) return t - a.t <= TRACK_GAP_S ? a : null;
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  return { t, lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, acc: a.acc + (b.acc - a.acc) * f };
}

/** The last sample at or before `t`: the track before it used a fix arriving at `t`. */
function trackBefore(track: ShownPoint[], t: number): ShownPoint | null {
  const i = indexAt(track, t - 1e-6);
  return i >= 0 && t - track[i].t <= TRACK_GAP_S ? track[i] : null;
}

/** Real outages: gaps between clean satellite fixes longer than `NO_GPS_MIN_S` (from the log's start and to its end too). */
export function noGpsWindows(truth: TruthFix[], durationS: number): OutageWindow[] {
  const out: OutageWindow[] = [];
  let prev = 0;
  for (const f of [...truth, { t: durationS }]) {
    if (f.t - prev > NO_GPS_MIN_S) out.push({ kind: "no-gps", fromS: prev, toS: f.t });
    prev = f.t;
  }
  return out;
}

export function scoreOutage(track: ShownPoint[], truth: TruthFix[], w: OutageWindow): OutageScore | null {
  if (!track.length) return null;
  // A real outage is bounded by clean fixes: none is inside it, only the one ending it.
  const inside = w.kind === "no-gps" ? [] : truth.filter((f) => f.t >= w.fromS && f.t < w.toS);
  const errors: { e: number; inside: boolean }[] = [];
  for (const f of inside) {
    const p = trackAt(track, f.t);
    if (p) errors.push({ e: haversineM(p, f), inside: haversineM(p, f) <= p.acc });
  }
  const next = truth.find((f) => f.t >= w.toS);
  const before = next && next.t - w.toS <= AFTER_MAX_S ? trackBefore(track, next.t) : null;
  const afterErrorM = before && next ? haversineM(before, next) : null;
  if (!errors.length && afterErrorM === null) return null;
  return {
    truthFixes: errors.length,
    maxErrorM: errors.length ? Math.max(...errors.map((x) => x.e)) : null,
    endErrorM: errors.length ? errors[errors.length - 1].e : null,
    insideShare: errors.length ? errors.filter((x) => x.inside).length / errors.length : null,
    afterErrorM,
    afterInside: before && afterErrorM !== null ? afterErrorM <= before.acc : null,
  };
}

/** OBD distance between two log times, m. */
export function obdDistanceM(trip: TripLog, fromS: number, toS: number): number {
  let d = 0;
  const s = trip.obdSpeed;
  for (let i = 1; i < s.length; i++) {
    const t0 = (s[i - 1].tUs - trip.startUs) / 1e6;
    const t1 = (s[i].tUs - trip.startUs) / 1e6;
    if (t1 <= fromS || t0 >= toS || t1 - t0 > 2.5) continue;
    d += s[i - 1].speedMps * (Math.min(t1, toS) - Math.max(t0, fromS));
  }
  return d;
}

/** Every outage of the drive, each scored for every track given (key → track). */
export function driveOutages(
  trip: TripLog,
  durationS: number,
  windows: OutageWindow[],
  tracks: Record<string, ShownPoint[]>,
): DriveOutage[] {
  const truth = truthFixes(trip);
  const all = [...noGpsWindows(truth, durationS), ...windows].sort((a, b) => a.fromS - b.fromS);
  return all
    .map((w) => ({ ...w, toS: Math.min(w.toS, durationS), distanceM: obdDistanceM(trip, w.fromS, Math.min(w.toS, durationS)) }))
    .filter((w) => w.kind !== "no-gps" || w.distanceM >= NO_GPS_MIN_DISTANCE_M)
    .map((w) => ({ ...w, scores: Object.fromEntries(Object.entries(tracks).map(([key, track]) => [key, scoreOutage(track, truth, w)])) }));
}
