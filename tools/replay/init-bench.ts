// Heading-init benchmark (MAPMATCH-SPEC §8, §10.3): how soon, and how well, the EKF starts under
// jamming, with and without the road map. Each drive runs as recorded, and as sessions starting
// every `--every` seconds with jamming simulated from the session start to the end of the log
// (drives with clean GNSS only). Starts are scored against the ground truth (truth-match.ts), else
// against a clean replay's EKF, else (heading only) against its later heading taken back by the gyro.
//
//   npm run replay:bench -- --jam-start [--every 60] [--graph <file>] [--mm-config '<json>'] [--verbose] <logs>

import { readFileSync } from "node:fs";
import path from "node:path";

import { haversineM } from "../../src/nav/geo";
import type { MapMatchConfig } from "../../src/nav/mapmatch/particle-filter";
import type { NavConfig } from "../../src/nav/navigator";
import type { OdometryStep } from "../../src/nav/odometry/odometry-output";
import { replayTrip, type ReplayInit, type ReplayOptions, type TrackPoint } from "../../src/nav/replay/replay";
import { matchTruth, truthPose, type TruthMatch } from "../../src/nav/replay/truth-match";
import { isSatelliteFix } from "../../src/nav/types";
import { readTripLog, type TripLog } from "../../src/triplog/trip-log-reader";
import { findGraph, openGraph } from "./graph-file";

export interface InitBenchOptions {
  nav: Partial<NavConfig>;
  mmConfig: Partial<MapMatchConfig>;
  graph?: string;
  everyS: number;
  verbose: boolean;
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

function score(init: ReplayInit | null, ref: Reference, totalM: number): Scored {
  if (!init) return { method: "never", tS: null, distanceM: totalM, headingErrDeg: null, posErrM: null, headingRatio: null, posRatio: null, ref: "" };
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
  };
}

const fmt = (s: Scored) =>
  `${s.method.padEnd(9)} ${s.tS === null ? "      " : `${s.tS.toFixed(0).padStart(5)}s`} ${(s.distanceM / 1000).toFixed(2)} km` +
  `  hdg ${s.headingErrDeg === null ? "  —" : `${s.headingErrDeg.toFixed(1).padStart(4)}° ${s.headingRatio!.toFixed(1)}σ`}` +
  `  pos ${s.posErrM === null ? "   —" : `${s.posErrM.toFixed(0).padStart(4)} m ${s.posRatio!.toFixed(1)}σ`}` +
  (s.ref && s.ref !== "truth" ? ` (${s.ref})` : "");

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

export function runInitBench(files: string[], o: InitBenchOptions): void {
  const rows: { file: string; session: string; plain: Scored; map: Scored }[] = [];
  for (const file of files) {
    const trip = readTripLog(new Uint8Array(readFileSync(file)));
    const name = path.basename(file);
    const first = trip.gnss.find((f) => isSatelliteFix(f) && f.hAccM <= 10) ?? trip.gnss.find((f) => f.hAccM < 500);
    const graphFile = o.graph ?? (first ? findGraph(first) : null);
    if (!first || !graphFile) {
      console.log(`== ${name}: no road graph covers it`);
      continue;
    }
    const truthGraph = openGraph(graphFile, first);
    const navGraph = openGraph(graphFile, first);
    const truth = matchTruth(trip, truthGraph.graph);
    const steps: OdometryStep[] = [];
    const clean = replayTrip(trip, { nav: o.nav, trackStepS: 0.5, odometry: (s) => steps.push(s) });
    const ref: Reference = { trip, truth, truthGraph: truthGraph.graph, track: clean.track, initS: clean.summary.init?.tS ?? null, steps };
    const durationS = clean.summary.durationS;
    const sessions: { label: string; options: ReplayOptions }[] = [{ label: "as recorded", options: {} }];
    if (truth.points.length >= MIN_TRUTH_POINTS) {
      for (let t0 = 0; t0 < durationS; t0 += o.everyS) {
        sessions.push({ label: `jam from ${t0} s`, options: { startAtS: t0, jam: [{ fromS: t0, toS: Infinity }] } });
      }
    }
    console.log(`== ${name}  (${(clean.summary.obdDistanceM / 1000).toFixed(2)} km, truth ${truth.points.length} fixes, ${sessions.length} sessions)`);
    for (const s of sessions) {
      const plain = replayTrip(trip, { nav: o.nav, ...s.options });
      const totalM = plain.summary.obdDistanceM;
      if (s.options.startAtS !== undefined && totalM < MIN_SESSION_M) continue;
      const map = replayTrip(trip, { nav: o.nav, ...s.options, mapMatch: { graph: navGraph.graph, config: o.mmConfig } });
      const row = { file: name, session: s.label, plain: score(plain.summary.init, ref, totalM), map: score(map.summary.init, ref, totalM) };
      rows.push(row);
      if (o.verbose || s.options.startAtS === undefined) console.log(`  ${s.label.padEnd(15)} no map: ${fmt(row.plain)}   |   map: ${fmt(row.map)}`);
    }
    truthGraph.close();
    navGraph.close();
  }

  const simulated = rows.filter((r) => r.session !== "as recorded");
  for (const [label, set] of [
    ["as recorded", rows.filter((r) => r.session === "as recorded")],
    ["simulated jam", simulated],
  ] as const) {
    if (!set.length) continue;
    console.log(`\n${label}: ${set.length} sessions`);
    for (const key of ["plain", "map"] as const) {
      const started = set.filter((r) => r[key].tS !== null);
      const hdg = started.map((r) => r[key].headingErrDeg).filter((v): v is number => v !== null);
      const pos = started.map((r) => r[key].posErrM).filter((v): v is number => v !== null);
      const hr = started.map((r) => r[key].headingRatio).filter((v): v is number => v !== null);
      const pr = started.map((r) => r[key].posRatio).filter((v): v is number => v !== null);
      const byMethod = new Map<string, number>();
      for (const r of started) byMethod.set(r[key].method, (byMethod.get(r[key].method) ?? 0) + 1);
      console.log(
        `  ${key === "plain" ? "no map" : "map   "}  started ${started.length}/${set.length} (${[...byMethod].map(([m, k]) => `${m} ${k}`).join(", ") || "—"})` +
          `  distance median ${(median(started.map((r) => r[key].distanceM)) / 1000).toFixed(2)} km` +
          `  heading error median ${median(hdg).toFixed(1)}° max ${hdg.length ? Math.max(...hdg).toFixed(1) : "—"}° (>10°: ${hdg.filter((v) => v > 10).length})` +
          `  position error median ${median(pos).toFixed(0)} m max ${pos.length ? Math.max(...pos).toFixed(0) : "—"} m` +
          `  error ÷ σ: heading median ${median(hr).toFixed(1)} max ${hr.length ? Math.max(...hr).toFixed(1) : "—"}, position median ${median(pr).toFixed(1)} max ${pr.length ? Math.max(...pr).toFixed(1) : "—"}`,
      );
    }
    const both = set.filter((r) => r.map.tS !== null);
    const sooner = both.filter((r) => r.plain.tS === null || r.map.distanceM < r.plain.distanceM).length;
    console.log(`  map starts sooner than without it in ${sooner} of ${set.length}`);
  }
}
