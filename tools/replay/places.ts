// Jammed drives scored by where they end (MAPMATCH-SPEC §15.13): with no GPS there is no truth along the way, but
// drives start and end at places known to a few metres (home, a parking spot). Each drive is replayed from its start
// (a parked pose: the known place and heading) and scored by the app's dot at the end against the end place, and by
// the off-road share while moving.
// The particle filter is random and one run flips between roads on a single event, so each drive runs with `--seeds`
// seeds (default 5): per drive the median end error and the share of runs ending > 50 m off; totals over drives.
// Usage: npm run replay:places -- [--file <places.json>] [--nav '<json>'] [--mm '<json>'] [--seeds <n>] [--name <label>] [--threads <n>]
// The places file (default tools/triplog/logs/places.json, git-ignored with the logs: it holds where people live):
//   { "places": { "home": { "lat": …, "lon": … }, … },
//     "drives": [{ "log": "<file in logs/>", "start": { "at": "home", "headingDeg": 4 } | null, "end": "work" }] }
// `start.at` may also be { "lat", "lon" }; null starts cold (no parked pose).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { haversineM, type Coordinate } from "../../src/nav/geo";
import type { MapMatchConfig } from "../../src/nav/mapmatch/particle-filter";
import type { NavConfig } from "../../src/nav/navigator";
import { replayTrip } from "../../src/nav/replay/replay";
import { readTripLog } from "../../src/triplog/trip-log-reader";
import { findGraph, openGraph } from "./graph-file";
import { isMainThread, Pool, serveJobs, threadsArg } from "./pool";

interface PlacesFile {
  places: Record<string, Coordinate>;
  drives: { log: string; start: { at: string | Coordinate; headingDeg: number } | null; end: string | Coordinate }[];
}

const LOGS = path.join(path.dirname(fileURLToPath(import.meta.url)), "../triplog/logs");
const FAR_M = 50;

/** One drive with one seed: the end error and the off-road share while moving. */
interface Job {
  log: string;
  graphFile: string;
  nav: Partial<NavConfig>;
  mm: Partial<MapMatchConfig>;
  seed: number;
  start: { lat: number; lon: number; headingRad: number; posSigmaM: number; headingSigmaRad: number } | undefined;
  end: Coordinate;
}
type Run = { endM: number; off: number };

function runJob(j: Job): Run {
  const trip = readTripLog(new Uint8Array(readFileSync(path.join(LOGS, j.log))));
  const g = openGraph(j.graphFile, trip.gnss.find((f) => f.hAccM < 2000)!);
  try {
    const r = replayTrip(trip, { nav: j.nav, startPose: j.start, mapMatch: { graph: g.graph, config: { ...j.mm, seed: j.seed } } });
    const moving = r.track.filter((p) => p.mapMatch && (p.speedMps ?? 0) > 2);
    // The app's dot: the dominant cluster while it holds a road, else the EKF.
    const last = r.track.at(-1)!;
    const top = last.mapMatch && (last.mapMatch.state === "tracking" || last.mapMatch.state === "multimodal") ? last.mapMatch.clusters[0] : null;
    return { endM: haversineM(top ?? last, j.end), off: moving.filter((p) => p.mapMatch!.state === "offroad").length / (moving.length || 1) };
  } finally {
    g.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const threads = threadsArg(argv);
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const file = arg("--file") ?? path.join(LOGS, "places.json");
  const nav = JSON.parse(arg("--nav") ?? "{}") as Partial<NavConfig>;
  const mm = JSON.parse(arg("--mm") ?? "{}") as Partial<MapMatchConfig>;
  const seeds = Number(arg("--seeds") ?? 5);
  const spec = JSON.parse(readFileSync(file, "utf8")) as PlacesFile;
  const place = (p: string | Coordinate): Coordinate => (typeof p === "string" ? spec.places[p] : p);
  // The app's own loop unless the caller says otherwise.
  const navConfig: Partial<NavConfig> = { mapMatchLoop: "closed", ...nav };

  const rows: string[] = [];
  const jobs: Job[] = [];
  const drives: { log: string; jobs: number[] }[] = [];
  for (const d of spec.drives) {
    const trip = readTripLog(new Uint8Array(readFileSync(path.join(LOGS, d.log))));
    const first = trip.gnss.find((f) => f.hAccM < 2000);
    const graphFile = first && findGraph(first);
    if (!first || !graphFile) {
      rows.push(`${d.log}: no fixes or no graph`);
      continue;
    }
    const start = d.start
      ? { ...place(d.start.at), headingRad: (d.start.headingDeg * Math.PI) / 180, posSigmaM: 10, headingSigmaRad: (3 * Math.PI) / 180 }
      : undefined;
    const ids: number[] = [];
    for (let seed = 1; seed <= seeds; seed++) ids.push(jobs.push({ log: d.log, graphFile, nav: navConfig, mm, seed, start, end: place(d.end) }) - 1);
    drives.push({ log: d.log, jobs: ids });
  }
  const pool = new Pool(import.meta.url, threads);
  let runs: Run[];
  try {
    runs = await pool.map<Job, Run>(jobs);
  } finally {
    await pool.close();
  }

  const ends: number[] = [];
  const offs: number[] = [];
  let far = 0;
  let total = 0;
  const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
  for (const d of drives) {
    const driveEnds = d.jobs.map((k) => runs[k].endM);
    const endM = median(driveEnds);
    const off = d.jobs.reduce((a, k) => a + runs[k].off, 0) / d.jobs.length;
    const driveFar = driveEnds.filter((e) => e > FAR_M).length;
    far += driveFar;
    total += driveEnds.length;
    ends.push(endM);
    offs.push(off);
    rows.push(
      `${d.log.slice(0, 22).padEnd(23)} end median ${endM.toFixed(0).padStart(4)} m (${driveEnds.map((e) => e.toFixed(0)).join(" ")})  > ${FAR_M} m ${driveFar}/${driveEnds.length}  off-road ${(off * 100).toFixed(0).padStart(3)} %`,
    );
  }
  const sorted = [...ends].sort((a, b) => a - b);
  console.log(`== ${arg("--name") ?? JSON.stringify({ nav, mm })}`);
  for (const r of rows) console.log("  " + r);
  console.log(
    `  total: runs > ${FAR_M} m off ${far}/${total}; drive medians: median ${sorted[Math.floor(sorted.length / 2)]?.toFixed(0)} m, max ${sorted.at(-1)?.toFixed(0)} m, sum ${ends.reduce((a, b) => a + b, 0).toFixed(0)} m; ` +
      `off-road mean ${((100 * offs.reduce((a, b) => a + b, 0)) / (offs.length || 1)).toFixed(0)} %`,
  );
}

serveJobs(import.meta.url, runJob);
if (isMainThread) await main();
