// Two measures of the failure of MAPMATCH-SPEC §15, item 14, on the real logs:
//   - off-road while driving at road speed, which no yard sees (§7.4) — the app's symptom, the dot in a field
//     beside the road at 130 km/h;
//   - after a turn, how long the filter takes to put the car on the road it turned onto — the same failure as it
//     shows in a replay, where the filter keeps to the road it was on instead of leaving it.
// Usage: npm run replay:offroad -- [--mm '<json>'] [--speed <kph>] [--turn <tS>] [--want <wayId,…>] <trip.ulg...>

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import type { MapMatchConfig } from "../../src/nav/mapmatch/particle-filter";
import type { NavConfig } from "../../src/nav/navigator";
import { replayTrip } from "../../src/nav/replay/replay";
import { isSatelliteFix } from "../../src/nav/types";
import { readTripLog } from "../../src/triplog/trip-log-reader";
import { findGraph, openGraph } from "./graph-file";

function parseArgs(argv: string[]) {
  const files: string[] = [];
  let config: Partial<MapMatchConfig> = {};
  // `replayTrip` starts from the app's settings (nav/app-defaults.ts); this is only for overriding one.
  let nav: Partial<NavConfig> = {};
  let speedKph = 40;
  let turnS: number | undefined;
  let want: number[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mm") config = JSON.parse(argv[++i]) as Partial<MapMatchConfig>;
    else if (a === "--nav") nav = { ...nav, ...(JSON.parse(argv[++i]) as Partial<NavConfig>) };
    else if (a === "--speed") speedKph = Number(argv[++i]);
    else if (a === "--turn") turnS = Number(argv[++i]);
    else if (a === "--want") want = argv[++i].split(",").map(Number);
    else if (a === "-h" || a === "--help") {
      console.log("replay:offroad [--mm '<json>'] [--nav '<json>'] [--speed <kph>] [--turn <tS>] [--want <wayId,…>] <trip.ulg...>");
      process.exit(0);
    } else files.push(a);
  }
  if (!files.length) throw new Error("no trip log given (see --help)");
  return { files, config, nav, speedKph, turnS, want };
}

const { files, config, nav, speedKph, turnS, want } = parseArgs(process.argv.slice(2));
const minMps = speedKph / 3.6;

let totalFast = 0;
let totalOff = 0;
let worst = 0;
console.log(`${"trip".padEnd(8)} ${"fast".padStart(6)} ${"off-road".padStart(9)} ${"share".padStart(7)} ${"longest".padStart(8)}${turnS === undefined ? "" : "  after the turn"}`);
for (const file of files) {
  const trip = readTripLog(new Uint8Array(readFileSync(file)));
  const first = trip.gnss.find((f) => isSatelliteFix(f) && f.hAccM <= 10) ?? trip.gnss.find((f) => f.hAccM < 500);
  if (!first) {
    console.log(`${basename(file).slice(-10, -4).padEnd(8)}  no usable fixes`);
    continue;
  }
  const graphFile = findGraph(first);
  if (!graphFile) {
    console.log(`${basename(file).slice(-10, -4).padEnd(8)}  no graph`);
    continue;
  }
  const g = openGraph(graphFile, first);
  const r = replayTrip(trip, { nav, mapMatch: { graph: g.graph, config } });

  // Off-road while moving at road speed, and the longest run of it.
  let fast = 0;
  let off = 0;
  let run = 0;
  let longest = 0;
  let lastS: number | null = null;
  for (const p of r.track) {
    const dt = lastS === null ? 0 : p.tS - lastS;
    lastS = p.tS;
    if ((p.speedMps ?? 0) < minMps) {
      run = 0;
      continue;
    }
    fast++;
    if (p.mapMatch?.state === "offroad") {
      off++;
      run += dt;
      longest = Math.max(longest, run);
    } else run = 0;
  }
  totalFast += fast;
  totalOff += off;
  worst = Math.max(worst, longest);

  // After a turn: when does the dominant hypothesis first sit on one of `want`, and stay there?
  let afterTurn = "";
  if (turnS !== undefined && want.length) {
    const wayOf = (edge: number | null) => (edge === null ? null : g.graph.edge(edge).wayId);
    const rows = r.track.filter((p) => p.tS >= turnS);
    let settledAt: number | null = null;
    for (let i = 0; i < rows.length; i++) {
      const w = wayOf(rows[i].mapMatch?.clusters[0]?.edge ?? null);
      if (w === null || !want.includes(w)) {
        settledAt = null;
        continue;
      }
      if (settledAt === null) settledAt = rows[i].tS;
      // Settled = on a wanted way for 5 s running.
      if (rows[i].tS - settledAt >= 5) break;
    }
    afterTurn = settledAt === null ? "  never settles" : `  settles ${(settledAt - turnS).toFixed(0)} s after the turn`;
  }
  console.log(
    `${basename(file).slice(-10, -4).padEnd(8)} ${String(fast).padStart(6)} ${String(off).padStart(9)} ` +
      `${(fast ? ((100 * off) / fast).toFixed(1) : "—").padStart(6)}% ${longest.toFixed(0).padStart(7)}s${afterTurn}`,
  );
  g.close();
}
console.log(
  `\ntotal: off-road ${totalOff} of ${totalFast} samples above ${speedKph} km/h ` +
    `(${totalFast ? ((100 * totalOff) / totalFast).toFixed(2) : "—"} %), longest run ${worst.toFixed(0)} s`,
);
