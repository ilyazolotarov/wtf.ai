// Does a replay reproduce the phone? Each log is replayed through the app (app-replay.ts) starting from what the app
// had stored (the log's `nav storage` notes) with the navigator version the phone ran, and the dot it publishes is
// compared with the one the phone logged (`nav_estimate`). With the navigation code unchanged since the log's build
// (its commit in `ver_sw`, from builds after 2026-10-05) they should agree within a few metres, and a bigger gap is
// a replay bug. With changes since, the gap is what they changed.
//   npm run replay:parity -- tools/triplog/logs/*.ulg [--threads <n>]

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { haversineM } from "../../src/nav/geo";
import { estimateTrack, trackAt } from "../../src/nav/replay/drive-report";
import { MemoryKeyValueStore, phoneOf, replayTripInApp, seedFromLog } from "../../src/services/navigation/app-replay";
import { CalibrationStore } from "../../src/services/navigation/calibration-store";
import type { MapMatchLoop } from "../../src/services/navigation/navigator-service";
import { readTripLog } from "../../src/triplog/trip-log-reader";
import { findGraph, openGraph } from "./graph-file";
import { isMainThread, Pool, serveJobs, threadsArg } from "./pool";

/** The code a replay's dot comes from: a change here since the log's build explains a gap. */
const NAV_PATHS = ["src/nav", "src/services/navigation", "src/services/position"];
/** Same code, yet the dots this far apart at the 90th percentile: the replay doesn't reproduce the app. */
const SAME_CODE_P90_M = 3;

interface Row {
  file: string;
  build: string | null;
  storage: number;
  loop: string;
  compared: number;
  p50: number;
  p90: number;
  max: number;
  /** Where the dots were farthest apart, s. */
  worstS: number;
  error?: string;
}

function compare(file: string): Row {
  const trip = readTripLog(new Uint8Array(readFileSync(file)));
  const name = path.basename(file);
  const build = /\b([0-9a-f]{7})\)$/.exec(String(trip.info.ver_sw ?? ""))?.[1] ?? null;
  const loop = (typeof trip.info.nav_mapmatch_loop === "string" ? trip.info.nav_mapmatch_loop : "open") as MapMatchLoop;
  const base = { file: name, build, loop, storage: 0, compared: 0, p50: NaN, p90: NaN, max: NaN, worstS: NaN };
  if (!trip.navEstimate.length) return { ...base, error: "no dot in the log (older than nav_estimate)" };
  const calibration = new CalibrationStore(new MemoryKeyValueStore(), phoneOf(trip));
  const storage = seedFromLog(trip, calibration);
  const first = trip.gnss.find((f) => f.hAccM <= 500);
  const graphFile = first ? findGraph(first) : null;
  const opened = graphFile && first ? openGraph(graphFile, first) : null;
  try {
    const r = replayTripInApp(trip, {
      calibration,
      loop,
      roadGraph: opened ? { key: graphFile!, region: path.basename(graphFile!, ".graph.bin"), graph: opened.graph } : null,
    });
    const replay = estimateTrack(r.published.map((p) => ({ ...p, tUs: p.timestampUs })), trip.startUs);
    const phone = estimateTrack(trip.navEstimate, trip.startUs);
    const gaps: { t: number; m: number }[] = [];
    for (const p of phone) {
      const q = trackAt(replay, p.t);
      if (q) gaps.push({ t: p.t, m: haversineM(p, q) });
    }
    const sorted = gaps.map((g) => g.m).sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN;
    const worst = gaps.reduce((w, g) => (g.m > w.m ? g : w), { t: NaN, m: -1 });
    return { ...base, storage, compared: gaps.length, p50: at(0.5), p90: at(0.9), max: sorted.at(-1) ?? NaN, worstS: worst.t };
  } finally {
    opened?.close();
  }
}

/** Commits touching the navigation code since `build` (null: unknown build, or not in this repository). */
function navCommitsSince(build: string): number | null {
  try {
    return Number(execFileSync("git", ["rev-list", "--count", `${build}..HEAD`, "--", ...NAV_PATHS], { encoding: "utf8" }).trim());
  } catch {
    return null;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const threads = threadsArg(argv);
  const files = argv.filter((a) => a.endsWith(".ulg"));
  const pool = new Pool(import.meta.url, threads);
  let rows: Row[];
  try {
    rows = await pool.map<string, Row>(files);
  } finally {
    await pool.close();
  }
  let suspect = 0;
  console.log(`${"drive".padEnd(34)} ${"build".padEnd(8)} nav commits since  storage  loop     dot vs phone: p50   p90   max (at)`);
  for (const r of rows) {
    if (r.error) {
      console.log(`${r.file.padEnd(34)} ${r.error}`);
      continue;
    }
    if (!r.compared) {
      console.log(`${r.file.padEnd(34)} nothing to compare (the dot never shown at the same time)`);
      continue;
    }
    const since = r.build ? navCommitsSince(r.build) : null;
    const same = since === 0;
    const flag = same && r.p90 > SAME_CODE_P90_M;
    if (flag) suspect++;
    console.log(
      `${r.file.padEnd(34)} ${(r.build ?? "—").padEnd(8)} ${String(since ?? "?").padStart(17)}  ${String(r.storage).padStart(7)}  ${r.loop.padEnd(7)}` +
        `  ${r.p50.toFixed(1).padStart(16)} ${r.p90.toFixed(1).padStart(5)} ${r.max.toFixed(0).padStart(5)} (${r.worstS.toFixed(0)} s)` +
        (flag ? "  <- same code, different dot: the replay doesn't reproduce the app" : r.storage ? "" : "  (no storage notes: the start may differ)"),
    );
  }
  console.log(suspect ? `\n${suspect} log(s) with unchanged navigation code don't reproduce` : "\nno log with unchanged navigation code differs");
  if (suspect) process.exitCode = 1;
}

serveJobs(import.meta.url, compare);
if (isMainThread) await main();
