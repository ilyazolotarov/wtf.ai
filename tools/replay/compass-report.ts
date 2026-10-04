// The compass in shadow (NAVIGATOR-SPEC §7.6): what the app logged about it, per drive and overall.
// It decides whether the compass may be switched on: how often a stored calibration was rejected, and
// how far the compass was off when the heading became known.
//
//   npm run replay:compass -- tools/triplog/logs/*.ulg

import { readFileSync } from "node:fs";
import path from "node:path";

import { readTripLog } from "../../src/triplog/trip-log-reader";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!files.length) {
  console.error("usage: npm run replay:compass -- <logs>");
  process.exit(1);
}

const starts: number[] = [];
const verdicts = { confirmed: 0, rejected: 0 };
for (const file of files) {
  const trip = readTripLog(new Uint8Array(readFileSync(file)));
  const notes = trip.messages.filter((m) => m.text.startsWith("nav compass"));
  if (!notes.length) continue;
  console.log(`== ${path.basename(file)}`);
  for (const m of notes) {
    console.log(`  ${((m.tUs - trip.startUs) / 1e6).toFixed(0).padStart(5)} s  ${m.text}`);
    const off = /^nav compass at start: (-?[\d.]+)° off/.exec(m.text);
    if (off) starts.push(Math.abs(Number(off[1])));
    // Only a stored calibration is judged: `unverified → …`.
    if (m.text.startsWith("nav compass unverified → confirmed")) verdicts.confirmed++;
    if (m.text.startsWith("nav compass unverified → rejected")) verdicts.rejected++;
  }
}

const sorted = [...starts].sort((a, b) => a - b);
const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
console.log(
  `\nstored calibrations: confirmed ${verdicts.confirmed}, rejected ${verdicts.rejected}` +
    `\ncompass at the start: ${sorted.length} starts` +
    (sorted.length ? `, off median ${at(0.5).toFixed(0)}°, p90 ${at(0.9).toFixed(0)}°, max ${sorted.at(-1)!.toFixed(0)}°, > 45°: ${sorted.filter((v) => v > 45).length}` : ""),
);
