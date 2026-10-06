// Spoofing benchmark (SPEC §3.3, §7 target 7): on every clean drive, 60 s windows of simulated spoofing
// (src/nav/replay/spoof.ts) on a fixed grid, one kind at a time. Per kind: is the first spoofed fix refused, how
// many spoofed fixes the navigator used, how long trust takes to come back after the window, how far off the dot
// was when real GPS returned, and any real fix refused (false refusals) or untrusted time outside the windows.
// Controls: `cut` withholds GPS in the same windows (the first fix after a gap mustn't be refused), `jam+static`
// jams for 60 s before a static spoof (the spoof then arrives after a gap).
//
//   npm run replay:spoof -- tools/triplog/logs/*.ulg [--nav '<json>'] [--any-start] [--threads N] [--verbose]
//
// `--any-start` also spoofs windows before the EKF knows the heading (the navigator anchored).

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import type { NavConfig } from "../../src/nav/navigator";
import { replayTrip, type ReplayOptions } from "../../src/nav/replay/replay";
import type { SpoofWindow } from "../../src/nav/replay/spoof";
import { isSatelliteFix } from "../../src/nav/types";
import { readTripLog, type TripLog } from "../../src/triplog/trip-log-reader";
import { isMainThread, Pool, serveJobs, threadsArg } from "./pool";

const WINDOW_S = 60;
const EVERY_S = 120;
const FIRST_S = 90;
/** Replay this long past a window: trust should be back by then. */
const AFTER_S = 90;
/** Drives with fewer satellite fixes are not clean enough to spoof. */
const MIN_SATELLITE_FIXES = 200;

const KINDS: { name: string; spoof?: Omit<SpoofWindow, "fromS" | "toS">; cut?: boolean; jamBeforeS?: number }[] = [
  { name: "cut (control)", cut: true },
  { name: "static 5 km", spoof: { kind: "static", distanceM: 5000 } },
  { name: "static 300 m", spoof: { kind: "static", distanceM: 300 } },
  { name: "outside", spoof: { kind: "outside" } },
  { name: "offset 1 km", spoof: { kind: "offset", distanceM: 1000 } },
  { name: "offset 150 m", spoof: { kind: "offset", distanceM: 150 } },
  { name: "jam+static 5 km", spoof: { kind: "static", distanceM: 5000 }, jamBeforeS: 60 },
  // Within the car's reach after the jam: only the dead reckoning (then the shape) can tell.
  { name: "jam+static 300 m", spoof: { kind: "static", distanceM: 300 }, jamBeforeS: 60 },
];

type Job =
  | { plan: true; file: string; nav?: Partial<NavConfig>; anyStart: boolean }
  | { plan?: false; file: string; kind: number; fromS: number; nav?: Partial<NavConfig> };

interface Result {
  file: string;
  kind: number;
  fromS: number;
  spoofed: number;
  firstRefused: boolean | null;
  firstVerdict: string | null;
  spoofedUsed: number;
  /** From the window's end to trust shown again (null: not within `AFTER_S`). */
  recoveryS: number | null;
  /** The first real satellite fix after the window: the dot's distance from it before the update. */
  errorAfterM: number | null;
  realRefused: number;
  realRefusedAt: string[];
  falseAlarmS: number;
}

let cached: { file: string; trip: TripLog } | null = null;
function load(file: string): TripLog {
  if (cached?.file !== file) cached = { file, trip: readTripLog(new Uint8Array(readFileSync(file))) };
  return cached.trip;
}

/**
 * Window starts on a fixed grid of log time, from `FIRST_S` and 30 s after the EKF knows the heading (spoofing a
 * navigator that is still anchored is another test), where satellite fixes cover ≥ 80 % of the window.
 */
function windows(trip: TripLog, initS: number | null, anyStart: boolean): number[] {
  const sats = trip.gnss.filter(isSatelliteFix);
  if (sats.length < MIN_SATELLITE_FIXES || (initS === null && !anyStart)) return [];
  const tS = sats.map((f) => (f.tUs - trip.startUs) / 1e6);
  const endS = tS.at(-1)!;
  const out: number[] = [];
  for (let from = FIRST_S; from + WINDOW_S + AFTER_S <= endS; from += EVERY_S) {
    const covered = tS.filter((t) => t >= from && t < from + WINDOW_S).length;
    if ((anyStart || from >= initS! + 30) && covered >= 0.8 * WINDOW_S) out.push(from);
  }
  return out;
}

function runJob(job: Job): Result | number[] {
  const trip = load(job.file);
  if (job.plan) return windows(trip, replayTrip(trip, { nav: job.nav }).summary.init?.tS ?? null, job.anyStart);
  const k = KINDS[job.kind];
  const toS = job.fromS + WINDOW_S;
  const options: ReplayOptions = { nav: job.nav, untilS: toS + AFTER_S };
  if (k.cut) options.cuts = [{ fromS: job.fromS, toS }];
  if (k.spoof) options.spoof = [{ ...k.spoof, fromS: job.fromS, toS }];
  if (k.jamBeforeS) options.jam = [{ fromS: job.fromS - k.jamBeforeS, toS: job.fromS }];
  const r = replayTrip(trip, options);
  const i = r.summary.integrity;
  const spoofed = r.fixes.filter((f) => f.spoofed);
  const first = spoofed[0];
  const back = r.track.find((p) => p.tS >= toS && p.trust === "TRUSTED");
  const after = r.fixes.find((f) => f.satellite && !f.spoofed && f.status !== "cut" && f.tS >= toS && f.errorM !== undefined);
  return {
    file: job.file,
    kind: job.kind,
    fromS: job.fromS,
    spoofed: spoofed.length,
    firstRefused: first ? first.status === "untrusted" : null,
    firstVerdict: first ? (first.integrity ?? first.status) : null,
    spoofedUsed: i.spoofedUsed,
    recoveryS: back ? back.tS - toS : null,
    errorAfterM: after?.errorM ?? null,
    realRefused: i.realRefused,
    realRefusedAt: i.realRefusedAt.map((x) => `${x.tS.toFixed(0)} s ${x.verdict}${x.detail ? ` (${x.detail})` : ""}`),
    falseAlarmS: i.falseAlarmS,
  };
}

const pct = (v: number[], q: number) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const f0 = (v: number | null) => (v === null ? "—" : v.toFixed(0));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const threads = threadsArg(argv);
  let nav: Partial<NavConfig> | undefined;
  let verbose = false;
  let anyStart = false;
  const files: string[] = [];
  for (let a = 0; a < argv.length; a++) {
    if (argv[a] === "--nav") nav = JSON.parse(argv[++a]);
    else if (argv[a] === "--verbose") verbose = true;
    else if (argv[a] === "--any-start") anyStart = true;
    else files.push(argv[a]);
  }
  if (!files.length) throw new Error("usage: replay:spoof <trip.ulg...> [--nav '<json>'] [--any-start] [--threads N] [--verbose]");

  const pool = new Pool(import.meta.url, threads);
  let results: Result[];
  try {
    const plans = await pool.map<Job, number[]>(files.map((file) => ({ plan: true, file, nav, anyStart })));
    const jobs: Job[] = [];
    files.forEach((file, i) => {
      for (let kind = 0; kind < KINDS.length; kind++) for (const fromS of plans[i]) jobs.push({ file, kind, fromS, nav });
    });
    results = await pool.map<Job, Result>(jobs);
  } finally {
    await pool.close();
  }

  const drives = new Set(results.map((r) => r.file)).size;
  console.log(`${drives} clean drives, ${WINDOW_S} s windows every ${EVERY_S} s from ${FIRST_S} s`);
  // The same window cut: how far off the dot would be without any GPS, to tell what the spoof added.
  const control = new Map(results.filter((r) => KINDS[r.kind].cut).map((r) => [`${r.file}@${r.fromS}`, r.errorAfterM]));
  for (let kind = 0; kind < KINDS.length; kind++) {
    const rs = results.filter((r) => r.kind === kind);
    if (!rs.length) continue;
    const spoofing = rs.filter((r) => r.spoofed > 0);
    const recovery = rs.map((r) => r.recoveryS).filter((v): v is number => v !== null);
    const errors = rs.map((r) => r.errorAfterM).filter((v): v is number => v !== null);
    const added = rs
      .map((r) => {
        const c = control.get(`${r.file}@${r.fromS}`);
        return r.errorAfterM === null || c === null || c === undefined ? null : r.errorAfterM - c;
      })
      .filter((v): v is number => v !== null);
    const spoofed = spoofing.reduce((s, r) => s + r.spoofed, 0);
    const used = spoofing.reduce((s, r) => s + r.spoofedUsed, 0);
    const parts = [
      `${rs.length} windows`,
      ...(spoofing.length
        ? [
            `first fix refused ${spoofing.filter((r) => r.firstRefused).length}/${spoofing.length}`,
            `spoofed fixes used ${used}/${spoofed} (in ${spoofing.filter((r) => r.spoofedUsed > 0).length} windows)`,
          ]
        : []),
      `trust back after p50 ${f0(pct(recovery, 0.5))} / max ${f0(recovery.length ? Math.max(...recovery) : null)} s (never: ${rs.length - recovery.length})`,
      `dot off at GPS return p50 ${f0(pct(errors, 0.5))} / p90 ${f0(pct(errors, 0.9))} / max ${f0(errors.length ? Math.max(...errors) : null)} m`,
      ...(KINDS[kind].cut ? [] : [`more than cut p90 ${f0(pct(added, 0.9))} / max ${f0(added.length ? Math.max(...added) : null)} m`]),
      `real fixes refused ${rs.reduce((s, r) => s + r.realRefused, 0)}`,
      `false alarm ${f0(rs.reduce((s, r) => s + r.falseAlarmS, 0))} s`,
    ];
    console.log(`${KINDS[kind].name.padEnd(16)} ${parts.join(", ")}`);
    const verdicts = new Map<string, number>();
    for (const r of spoofing) if (r.firstVerdict) verdicts.set(r.firstVerdict, (verdicts.get(r.firstVerdict) ?? 0) + 1);
    if (verdicts.size) console.log(`${"".padEnd(16)} first spoofed fix: ${[...verdicts].map(([v, n]) => `${v} ${n}`).join(", ")}`);
    for (const r of rs) {
      const bad = r.realRefused > 0 || r.spoofedUsed > 0 || r.recoveryS === null || r.firstRefused === false;
      if (!verbose && !bad) continue;
      console.log(
        `  ${basename(r.file)} @${r.fromS}: spoofed ${r.spoofed}, used ${r.spoofedUsed}, first ${r.firstVerdict ?? "—"}, back ${f0(r.recoveryS)} s, off ${f0(r.errorAfterM)} m` +
          (r.realRefusedAt.length ? `, refused real: ${r.realRefusedAt.join("; ")}` : ""),
      );
    }
  }
}

serveJobs(import.meta.url, runJob);
if (isMainThread) await main();
