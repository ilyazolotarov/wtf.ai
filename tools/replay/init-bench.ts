// Heading-init benchmark (MAPMATCH-SPEC §8, §10.3): how soon, and how well, the EKF starts under
// jamming, with and without the road map. Each drive runs as recorded, and as sessions starting
// every `--every` seconds with jamming simulated from the session start to the end of the log
// (drives with clean GNSS only). Starts are scored against the ground truth (truth-match.ts), else
// against a clean replay's EKF, else (heading only) against its later heading taken back by the gyro.
//
//   npm run replay:bench -- --jam-start [--every 60] [--seeds 3] [--graph <file>] [--mm-config '<json>'] [--compass] [--verbose] <logs>
//
// The particle filter is random, and one seed is too noisy to compare changes by (single sessions
// flip between a map and an alignment start): each session runs with `--seeds` seeds, pooled.
//
// --compass (drives with a magnetometer only) adds map runs with a compass calibrated on the other
// drives, and with that calibration turned 90° and 180°: a wrong one must cost time, never the road.
//
// Sessions run on worker threads (pool.ts, `--threads <n>`); output keeps the drive and session order.

import { readFileSync } from "node:fs";
import path from "node:path";

import { mergeCalibrations, type CompassCalibration } from "../../src/nav/compass/compass";
import { haversineM } from "../../src/nav/geo";
import type { MapMatchConfig } from "../../src/nav/mapmatch/particle-filter";
import type { NavConfig } from "../../src/nav/navigator";
import type { OdometryStep } from "../../src/nav/odometry/odometry-output";
import { replayTrip, type ReplayInit, type ReplayOptions, type TrackPoint } from "../../src/nav/replay/replay";
import { matchTruth, truthPose, type TruthMatch } from "../../src/nav/replay/truth-match";
import { isSatelliteFix } from "../../src/nav/types";
import { readTripLog, type TripLog } from "../../src/triplog/trip-log-reader";
import { findGraph, openGraph } from "./graph-file";
import { Pool, serveJobs } from "./pool";

export interface InitBenchOptions {
  nav: Partial<NavConfig>;
  mmConfig: Partial<MapMatchConfig>;
  graph?: string;
  everyS: number;
  verbose: boolean;
  compass?: boolean;
  /** Particle-filter seeds: every session runs once per seed and the results are pooled. */
  seeds: number[];
  threads: number;
}

/** A session's EKF start, scored. */
interface Scored {
  method: string;
  tS: number | null;
  distanceM: number;
  headingErrDeg: number | null;
  posErrM: number | null;
  /** Errors ÷ the σ the EKF started with (is the start honest?). */
  headingRatio: number | null;
  posRatio: number | null;
  ref: string;
  /** Share of moving samples with a particle on the true road (null: no truth, or no map). */
  survival: number | null;
}

const DEG = 180 / Math.PI;
const wrapDeg = (rad: number) => Math.abs(Math.atan2(Math.sin(rad), Math.cos(rad))) * DEG;
/** Clean drives get simulated sessions: enough truth to score them. */
const MIN_TRUTH_POINTS = 50;
/** A simulated session needs this much driving left after its start. */
const MIN_SESSION_M = 500;

/** Cumulative odometry turn at a time (interpolated within the chunk). */
function turnAt(steps: OdometryStep[], tUs: number): number {
  let lo = 0;
  let hi = steps.length - 1;
  if (!steps.length) return 0;
  if (tUs <= steps[0].t0Us) return steps[0].turnRad - steps[0].dpsiRad;
  if (tUs >= steps[hi].t1Us) return steps[hi].turnRad;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (steps[mid].t1Us <= tUs) lo = mid;
    else hi = mid;
  }
  const s = steps[hi];
  const f = s.t1Us > s.t0Us ? Math.max(0, Math.min(1, (tUs - s.t0Us) / (s.t1Us - s.t0Us))) : 1;
  return s.turnRad - s.dpsiRad * (1 - f);
}

interface Reference {
  trip: TripLog;
  truth: TruthMatch;
  truthGraph: ReturnType<typeof openGraph>["graph"];
  track: TrackPoint[];
  initS: number | null;
  steps: OdometryStep[];
}

/** The true pose at an EKF start, and what it is based on. */
function referenceAt(ref: Reference, tS: number): { lat?: number; lon?: number; headingRad: number; source: string } | null {
  const tUs = ref.trip.startUs + tS * 1e6;
  const t = ref.truth.at(tUs);
  if (t) return { ...truthPose(ref.truthGraph, t), source: "truth" };
  const near = ref.track.find((p) => Math.abs(p.tS - tS) <= 0.5);
  if (near && near.mode === "dr" && ref.initS !== null && tS >= ref.initS + 10 && near.headingSigmaRad! <= (5 / DEG)) {
    return { lat: near.lat, lon: near.lon, headingRad: near.headingRad!, source: "ekf" };
  }
  // Heading only: the clean replay's heading later, taken back by the turn the gyro measured.
  const later = ref.track.filter((p) => p.tS >= tS && p.mode === "dr" && p.headingRad !== undefined);
  const best = later.find((p) => p.headingSigmaRad! <= 5 / DEG) ?? later.sort((a, b) => a.headingSigmaRad! - b.headingSigmaRad!)[0];
  if (!best) return null;
  const turn = turnAt(ref.steps, ref.trip.startUs + best.tS * 1e6) - turnAt(ref.steps, tUs);
  return { headingRad: best.headingRad! - turn, source: `gyro ±${(best.headingSigmaRad! * DEG).toFixed(0)}°` };
}

function score(init: ReplayInit | null, ref: Reference, totalM: number, survival: number | null = null): Scored {
  if (!init) return { method: "never", tS: null, distanceM: totalM, headingErrDeg: null, posErrM: null, headingRatio: null, posRatio: null, ref: "", survival };
  const truth = referenceAt(ref, init.tS);
  const e = init.estimate;
  const headingErrDeg = truth && e?.headingRad !== undefined ? wrapDeg(e.headingRad - truth.headingRad) : null;
  const posErrM = truth?.lat !== undefined && e ? haversineM(e, { lat: truth.lat, lon: truth.lon! }) : null;
  return {
    method: init.method,
    tS: init.tS,
    distanceM: init.distanceM,
    headingErrDeg,
    posErrM,
    headingRatio: headingErrDeg !== null && e?.headingSigmaRad ? headingErrDeg / (e.headingSigmaRad * DEG) : null,
    // accuracyM is the 68 % radius (1.5 σ).
    posRatio: posErrM !== null && e ? posErrM / (e.accuracyM / 1.5) : null,
    ref: truth?.source ?? "none",
    survival,
  };
}

const fmt = (s: Scored) =>
  `${s.method.padEnd(9)} ${s.tS === null ? "      " : `${s.tS.toFixed(0).padStart(5)}s`} ${(s.distanceM / 1000).toFixed(2)} km` +
  `  hdg ${s.headingErrDeg === null ? "  —" : `${s.headingErrDeg.toFixed(1).padStart(4)}° ${s.headingRatio!.toFixed(1)}σ`}` +
  `  pos ${s.posErrM === null ? "   —" : `${s.posErrM.toFixed(0).padStart(4)} m ${s.posRatio!.toFixed(1)}σ`}` +
  (s.survival !== null && s.survival < 1 ? `  surv ${(s.survival * 100).toFixed(0)} %` : "") +
  (s.ref && s.ref !== "truth" ? ` (${s.ref})` : "");

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

const COMPASS_KEYS = ["compass", "compass 90°", "compass 180°"] as const;
const ROTATIONS: Record<(typeof COMPASS_KEYS)[number], number> = { compass: 0, "compass 90°": Math.PI / 2, "compass 180°": Math.PI };
type Key = "plain" | "map" | (typeof COMPASS_KEYS)[number];
type Row = { file: string; session: string; seed: number } & Partial<Record<Key, Scored>>;

type Session = { label: string; options: ReplayOptions };
type Job =
  | { kind: "calibration"; file: string; o: InitBenchOptions }
  | { kind: "sessions"; file: string; o: InitBenchOptions }
  | { kind: "session"; file: string; o: InitBenchOptions; session: Session; compassCal: CompassCalibration | null };
/** A drive's sessions and its header line, or the line to print when no graph covers it. */
type Plan = { header: string; sessions: Session[] } | { skip: string };

// Per worker: each drive it gets sessions of, with its truth and clean replay (built once per worker).
const drives = new Map<string, { trip: TripLog; navGraph: ReturnType<typeof openGraph>["graph"]; ref: Reference; truth: TruthMatch; durationS: number; obdDistanceM: number } | null>();
function drive(file: string, o: InitBenchOptions) {
  if (drives.has(file)) return drives.get(file)!;
  const trip = readTripLog(new Uint8Array(readFileSync(file)));
  const first = trip.gnss.find((f) => isSatelliteFix(f) && f.hAccM <= 10) ?? trip.gnss.find((f) => f.hAccM < 500);
  const graphFile = o.graph ?? (first ? findGraph(first) : null);
  if (!first || !graphFile) {
    drives.set(file, null);
    return null;
  }
  const truthGraph = openGraph(graphFile, first).graph;
  const navGraph = openGraph(graphFile, first).graph;
  const truth = matchTruth(trip, truthGraph);
  const steps: OdometryStep[] = [];
  const clean = replayTrip(trip, { nav: o.nav, trackStepS: 0.5, odometry: (s) => steps.push(s) });
  const ref: Reference = { trip, truth, truthGraph, track: clean.track, initS: clean.summary.init?.tS ?? null, steps };
  const d = { trip, navGraph, ref, truth, durationS: clean.summary.durationS, obdDistanceM: clean.summary.obdDistanceM };
  drives.set(file, d);
  return d;
}

function plan(file: string, o: InitBenchOptions): Plan {
  const d = drive(file, o);
  if (!d) return { skip: `== ${path.basename(file)}: no road graph covers it` };
  const sessions: Session[] = [{ label: "as recorded", options: {} }];
  if (d.truth.points.length >= MIN_TRUTH_POINTS) {
    for (let t0 = 0; t0 < d.durationS; t0 += o.everyS) {
      sessions.push({ label: `jam from ${t0} s`, options: { startAtS: t0, jam: [{ fromS: t0, toS: Infinity }] } });
    }
  }
  return {
    header: `== ${path.basename(file)}  (${(d.obdDistanceM / 1000).toFixed(2)} km, truth ${d.truth.points.length} fixes, ${sessions.length} sessions)`,
    sessions,
  };
}

/** One session, every seed: its rows and what it prints. */
function runSession(file: string, o: InitBenchOptions, s: Session, compassCal: CompassCalibration | null): { rows: Row[]; lines: string[] } {
  const { trip, navGraph, ref, truth } = drive(file, o)!;
  const name = path.basename(file);
  const rows: Row[] = [];
  const lines: string[] = [];
  const plain = replayTrip(trip, { nav: o.nav, ...s.options });
  const totalM = plain.summary.obdDistanceM;
  if (s.options.startAtS !== undefined && totalM < MIN_SESSION_M) return { rows, lines };
  const plainScore = score(plain.summary.init, ref, totalM);
  // The particle filter is random: each seed is a row (the run without the map is the same in each).
  for (const seed of o.seeds) {
    const withMap = (extra: ReplayOptions) => {
      const config = { ...o.mmConfig, seed };
      const r = replayTrip(trip, { nav: o.nav, ...s.options, ...extra, mapMatch: { graph: navGraph, truth, config } });
      return score(r.summary.init, ref, totalM, r.summary.mapMatch?.truthSurvival ?? null);
    };
    const row: Row = { file: name, session: s.label, seed, plain: plainScore, map: withMap({}) };
    if (compassCal) for (const key of COMPASS_KEYS) row[key] = withMap({ compass: { calibration: compassCal, rotateRad: ROTATIONS[key] } });
    rows.push(row);
    if (o.verbose || s.options.startAtS === undefined) {
      const extra = compassCal ? COMPASS_KEYS.map((k) => `   |   ${k}: ${fmt(row[k]!)}`).join("") : "";
      const label = o.seeds.length > 1 ? `${s.label} #${seed}` : s.label;
      lines.push(`  ${label.padEnd(20)} no map: ${fmt(row.plain!)}   |   map: ${fmt(row.map!)}${extra}`);
    }
  }
  return { rows, lines };
}

function runJob(job: Job) {
  if (job.kind === "calibration") {
    const trip = readTripLog(new Uint8Array(readFileSync(job.file)));
    const mag = !!trip.mag?.length;
    return { mag, calibration: mag ? replayTrip(trip, { nav: job.o.nav }).summary.compass.calibration : null };
  }
  if (job.kind === "sessions") return plan(job.file, job.o);
  return runSession(job.file, job.o, job.session, job.compassCal);
}
serveJobs(import.meta.url, runJob);

export async function runInitBench(files: string[], o: InitBenchOptions): Promise<void> {
  const rows: Row[] = [];
  const pool = new Pool(import.meta.url, o.threads);
  try {
    // Each drive's compass calibration as it learns it alone; a drive then runs with the others' merged.
    const learned = new Map<string, CompassCalibration>();
    const withMag = new Set<string>();
    if (o.compass) {
      const cals = await pool.map<Job, { mag: boolean; calibration: CompassCalibration | null }>(files.map((file) => ({ kind: "calibration", file, o })));
      files.forEach((file, k) => {
        if (cals[k].mag) withMag.add(file);
        if (cals[k].calibration) learned.set(file, cals[k].calibration);
      });
    }
    const compassFor = (file: string) => {
      const others = [...learned].filter(([f]) => f !== file).map(([, c]) => c);
      return withMag.has(file) && others.length ? others.reduce((a, b) => mergeCalibrations(a, b)) : null;
    };
    const kept = o.compass ? files.filter((file) => compassFor(file) !== null) : files;
    const plans = await pool.map<Job, Plan>(kept.map((file) => ({ kind: "sessions", file, o })));
    const jobs: Job[] = [];
    const owner: number[] = [];
    kept.forEach((file, k) => {
      const p = plans[k];
      if ("skip" in p) return;
      const compassCal = o.compass ? compassFor(file) : null;
      for (const session of p.sessions) {
        jobs.push({ kind: "session", file, o, session, compassCal });
        owner.push(k);
      }
    });
    const done = await pool.map<Job, { rows: Row[]; lines: string[] }>(jobs);
    kept.forEach((_, k) => {
      const p = plans[k];
      console.log("skip" in p ? p.skip : p.header);
      done.forEach((d, j) => {
        if (owner[j] !== k) return;
        rows.push(...d.rows);
        for (const line of d.lines) console.log(line);
      });
    });
  } finally {
    await pool.close();
  }

  const simulated = rows.filter((r) => r.session !== "as recorded");
  for (const [label, set] of [
    ["as recorded", rows.filter((r) => r.session === "as recorded")],
    ["simulated jam", simulated],
  ] as const) {
    if (!set.length) continue;
    const seeds = o.seeds.length > 1 ? ` × ${o.seeds.length} seeds (${o.seeds.join(", ")})` : "";
    console.log(`\n${label}: ${set.length / o.seeds.length} sessions${seeds}, counts over all ${set.length}`);
    const keys: Key[] = ["plain", "map", ...(o.compass ? COMPASS_KEYS : [])];
    for (const key of keys) {
      const all = set.map((r) => r[key]).filter((v): v is Scored => v !== undefined);
      const started = all.filter((r) => r.tS !== null);
      const hdg = started.map((r) => r.headingErrDeg).filter((v): v is number => v !== null);
      const pos = started.map((r) => r.posErrM).filter((v): v is number => v !== null);
      const hr = started.map((r) => r.headingRatio).filter((v): v is number => v !== null);
      const pr = started.map((r) => r.posRatio).filter((v): v is number => v !== null);
      const surv = all.map((r) => r.survival).filter((v): v is number => v !== null);
      const byMethod = new Map<string, number>();
      for (const r of started) byMethod.set(r.method, (byMethod.get(r.method) ?? 0) + 1);
      console.log(
        `  ${(key === "plain" ? "no map" : key).padEnd(12)}  started ${started.length}/${set.length} (${[...byMethod].map(([m, k]) => `${m} ${k}`).join(", ") || "—"})` +
          `  distance median ${(median(started.map((r) => r.distanceM)) / 1000).toFixed(2)} km` +
          `  heading error median ${median(hdg).toFixed(1)}° max ${hdg.length ? Math.max(...hdg).toFixed(1) : "—"}° (>10°: ${hdg.filter((v) => v > 10).length})` +
          `  position error median ${median(pos).toFixed(0)} m max ${pos.length ? Math.max(...pos).toFixed(0) : "—"} m` +
          `  error ÷ σ: heading median ${median(hr).toFixed(1)} max ${hr.length ? Math.max(...hr).toFixed(1) : "—"}, position median ${median(pr).toFixed(1)} max ${pr.length ? Math.max(...pr).toFixed(1) : "—"}` +
          (surv.length ? `  truth survival min ${(Math.min(...surv) * 100).toFixed(1)} % (< 100 %: ${surv.filter((v) => v < 1).length})` : ""),
      );
    }
    const both = set.filter((r) => r.map!.tS !== null);
    const sooner = both.filter((r) => r.plain!.tS === null || r.map!.distanceM < r.plain!.distanceM).length;
    console.log(`  map starts sooner than without it in ${sooner} of ${set.length}`);
    if (o.compass) {
      const c = set.filter((r) => r.compass && r.compass.tS !== null);
      const sooner = c.filter((r) => r.map!.tS === null || r.compass!.distanceM < r.map!.distanceM).length;
      const later = c.filter((r) => r.map!.tS !== null && r.compass!.distanceM > r.map!.distanceM).length;
      console.log(`  with the compass the EKF starts sooner than with the map alone in ${sooner} of ${set.length}, later in ${later}`);
    }
  }
}
