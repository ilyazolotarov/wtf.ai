// When the voice said "turn now" against when the car turned (ROUTING-SPEC §8.5). The turn is taken from the phone's
// gyro (vertical yaw rate), so it doesn't depend on where the navigator put the car: a turn the driver followed is a
// heading change of over 45° within 5 s, in the direction said, starting 3 s before to 12 s after the call. Its start
// is where the yaw rate first rose above 5°/s; its middle, the sharpest yaw rate. "Dot at junction": when the app's
// own position reached the maneuver (its guidance moved on, or under 3 m to go).
//
//   npm run replay:voice -- tools/triplog/logs/*.ulg
import { readFileSync } from "node:fs";
import path from "node:path";

import { nowDistanceM } from "../../src/nav/routing/announcer";
import type { ManeuverKind } from "../../src/nav/routing/maneuvers";
import { readTripLog } from "../../src/triplog/trip-log-reader";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!files.length) {
  console.error("usage: npm run replay:voice -- <logs>");
  process.exit(1);
}

const NOW = /^voice say now-(left|right|sharp-left|sharp-right|slight-left|slight-right)\b/;
const TURN_DEG = 45;
const ONSET_DEG_S = 5;

const median = (xs: number[]) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : NaN;
};
const signed = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;

const rows: { v: number; atM: number; onset: number; sharpest: number; dot: number; newOnset: number }[] = [];
for (const file of files) {
  const trip = readTripLog(new Uint8Array(readFileSync(file)));
  const says = trip.messages.filter((m) => NOW.test(m.text));
  if (!says.length) continue;
  // Vertical yaw rate, °/s: positive turning right (gyro · gravity, gravity pointing down).
  const yaw = trip.imu.map((s) => {
    const g = s.gravity;
    const n = Math.hypot(g[0], g[1], g[2]) || 1;
    return { tUs: s.tUs, w: (((s.gyro[0] * g[0] + s.gyro[1] * g[1] + s.gyro[2] * g[2]) / n) * 180) / Math.PI };
  });
  const index = (tUs: number) => {
    let lo = 0;
    let hi = yaw.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (yaw[mid].tUs < tUs) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  console.log(`== ${path.basename(file)}`);
  for (const m of says) {
    const kind = NOW.exec(m.text)![1] as ManeuverKind;
    const right = kind.endsWith("right");
    const i0 = index(m.tUs - 3e6);
    const i1 = index(m.tUs + 12e6);
    let onset: number | null = null;
    let sharpest = 0;
    for (let i = i0; i < i1 && onset === null; i += 5) {
      const j = index(yaw[i].tUs + 5e6);
      let turned = 0;
      for (let k = i + 1; k <= j && k < yaw.length; k++) turned += (yaw[k].w * (yaw[k].tUs - yaw[k - 1].tUs)) / 1e6;
      if (Math.abs(turned) <= TURN_DEG || turned > 0 !== right) continue;
      let s = i;
      while (s > i0 && Math.abs(yaw[s].w) > ONSET_DEG_S) s--;
      onset = yaw[s].tUs;
      let peak = i;
      for (let k = i; k <= j && k < yaw.length; k++) if (Math.abs(yaw[k].w) > Math.abs(yaw[peak].w)) peak = k;
      sharpest = yaw[peak].tUs;
    }
    const t = ((m.tUs - trip.startUs) / 1e6).toFixed(0).padStart(5);
    const v = (trip.obdSpeed.filter((o) => o.tUs <= m.tUs).at(-1)?.rawKph ?? NaN) / 3.6;
    const before = trip.navRouteProgress.filter((p) => p.tUs <= m.tUs).at(-1);
    if (onset === null || !before) {
      console.log(`  ${t} s ${kind.padEnd(12)} ${(v * 3.6).toFixed(0).padStart(3)} km/h: not taken`);
      continue;
    }
    const reached = trip.navRouteProgress.find(
      (p) => p.tUs > m.tUs && (p.planId !== before.planId || p.nextIndex !== before.nextIndex || p.toNextM < 3),
    );
    const row = {
      v,
      atM: before.toNextM,
      onset: (onset - m.tUs) / 1e6,
      sharpest: (sharpest - m.tUs) / 1e6,
      dot: reached ? (reached.tUs - m.tUs) / 1e6 : NaN,
      // The current rule says it this much further out; at the speed then (an upper bound: the driver brakes later).
      newOnset: NaN,
    };
    row.newOnset = row.onset + (v > 0 ? Math.max(0, nowDistanceM(kind, v) - row.atM) / v : 0);
    rows.push(row);
    console.log(
      `  ${t} s ${kind.padEnd(12)} ${(v * 3.6).toFixed(0).padStart(3)} km/h, ${row.atM.toFixed(0).padStart(3)} m before: ` +
        `turning starts ${signed(row.onset)} s, sharpest ${signed(row.sharpest)} s, dot at junction ${Number.isFinite(row.dot) ? signed(row.dot) : "?"} s` +
        ` (now: ${nowDistanceM(kind, v).toFixed(0)} m, turning ${signed(row.newOnset)} s)`,
    );
  }
}
console.log(
  `\n${rows.length} turns followed. Median: said ${median(rows.map((r) => r.atM)).toFixed(0)} m before at ` +
    `${(median(rows.map((r) => r.v)) * 3.6).toFixed(0)} km/h; turning starts ${signed(median(rows.map((r) => r.onset)))} s, ` +
    `sharpest ${signed(median(rows.map((r) => r.sharpest)))} s; dot at junction ${signed(median(rows.map((r) => r.dot)))} s. ` +
    `With the current rule, turning would start ${signed(median(rows.map((r) => r.newOnset)))} s after the call.`,
);
