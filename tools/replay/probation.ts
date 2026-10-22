// CAN probation (VEHICLE-LINK-SPEC §16.5) on recorded drives: the app's check of a car's profile against its OBD speed
// (src/nav/odometry/can/probation.ts), fed the log's decoded CAN speed and its OBD polls in time order. Only stretches
// where both were recorded count: a log made with CAN primary has OBD speed only while standing.
//
//   npm run replay:probation -- tools/triplog/logs/*.ulg
//   npm run replay:probation -- trip.ulg --profile mazda/mazda/mazda_2017     # force a profile
import { readFileSync } from "node:fs";
import path from "node:path";

import { navigatorSpeeds } from "../../src/nav/odometry/can/can-speed";
import { SpeedProbation, type ProbationStats } from "../../src/nav/odometry/can/probation";
import { decodeTripCan } from "../../src/nav/replay/can";
import { readTripLog } from "../../src/triplog/trip-log-reader";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const profileKey = opt("profile");
const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--profile");
if (!files.length) {
  console.error("usage: npm run replay:probation -- <logs> [--profile make/mapping/dbc]");
  process.exit(1);
}

const f = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "-");
const describe = (s: ProbationStats) =>
  `scale ${f(s.scale)} spread ${f(s.spread)} r ${f(s.correlation, 4)} range ${f(s.rangeKph, 0)} km/h, ` +
  `${s.scalePairs} pairs, standing ${s.standPairs} (${f(s.standShare, 2)} ok), wheel off ${s.wheelOff === null ? "-" : f(s.wheelOff)}`;

for (const file of files) {
  const name = path.basename(file);
  let trip;
  try {
    trip = readTripLog(new Uint8Array(readFileSync(file)));
  } catch (e) {
    console.log(`${name}: unreadable (${(e as Error).message})`);
    continue;
  }
  const can = decodeTripCan(trip, profileKey);
  if (!can?.profile) continue;
  const speeds = navigatorSpeeds(can.samples, can.profile);
  const obd = trip.obdSpeed.filter((s) => s.source !== "can");
  const check = new SpeedProbation();
  let i = 0;
  let verdictS: number | null = null;
  for (const s of speeds) {
    while (i < obd.length && obd[i].tUs <= s.tUs) {
      check.addObd(obd[i].tUs, obd[i].rawKph);
      i++;
    }
    check.addCan(s);
    if (check.verdict && verdictS === null) verdictS = (s.tUs - trip.startUs) / 1e6;
  }
  const v = check.verdict;
  const head = `${name} ${can.profile.key}`;
  if (!v) console.log(`${head}: no verdict — ${describe(check.stats())}`);
  else console.log(`${head}: ${v.pass ? "PASS" : `FAIL (${v.reason})`} at ${f(verdictS!, 0)} s — ${describe(v.stats)}`);
}
