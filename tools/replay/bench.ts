// Outage benchmark: replays every log with simulated GNSS outages at fixed windows and
// aggregates the held-out error, so navigator changes can be compared on the same drives.
//
//   npm run replay:bench -- tools/triplog/logs/*.ulg
//   npm run replay:bench -- tools/triplog/logs/*.ulg --nav '{"ekf":{"initYawScaleSigma":0}}'

import { readFileSync } from "node:fs";
import path from "node:path";

import type { NavConfig } from "../../src/nav/navigator";
import { replayTrip, type CutResult } from "../../src/nav/replay/replay";
import { readTripLog } from "../../src/triplog/trip-log-reader";

const DURATIONS_S = [60, 120, 240];
const STEP_S = 30;
/** A window counts when held-out satellite fixes cover most of it (clean GNSS). */
const MIN_TRUTH_SHARE = 0.8;
/** And the car actually drives in it. */
const MIN_DISTANCE_M = 200;

function parseArgs(argv: string[]) {
  const files: string[] = [];
  let nav: Partial<NavConfig> = {};
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--nav") nav = JSON.parse(argv[++i]) as Partial<NavConfig>;
    else if (argv[i] === "--verbose") verbose = true;
    else files.push(argv[i]);
  }
  return { files, nav, verbose };
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const pct = (v: number[], p: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};

function main() {
  const { files, nav, verbose } = parseArgs(process.argv.slice(2));
  const byDuration = new Map<number, (CutResult & { file: string })[]>(DURATIONS_S.map((d) => [d, []]));

  for (const file of files) {
    const trip = readTripLog(new Uint8Array(readFileSync(file)));
    const base = replayTrip(trip, { nav });
    if (!base.summary.init) continue;
    const from = Math.ceil(base.summary.init.tS + 10);
    for (const d of DURATIONS_S) {
      for (let t = from; t + d <= base.summary.durationS; t += STEP_S) {
        const cut = replayTrip(trip, { nav, cuts: [{ fromS: t, toS: t + d }] }).summary.cuts[0];
        if (cut.truthFixes < MIN_TRUTH_SHARE * d || cut.distanceM < MIN_DISTANCE_M || cut.maxErrorM === null) continue;
        byDuration.get(d)!.push({ ...cut, file: path.basename(file) });
        if (verbose) {
          console.log(
            `  ${path.basename(file)} ${t}+${d}s ${(cut.distanceM / 1000).toFixed(2)} km: max ${cut.maxErrorM.toFixed(0)} m, end ${cut.lastErrorM!.toFixed(0)} m, σ ${cut.meanSigmaM!.toFixed(0)} m`,
          );
        }
      }
    }
  }

  console.log("outage  windows  km/win   max err: median  p90   end err: median  p90   err per km  err/σ");
  for (const [d, cuts] of byDuration) {
    if (!cuts.length) continue;
    const max = cuts.map((c) => c.maxErrorM!);
    const end = cuts.map((c) => c.lastErrorM!);
    const perKm = cuts.map((c) => c.lastErrorM! / (c.distanceM / 1000));
    const ratio = cuts.map((c) => c.maxErrorM! / Math.max(1, c.meanSigmaM!));
    console.log(
      `${String(d).padStart(4)} s  ${String(cuts.length).padStart(7)}  ${median(cuts.map((c) => c.distanceM / 1000)).toFixed(2).padStart(6)}` +
        `   ${median(max).toFixed(1).padStart(13)} ${pct(max, 0.9).toFixed(1).padStart(5)}` +
        `   ${median(end).toFixed(1).padStart(13)} ${pct(end, 0.9).toFixed(1).padStart(5)}` +
        `   ${median(perKm).toFixed(1).padStart(10)} ${median(ratio).toFixed(2).padStart(6)}`,
    );
  }
}

main();
