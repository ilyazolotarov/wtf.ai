// The moments a driver would see the dot go wrong (src/nav/replay/incidents.ts), drive by drive: through the app
// replay on several filter seeds, and as the phone drew it then (the log's own `nav_estimate`). Needs the drive's
// truth next to its log (`<log>.truth.json`: drawn in the viewer, or written with a simulated drive).
//
//   npm run replay:incidents -- tools/triplog/logs/emulator/*.ulg            # 8 seeds, major incidents
//   npm run replay:incidents -- tools/triplog/logs/synthetic                 # every log in a folder
//   npm run replay:incidents -- <logs> --seeds 3 --minor --threads 8
//   npm run replay:incidents -- <logs> --json out.json  # every run's incidents and coverage, for analysis
//   npm run replay:incidents -- <logs> --json after.json --against before.json   # per drive: what got worse, better
//   npm run replay:incidents -- <logs> --all     # every drive's runs, not only the failing ones
//   npm run replay:incidents -- <logs> --mm '{"dksSigma":0.03}' --nav '<json>'   # an experiment
//   npm run replay:incidents -- <logs> --puck '{"headingCueFactor":1}'   # the dot's cues off (puck.ts), for a before
//   npm run replay:incidents -- tools/triplog/logs/synthetic --only lost,demo   # logs whose names contain one of these
//   npm run replay:incidents -- <logs> --exact-timing   # the truth's timing has no doubt (simulated, emulated drives)
//
// A drive passes with no major incident on any seed.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { MapMatchConfig } from "../../src/nav/mapmatch/particle-filter";
import type { NavConfig } from "../../src/nav/navigator";
import { puckTuning } from "../../src/nav/position/puck";
import { haversineM } from "../../src/nav/geo";
import { drawnTruthTrack, pointAlong, type DrawnTruth, type DrawnTruthTrack } from "../../src/nav/replay/drawn-truth";
import { describeIncident, findIncidents, INCIDENT_STEP_S, type DotSample, type Incident, type IncidentCoverage } from "../../src/nav/replay/incidents";
import { appOutageCuts } from "../../src/nav/replay/replay";
import { MemoryKeyValueStore, phoneOf, replayTripInApp } from "../../src/services/navigation/app-replay";
import { CalibrationStore } from "../../src/services/navigation/calibration-store";
import type { NavEstimateRecord } from "../../src/triplog/schema";
import { readTripLog, type TripLog } from "../../src/triplog/trip-log-reader";
import { carOf, drawnStartPose, graphFor, phoneRouteFor } from "./app-chain";
import { withHiddenRoads } from "./hidden-roads";
import { isMainThread, Pool, serveJobs, threadsArg } from "./pool";

interface Job {
  file: string;
  /** null: the phone's own track from the log. */
  seed: number | null;
  exactTiming: boolean;
  /** Experiments: navigator and map-matching settings over the app's. */
  nav?: Partial<NavConfig>;
  mm?: Partial<MapMatchConfig>;
  puck?: Partial<typeof puckTuning>;
}

interface JobResult {
  file: string;
  seed: number | null;
  incidents: Incident[];
  coverage?: IncidentCoverage;
  unjudged?: string;
  error?: string;
}

/** The speed scale the app stores for the simulated car after a drive with GPS (sim-drives.ts `gps` scenario). */
const SIM_LEARNED_KS = 1.016;

const truthFile = (file: string) => file.replace(/\.ulg$/, ".truth.json");
/** A simulated drive's exact timing (tools/replay/sim-drives.ts), when there is one. */
const simFile = (file: string) => {
  const f = file.replace(/\.ulg$/, ".sim.json");
  return existsSync(f) ? f : null;
};

interface SimTruth {
  /** [t s, m along the truth's path]. */
  timeline: [number, number][];
  /** Roads the car drives that the navigator's map lacks (`unmapped`). */
  hidden?: number[];
}

/** The truth of a simulated drive: its path, timed exactly (no doubt). */
function simTruth(drawn: DrawnTruth, sim: SimTruth): DrawnTruthTrack {
  const p = drawn.path;
  const cum = [0];
  for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + haversineM({ lat: p[i - 1][0], lon: p[i - 1][1] }, { lat: p[i][0], lon: p[i][1] }));
  const points = sim.timeline.map(([t, s]): [number, number, number, number, number] => {
    const [lat, lon] = pointAlong(p, cum, s);
    return [t, lat, lon, s, 0];
  });
  return { path: p, cum, points, pathM: cum.at(-1) ?? 0, odometerM: cum.at(-1) ?? 0, anchors: 0, doubtM: 0 };
}

function dotsOf(records: readonly (Pick<NavEstimateRecord, "latDeg" | "lonDeg" | "headingRad"> & { tUs: number })[], startUs: number): DotSample[] {
  return records
    .filter((r) => Number.isFinite(r.latDeg))
    .map((r) => ({ t: (r.tUs - startUs) / 1e6, lat: r.latDeg, lon: r.lonDeg, headingRad: Number.isFinite(r.headingRad) ? r.headingRad : undefined }));
}

let cached: { file: string; trip: TripLog; drawn: DrawnTruth } | null = null;

const PUCK_DEFAULTS = { ...puckTuning };

function runJob(job: Job): JobResult {
  Object.assign(puckTuning, PUCK_DEFAULTS, job.puck);
  try {
    if (cached?.file !== job.file) {
      cached = {
        file: job.file,
        trip: readTripLog(new Uint8Array(readFileSync(job.file))),
        drawn: JSON.parse(readFileSync(truthFile(job.file), "utf8")) as DrawnTruth,
      };
    }
    const { trip, drawn } = cached;
    const sim = simFile(job.file) ? (JSON.parse(readFileSync(simFile(job.file)!, "utf8")) as SimTruth) : null;
    const hidden = sim?.hidden ?? [];
    const truth = sim ? simTruth(drawn, sim) : drawnTruthTrack(trip, drawn, INCIDENT_STEP_S);
    if (job.exactTiming) truth.points = truth.points.map(([t, lat, lon, s]) => [t, lat, lon, s, 0]);
    if (job.seed === null) return { file: job.file, seed: null, ...findIncidents(truth, dotsOf(trip.navEstimate, trip.startUs)) };
    const graph = graphFor(trip);
    try {
      const calibration = new CalibrationStore(new MemoryKeyValueStore(), phoneOf(trip));
      // A simulated jammed start: the car where the app parked it after the drive before (the truth's start), as the
      // regression check's drawn start.
      const vin = carOf(trip, new Map());
      const jamStart = trip.info.sim_scenario === "jamstart" || trip.info.sim_scenario === "unmapped";
      const parked = jamStart && vin ? drawnStartPose(trip, drawn) : null;
      if (parked && vin) {
        calibration.saveParkedPose(vin, parked);
        // …and the speed scale it learned on earlier drives with GPS (the simulated car's GPS drives end at 1.015–1.017).
        calibration.saveSpeedScale(vin, SIM_LEARNED_KS, 1e-4);
      }
      const r = replayTripInApp(trip, {
        calibration,
        roadGraph: graph?.active && hidden.length ? { ...graph.active, graph: withHiddenRoads(graph.active.graph, hidden) } : graph?.active,
        vin: carOf(trip, new Map()),
        cuts: appOutageCuts(trip),
        nav: job.nav,
        mapMatchConfig: { ...job.mm, seed: job.seed },
        // The routes the driver had, as the app gives them to the service (the puck leans on the route).
        phoneRoutes: phoneRouteFor(trip, null).routes,
      });
      const dots = dotsOf(r.published.map((p) => ({ ...p, tUs: p.timestampUs })), trip.startUs);
      const fixes = simFile(job.file)
        ? []
        : r.fixes.filter((f) => f.satellite && f.status === "accepted").map((f) => ({ t: f.tS, lat: f.fix.lat, lon: f.fix.lon, hAccM: f.fix.hAccM }));
      return { file: job.file, seed: job.seed, ...findIncidents(truth, dots, fixes) };
    } finally {
      graph?.close();
    }
  } catch (e) {
    return { file: job.file, seed: job.seed, incidents: [], error: String(e) };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const threads = threadsArg(argv);
  const arg = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const seeds = Number(arg("--seeds") ?? 8);
  const minor = argv.includes("--minor");
  const exactTiming = argv.includes("--exact-timing");
  const json = arg("--json");
  const against = arg("--against");
  const all = argv.includes("--all");
  const nav = arg("--nav") ? (JSON.parse(arg("--nav")!) as Partial<NavConfig>) : undefined;
  const mm = arg("--mm") ? (JSON.parse(arg("--mm")!) as Partial<MapMatchConfig>) : undefined;
  const only = arg("--only");
  const puck = arg("--puck") ? (JSON.parse(arg("--puck")!) as Partial<typeof puckTuning>) : undefined;
  // Logs, or folders of them (a long list of paths is past what a Windows command line takes).
  const files = argv
    .filter((a, i) => !a.startsWith("--") && !["--seeds", "--json", "--against", "--nav", "--mm", "--only", "--puck"].includes(argv[i - 1]))
    .flatMap((a) => (existsSync(a) && statSync(a).isDirectory() ? readdirSync(a).filter((f) => f.endsWith(".ulg")).sort().map((f) => path.join(a, f)) : [a]))
    .filter((a) => a.endsWith(".ulg") && (!only || only.split(",").some((o) => a.includes(o))));
  const withTruth = files.filter((f) => existsSync(truthFile(f)));
  for (const f of files) if (!withTruth.includes(f)) console.log(`${path.basename(f)}: no truth (${path.basename(truthFile(f))}), skipped`);
  const jobs: Job[] = withTruth.flatMap((file) => [{ file, seed: null, exactTiming }, ...Array.from({ length: seeds }, (_, i) => ({ file, seed: i + 1, exactTiming, nav, mm, puck }))]);
  const pool = new Pool(import.meta.url, threads);
  let results: JobResult[];
  try {
    results = await pool.map<Job, JobResult>(jobs);
  } finally {
    await pool.close();
  }
  let failed = 0;
  for (const file of withTruth) {
    const runs = results.filter((r) => r.file === file);
    const replays = runs.filter((r) => r.seed !== null);
    // Not judged (an error, or nothing drawn while the car moved) fails too: it must never pass for clean.
    const bad = replays.filter((r) => r.error || r.unjudged || !r.coverage?.movingS || r.incidents.some((i) => i.major)).length;
    if (bad) failed++;
    if (!bad && !all) continue;
    console.log(`\n${path.basename(file)}: failed on ${bad} of ${replays.length} seeds (a major incident, or not judged)`);
    for (const r of runs) {
      // The phone's own track: only a log the app recorded has one.
      if (r.seed === null && !r.coverage?.scoredS && !r.error) continue;
      const shown = r.incidents.filter((i) => minor || i.major);
      const who = r.seed === null ? "phone " : `seed ${String(r.seed).padEnd(2)}`;
      const c = r.coverage;
      const judged = c ? `[${c.scoredS}/${c.truthS} s judged, ${c.movingS} s moving; dot off ${c.errorMedianM ?? "—"} m median, ${c.errorMaxM ?? "—"} m worst] ` : "";
      console.log(`  ${who} ${judged}${r.unjudged ? `not judged: ${r.unjudged}` : r.error ? `error: ${r.error.split("\n")[0]}` : shown.length ? shown.map(describeIncident).join(" · ") : "—"}`);
    }
  }
  summary(results);
  if (against) compare(JSON.parse(readFileSync(against, "utf8")) as JobResult[], results.map((r) => ({ ...r, file: path.basename(r.file) })));
  if (json) writeFileSync(json, JSON.stringify(results.map((r) => ({ ...r, file: path.basename(r.file) }))));
  console.log(`\n${withTruth.length - failed} of ${withTruth.length} drives without a major incident on any seed`);
}

/** The GPS scenario of a simulated drive (its name's last part), else "real". */
const scenarioOf = (file: string) => /-(gps|lost|spoof|jam|jamstart|unmapped)\.ulg$/.exec(file)?.[1] ?? "real";
const KINDS = ["lost", "wrong-way", "wrong-road", "far", "jump", "backwards"] as const;

/** Major incidents by kind and scenario, over every replay (seed) of every drive; and the drives failing. */
function summary(results: JobResult[]) {
  const replays = results.filter((r) => r.seed !== null);
  const scenarios = [...new Set(replays.map((r) => scenarioOf(r.file)))];
  console.log("\nmajor incidents per kind, all seeds, not counting those while lost (drives failing on any seed):");
  console.log(`  ${"".padEnd(8)}${KINDS.map((k) => k.padStart(12)).join("")}${"failing".padStart(16)}`);
  for (const sc of scenarios) {
    const rs = replays.filter((r) => scenarioOf(r.file) === sc);
    const counts = KINDS.map((k) => rs.reduce((n, r) => n + r.incidents.filter((i) => i.major && !i.whileLost && i.kind === k).length, 0));
    const files = [...new Set(rs.map((r) => r.file))];
    const failing = files.filter((f) => rs.some((r) => r.file === f && (r.error || r.unjudged || !r.coverage?.movingS || r.incidents.some((i) => i.major)))).length;
    console.log(`  ${sc.padEnd(8)}${counts.map((c) => String(c).padStart(12)).join("")}${`${failing} of ${files.length}`.padStart(16)}`);
  }
}

/** Each drive against a saved run, seed by seed: major incidents of each kind, before → now. */
function compare(before: JobResult[], now: JobResult[]) {
  const key = (r: JobResult) => `${r.file}|${r.seed}`;
  const old = new Map(before.filter((r) => r.seed !== null).map((r) => [key(r), r]));
  const majors = (r: JobResult | undefined, k: string) => (r ? r.incidents.filter((i) => i.major && !i.whileLost && i.kind === k).length : 0);
  const worse: string[] = [];
  const better: string[] = [];
  const total = new Map<string, [number, number]>(KINDS.map((k) => [k, [0, 0]]));
  for (const file of [...new Set(now.map((r) => r.file))]) {
    const rs = now.filter((r) => r.file === file && r.seed !== null);
    const changes: string[] = [];
    let delta = 0;
    for (const k of KINDS) {
      const a = rs.map((r) => majors(old.get(key(r)), k));
      const b = rs.map((r) => majors(r, k));
      const [sa, sb] = [a.reduce((x, y) => x + y, 0), b.reduce((x, y) => x + y, 0)];
      const t = total.get(k)!;
      t[0] += sa;
      t[1] += sb;
      if (sa !== sb) changes.push(`${k} ${a.join("/")} → ${b.join("/")}`);
      delta += sb - sa;
    }
    if (!changes.length) continue;
    (delta > 0 ? worse : better).push(`  ${file}: ${changes.join(" · ")}`);
  }
  console.log("\nagainst the saved run, per drive (major incidents per seed, before → now):");
  console.log(`worse (${worse.length}):${worse.length ? "\n" + worse.join("\n") : " none"}`);
  console.log(`better (${better.length}):${better.length ? "\n" + better.join("\n") : " none"}`);
  console.log(`totals: ${KINDS.map((k) => `${k} ${total.get(k)![0]} → ${total.get(k)![1]}`).join(" · ")}`);
}

serveJobs(import.meta.url, runJob);
if (isMainThread) await main();
