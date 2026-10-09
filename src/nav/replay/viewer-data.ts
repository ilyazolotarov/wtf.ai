// Replay → compact JSON for the browser viewer (tools/replay/viewer). Times are seconds
// since log start; coordinates rounded to ~1 cm, the rest to what a viewer can show.

import type { TripLog } from "../../triplog/trip-log-reader";
import { haversineM } from "../geo";
import {
  driveOutages,
  estimateTrack,
  noGpsWindows,
  phoneTrack,
  replayShownTrack,
  trackAt,
  truthFixes,
  type DriveOutage,
  type OutageWindow,
  type ShownPoint,
} from "./drive-report";
import { obdOdometer } from "./truth-match";
import { replayTrip, type ReplayCut, type ReplayOptions, type ReplayResult, type ReplaySummary } from "./replay";

/** [t, lat, lon, ~68 % radius m] */
export type ViewerShown = [number, number, number, number];
/** At each clean satellite fix: [t, distance from the track m, inside its circle 1/0]. */
export type ViewerErrors = [number, number, 0 | 1][];

export interface ViewerExtras {
  /** GNSS outages the app simulated ("Cut GPS"): listed and scored even when the replay keeps GNSS there. */
  appCuts?: ReplayCut[];
  /** A second replay to compare with (another navigator version). */
  compare?: { label: string; options: ReplayOptions };
  /**
   * How to replay (default `replayTrip`). The viewer replays through the app (app-replay.ts): its result carries
   * what the service published, which is then the track as shown.
   */
  replay?: (options: ReplayOptions) => ReplayResult & {
    published?: { timestampUs: number; latDeg: number; lonDeg: number; accuracyM: number; speedMps?: number; source?: string }[];
    publishedAlternatives?: { lat: number; lon: number; weight: number }[][];
    /** The replayed service's own notes. */
    notes?: { tUs: number; text: string }[];
  };
  /** The replay ran the app without an adapter (phone-only mode, NAVIGATOR-SPEC §9.6): its speed and other roads. */
  phoneOnly?: boolean;
}

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

/** A route the app planned on the drive (ROUTING-SPEC §8), from the log. */
export interface ViewerRoutePlan {
  t: number;
  id: number;
  reason: string;
  status: string;
  lengthM: number | null;
  durationS: number | null;
  planMs: number;
  wallMs: number;
  states: number;
  slices: number;
  /** [lat, lon] */
  points: [number, number][];
  maneuvers: { kind: string; exit: number; lat: number; lon: number; atM: number }[];
}

export interface ViewerData {
  file: string;
  info: Record<string, string | number>;
  durationS: number;
  /** The log's OBD distance, m (the replay's own summary has none when it ran without the adapter). */
  obdDistanceM: number;
  /** UTC ms at t = 0, from the log's time sync (null when absent). */
  startUtcMs: number | null;
  /** Cut windows actually applied, including the open-loop one. */
  /** `gnssLagS`: null when the navigator learned it on the drive, as in the app. */
  options: { cuts: { fromS: number; toS: number; openLoop?: boolean }[]; gnssLagS: number | null; openLoopDelayS: number | null };
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
  /** The replay as the app would show it (the map-matched position while dead-reckoning). */
  shown: ViewerShown[];
  /** What the phone showed, from the log (empty in logs before it was recorded). */
  phone: ViewerShown[];
  compare: { label: string; shown: ViewerShown[] } | null;
  /** Stretches without GNSS (real, simulated in the app, or in this replay), scored per track. */
  outages: DriveOutage[];
  /** Per track (`phone`, `replay`, `compare`), its distance from every clean satellite fix. */
  errors: Record<string, ViewerErrors>;
  /** Time without a clean satellite fix for over 15 s, s. */
  noGpsS: number;
  /** Routes planned in the app, and guidance at each published position: [t, plan, state, along m, off m, to next m, next]. */
  routes: { plans: ViewerRoutePlan[]; progress: [number, number, string, number, number | null, number, number][] };
  /**
   * Phone-only replays: what the dot drew on, at ≤ 2 Hz: [t, km/h of the phone's own speed (null: unknown), source
   * ('dr' = the phone's dead reckoning, 'gnss', 'manual'), other roads the car may be on [lat, lon, weight][]].
   */
  phoneOnly: [number, number | null, string, [number, number, number][]][] | null;
}

const r = (v: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
const deg = (rad: number) => (rad * 180) / Math.PI;

const packShown = (track: ShownPoint[]): ViewerShown[] => track.map((p) => [r(p.t, 2), r(p.lat, 7), r(p.lon, 7), r(p.acc, 1)]);

export function buildViewerData(file: string, trip: TripLog, options: ReplayOptions = {}, extras: ViewerExtras = {}): ViewerData {
  const withParticles = (o: ReplayOptions): ReplayOptions => ({ trackStepS: 0.2, ...o, ...(o.mapMatch ? { mapMatch: { particlesEveryS: 1, ...o.mapMatch } } : {}) });
  const replay: NonNullable<ViewerExtras["replay"]> = extras.replay ?? ((o: ReplayOptions) => replayTrip(trip, o));
  const result = replay(withParticles(options));
  const compareResult = extras.compare ? replay({ trackStepS: 0.2, ...extras.compare.options }) : null;
  const shownOf = (res: ReturnType<typeof replay>) =>
    res.published ? estimateTrack(res.published.map((p) => ({ ...p, tUs: p.timestampUs })), trip.startUs) : replayShownTrack(res);
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
    // Phone-only replays: what the replay's own navigator did (on the route, off it, the turns and fixes it jumped to).
    ...(extras.phoneOnly ? (result.notes ?? []).filter((n) => n.text.startsWith("nav phone-only")).map((n) => ({ t: tS(n.tUs), kind: "replay", text: `replay: ${n.text}` })) : []),
  ].sort((a, b) => a.t - b.t);

  // The stretches without GNSS, and how far off each track was.
  const shown = shownOf(result);
  const phone = phoneTrack(trip);
  const compareShown = compareResult ? shownOf(compareResult) : null;
  const tracks: Record<string, ShownPoint[]> = { replay: shown, ...(phone.length ? { phone } : {}), ...(compareShown ? { compare: compareShown } : {}) };
  const appCuts = extras.appCuts ?? [];
  const sameWindow = (a: { fromS: number; toS: number }, b: { fromS: number; toS: number }) =>
    Math.abs(a.fromS - b.fromS) < 0.5 && Math.abs(Math.min(a.toS, result.summary.durationS) - Math.min(b.toS, result.summary.durationS)) < 0.5;
  const windows: OutageWindow[] = [
    ...appCuts.map((c) => ({ kind: "app-cut" as const, fromS: c.fromS, toS: c.toS })),
    ...result.summary.cuts.filter((c) => !appCuts.some((a) => sameWindow(a, c))).map((c) => ({ kind: "replay-cut" as const, fromS: c.fromS, toS: c.toS })),
    ...(options.jam ?? []).map((j) => ({ kind: "replay-cut" as const, fromS: j.fromS, toS: j.toS })),
  ];
  const truth = truthFixes(trip);
  const errors: Record<string, ViewerErrors> = {};
  for (const [key, track] of Object.entries(tracks)) {
    errors[key] = [];
    for (const f of truth) {
      const p = trackAt(track, f.t);
      if (!p) continue;
      const e = haversineM(p, f);
      errors[key].push([r(f.t, 2), r(e, 1), e <= p.acc ? 1 : 0]);
    }
  }

  // Routes: a plan's polyline and maneuvers carry its record's timestamp (a `resume` logs the same plan again).
  const num = (v: number) => (Number.isFinite(v) ? v : null);
  const plans: ViewerRoutePlan[] = trip.navRoute.map((p) => ({
    t: tS(p.tUs),
    id: p.planId,
    reason: p.reason,
    status: p.status,
    lengthM: num(p.lengthM),
    durationS: num(p.durationS),
    planMs: r(p.planMs, 1),
    wallMs: r(p.wallMs, 1),
    states: p.states,
    slices: p.slices,
    points: trip.navRoutePoints.filter((q) => q.planId === p.planId && q.tUs === p.tUs).map((q): [number, number] => [r(q.latDeg, 6), r(q.lonDeg, 6)]),
    maneuvers: trip.navRouteManeuvers
      .filter((m) => m.planId === p.planId && m.tUs === p.tUs)
      .map((m) => ({ kind: m.kind, exit: m.exit, lat: r(m.latDeg, 6), lon: r(m.lonDeg, 6), atM: r(m.atM, 1) })),
  }));
  const progress = trip.navRouteProgress.map((g): [number, number, string, number, number | null, number, number] => [
    tS(g.tUs),
    g.planId,
    g.state,
    r(g.alongM, 1),
    Number.isFinite(g.offM) ? r(g.offM, 1) : null,
    r(g.toNextM, 1),
    g.nextIndex,
  ]);

  let phoneOnly: ViewerData["phoneOnly"] = null;
  if (extras.phoneOnly && result.published) {
    phoneOnly = [];
    const alts = result.publishedAlternatives ?? [];
    let last = -Infinity;
    result.published.forEach((p, i) => {
      const t = tS(p.timestampUs);
      if (t - last < 0.5) return;
      last = t;
      const v = p.speedMps;
      phoneOnly!.push([
        t,
        v !== undefined && Number.isFinite(v) ? r(v * 3.6, 1) : null,
        p.source ?? "",
        (alts[i] ?? []).map((a): [number, number, number] => [r(a.lat, 6), r(a.lon, 6), r(a.weight, 3)]),
      ]);
    });
  }

  const sync = trip.timeSync[0];
  return {
    file,
    info,
    durationS: r(result.summary.durationS, 1),
    obdDistanceM: r(obdOdometer(trip)(trip.startUs + result.summary.durationS * 1e6), 0),
    startUtcMs: sync ? (sync.utcUs - (sync.tUs - trip.startUs)) / 1000 : null,
    options: {
      cuts: result.summary.cuts.map((c) => ({ fromS: c.fromS, toS: c.toS, ...(c.openLoop ? { openLoop: true } : {}) })),
      gnssLagS: options.nav?.estimateGnssLag === false ? (options.nav.gnssLagS ?? null) : null,
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
    shown: packShown(shown),
    phone: packShown(phone),
    compare: compareShown && extras.compare ? { label: extras.compare.label, shown: packShown(compareShown) } : null,
    outages: driveOutages(trip, result.summary.durationS, windows, tracks),
    errors,
    noGpsS: r(noGpsWindows(truth, result.summary.durationS).reduce((s, w) => s + w.toS - w.fromS, 0), 0),
    routes: { plans, progress },
    phoneOnly,
  };
}
