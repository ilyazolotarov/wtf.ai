// Replay → compact JSON for the browser viewer (tools/replay/viewer). Times are seconds
// since log start; coordinates rounded to ~1 cm, the rest to what a viewer can show.

import type { TripLog } from "../../triplog/trip-log-reader";
import { replayTrip, type ReplayOptions, type ReplaySummary } from "./replay";

export interface ViewerTrackPoint {
  t: number;
  lat: number;
  lon: number;
  acc: number;
  mode: "anchored" | "dr";
  /** Heading, degrees clockwise from north (dr only). */
  hdg: number | null;
  hdgSd: number | null;
  spd: number | null;
  still: boolean;
  /** Map matching: state and up to 3 clusters [lat, lon, weight, spread m, on-road 1/0]. */
  mm?: { s: string; c: [number, number, number, number, number][] };
}

export interface ViewerFix {
  t: number;
  lat: number;
  lon: number;
  acc: number;
  sat: boolean;
  /** km/h */
  spd: number | null;
  crs: number | null;
  status: string;
  err: number | null;
}

export interface ViewerData {
  file: string;
  info: Record<string, string | number>;
  durationS: number;
  /** UTC ms at t = 0, from the log's time sync (null when absent). */
  startUtcMs: number | null;
  /** Cut windows actually applied, including the open-loop one. */
  options: { cuts: { fromS: number; toS: number; openLoop?: boolean }[]; gnssLagS: number; openLoopDelayS: number | null };
  summary: ReplaySummary;
  track: ViewerTrackPoint[];
  fixes: ViewerFix[];
  /** [t, km/h] at ≤ 5 Hz. */
  obd: [number, number][];
  rpm: [number, number][];
  engine: { t: number; state: string }[];
  events: { t: number; kind: string; text: string }[];
  /** Map-matching particles once a second: [t, [lat, lon, weight, off-road 1/0][]] (heaviest first). */
  particles: [number, [number, number, number, number][]][];
}

const r = (v: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
const deg = (rad: number) => (rad * 180) / Math.PI;

export function buildViewerData(file: string, trip: TripLog, options: ReplayOptions = {}): ViewerData {
  const result = replayTrip(trip, { trackStepS: 0.2, ...options, ...(options.mapMatch ? { mapMatch: { particlesEveryS: 1, ...options.mapMatch } } : {}) });
  const tS = (tUs: number) => r((tUs - trip.startUs) / 1e6, 2);

  const info: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(trip.info)) if (typeof v !== "object") info[k] = v;

  let lastObdT = -Infinity;
  const obd: [number, number][] = [];
  for (const s of trip.obdSpeed) {
    const t = tS(s.tUs);
    if (t - lastObdT < 0.2) continue;
    lastObdT = t;
    obd.push([t, s.rawKph]);
  }

  const events: ViewerData["events"] = [
    ...trip.events.map((e) => ({ t: tS(e.tUs), kind: e.event, text: e.reason ? `${e.event}: ${e.reason}` : e.event })),
    ...trip.messages.filter((m) => m.tag !== "trip").map((m) => ({ t: tS(m.tUs), kind: m.tag || "log", text: m.text })),
  ].sort((a, b) => a.t - b.t);

  const sync = trip.timeSync[0];
  return {
    file,
    info,
    durationS: r(result.summary.durationS, 1),
    startUtcMs: sync ? (sync.utcUs - (sync.tUs - trip.startUs)) / 1000 : null,
    options: {
      cuts: result.summary.cuts.map((c) => ({ fromS: c.fromS, toS: c.toS, ...(c.openLoop ? { openLoop: true } : {}) })),
      gnssLagS: options.nav?.gnssLagS ?? 0.4,
      openLoopDelayS: options.openLoop?.delayS ?? null,
    },
    summary: result.summary,
    track: result.track.map((p) => ({
      t: r(p.tS, 2),
      lat: r(p.lat, 7),
      lon: r(p.lon, 7),
      acc: r(p.accuracyM, 1),
      mode: p.mode,
      hdg: p.headingRad === undefined ? null : r(deg(p.headingRad), 1),
      hdgSd: p.headingSigmaRad === undefined ? null : r(deg(p.headingSigmaRad), 1),
      spd: p.speedMps === undefined ? null : r(p.speedMps * 3.6, 1),
      still: p.standstill,
      ...(p.mapMatch
        ? {
            mm: {
              s: p.mapMatch.state,
              c: p.mapMatch.clusters
                .slice(0, 3)
                .map((c): [number, number, number, number, number] => [r(c.lat, 6), r(c.lon, 6), r(c.weight, 3), r(c.spreadM, 1), c.edge === null ? 0 : 1]),
            },
          }
        : {}),
    })),
    fixes: result.fixes.map((f) => ({
      t: r(f.tS, 2),
      lat: r(f.fix.lat, 7),
      lon: r(f.fix.lon, 7),
      acc: r(f.fix.hAccM, 1),
      sat: f.satellite,
      spd: f.fix.speedMps === undefined ? null : r(f.fix.speedMps * 3.6, 1),
      crs: f.fix.courseRad === undefined ? null : r(deg(f.fix.courseRad), 0),
      status: f.status,
      err: f.errorM === undefined ? null : r(f.errorM, 1),
    })),
    obd,
    rpm: trip.rpm.map((s) => [tS(s.tUs), Math.round(s.rpm)]),
    engine: trip.engine.map((e) => ({ t: tS(e.tUs), state: e.state })),
    events,
    particles: result.particles.map((s) => [
      r(s.tS, 2),
      s.particles.map(([lat, lon, w, off]): [number, number, number, number] => [r(lat, 6), r(lon, 6), Number(w.toPrecision(3)), off]),
    ]),
  };
}
