// CAN shadow logs decoded through the car's profile (SPEC §2.1), checked against what the app already trusts: wheel
// speeds and CAN speed vs OBD `010D` and satellite GNSS speed, the gear while driving, steering and brake ranges, and
// how much of the drive the monitor heard. A wrong unit or factor in a mapping shows as a ratio away from 1.
//
//   npm run replay:can -- tools/triplog/logs/*.ulg
//   npm run replay:can -- trip.ulg --profile toyota/toyota/toyota_nodsu_pt_generated     # force a profile
import { readFileSync } from "node:fs";
import path from "node:path";

import type { CarStateSample } from "../../src/nav/odometry/can/car-state";
import { OPENDBC_COMMIT } from "../../src/nav/odometry/can/profile";
import { decodeTripCan } from "../../src/nav/replay/can";
import { isSatelliteFix } from "../../src/nav/types";
import { readTripLog, type TripLog } from "../../src/triplog/trip-log-reader";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const profileKey = opt("profile");
const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--profile");
if (!files.length) {
  console.error("usage: npm run replay:can -- <logs> [--profile make/mapping/dbc]");
  process.exit(1);
}

/** CAN frames carry the arrival time of their chunk (50–100 ms batches): pair samples only this close. */
const PAIR_US = 150_000;
const MIN_KPH = 5;

const hex = (id: number) => `0x${id.toString(16).toUpperCase().padStart(3, "0")}`;
const pct = (x: number) => `${(100 * x).toFixed(0)} %`;
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
};

/** The sample nearest to `tUs` within PAIR_US (samples sorted by time). */
function nearest<T extends { tUs: number }>(xs: T[], tUs: number): T | null {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid].tUs < tUs) lo = mid + 1;
    else hi = mid;
  }
  let best: T | null = null;
  for (const i of [lo - 1, lo]) {
    const x = xs[i];
    if (x && Math.abs(x.tUs - tUs) <= PAIR_US && (!best || Math.abs(x.tUs - tUs) < Math.abs(best.tUs - tUs))) best = x;
  }
  return best;
}

/** CAN speed (km/h) against a reference (km/h): pairs above MIN_KPH. */
function compare(label: string, can: { tUs: number; kph: number }[], ref: { tUs: number; kph: number }[]): string {
  let sumCan = 0;
  let sumRef = 0;
  const diffs: number[] = [];
  for (const r of ref) {
    if (r.kph < MIN_KPH) continue;
    const c = nearest(can, r.tUs);
    if (!c) continue;
    sumCan += c.kph;
    sumRef += r.kph;
    diffs.push(c.kph - r.kph);
  }
  if (!diffs.length) return `  ${label}: no pairs above ${MIN_KPH} km/h`;
  return (
    `  ${label}: ratio ${(sumCan / sumRef).toFixed(3)}, difference median ${quantile(diffs, 0.5).toFixed(2)} km/h, ` +
    `|p90| ${quantile(diffs.map(Math.abs), 0.9).toFixed(2)} km/h (${diffs.length} pairs)`
  );
}

function gearRuns(gears: Extract<CarStateSample, { q: "gear" }>[], startUs: number): string[] {
  const runs: { gear: string; from: number; to: number }[] = [];
  for (const g of gears) {
    const name = g.gear ?? `?${g.raw}`;
    const last = runs.at(-1);
    if (last && last.gear === name && g.tUs - last.to < 5_000_000) last.to = g.tUs;
    else runs.push({ gear: name, from: g.tUs, to: g.tUs });
  }
  return runs.map((r) => `${r.gear} ${((r.from - startUs) / 1e6).toFixed(0)}–${((r.to - startUs) / 1e6).toFixed(0)} s`);
}

function report(file: string, trip: TripLog) {
  const can = decodeTripCan(trip, profileKey);
  if (!can) return;
  console.log(`== ${path.basename(file)}  ${trip.info.adapter_name ?? ""} ${trip.info.adapter_chip ?? ""}`.trimEnd());
  const windows = trip.canWindows ?? [];
  const listenUs = windows.reduce((n, w) => n + (w.endUs - w.startUs), 0);
  const spanUs = windows.length ? windows.at(-1)!.endUs - windows[0].startUs : 0;
  console.log(
    `  ${trip.can!.length} frames, ${windows.length} windows, listening ${pct(listenUs / Math.max(1, spanUs))} of ` +
      `${(spanUs / 60e6).toFixed(1)} min` +
      (can.listened ? `; ids asked: ${[...can.listened].map(hex).join(" ")}` : ""),
  );
  const ws = windows.filter((w) => w.bytes !== undefined);
  if (ws.length) {
    const stops = ws.map((w) => w.stopMs).filter((s): s is number => s != null);
    const retried = ws.filter((w) => w.stopRetried).length;
    const other = ws.reduce((n, w) => n + (w.other ?? 0), 0);
    const long = ws.filter((w) => w.endUs - w.startUs >= 200_000);
    const kbs = long.map((w) => w.bytes! / ((w.endUs - w.startUs) / 1e6) / 1024);
    const ways = new Map<string, number>();
    for (const w of ws) ways.set(w.reopen ?? "open", (ways.get(w.reopen ?? "open") ?? 0) + 1);
    console.log(
      `  stops: median ${quantile(stops, 0.5).toFixed(0)} ms, p90 ${quantile(stops, 0.9).toFixed(0)} ms, the first stop character timed out in ${retried} of ${ws.length}; ` +
        `${other} frames of other ids; ${long.length ? `${quantile(kbs, 0.5).toFixed(1)} KB/s median in windows of 0.2 s and more` : "no window of 0.2 s"}; ` +
        `filter opened by ${[...ways].map(([k, n]) => `${k} ${n}`).join(", ")}`,
    );
  }
  for (const m of trip.messages.filter((x) => /^(can-shadow: (filter test|off|set up|.*answered|.*opens by)|frozen|reinit|reopen|link-lost)/.test(x.text)).slice(0, 14)) {
    console.log(`  ${((m.tUs - trip.startUs) / 1e6).toFixed(0).padStart(5)} s  ${m.text.slice(0, 220)}`);
  }
  for (const m of can.matches.slice(0, 3)) {
    console.log(`  profile ${m.profile.key}: ${m.seen}/${m.heard} ids${m.speed ? "" : ", no speed message"}`);
  }
  const p = can.profile;
  if (!p) {
    console.log("  no profile fits");
    return;
  }
  if (profileKey) console.log(`  using ${p.key}`);

  for (const [id, s] of [...can.seen].sort((a, b) => a[0] - b[0])) {
    const def = p.ids.get(id);
    const rate = listenUs ? s.frames / (listenUs / 1e6) : 0;
    const lenNote = def && def.size !== s.len ? `, ${s.len} bytes (DBC ${def.size})` : "";
    console.log(`  ${hex(id)} ${def?.msg ?? "(not in profile)"}: ${s.frames} frames, ${rate.toFixed(1)}/s heard${lenNote}`);
  }

  const by = <Q extends CarStateSample["q"]>(q: Q) => can.samples.filter((s): s is Extract<CarStateSample, { q: Q }> => s.q === q);
  const wheels = by("wheels").map((s) => ({ tUs: s.tUs, kph: (3.6 * (s.v[0] + s.v[1] + s.v[2] + s.v[3])) / 4, v: s.v }));
  const rear = wheels.map((w) => ({ tUs: w.tUs, kph: (3.6 * (w.v[2] + w.v[3])) / 2 }));
  const speed = by("speed").map((s) => ({ tUs: s.tUs, kph: 3.6 * s.v }));
  const obd = trip.obdSpeed.map((s) => ({ tUs: s.rxUs ?? s.tUs, kph: s.rawKph }));
  const gnss = trip.gnss.filter(isSatelliteFix).map((g) => ({ tUs: g.tUs, kph: 3.6 * g.speedMps! }));

  console.log(`  vs OBD 010D (${obd.length} samples) and satellite GNSS speed (${gnss.length} fixes), above ${MIN_KPH} km/h:`);
  if (wheels.length) {
    console.log(compare("wheels mean / 010D", wheels, obd));
    console.log(compare("rear wheels / 010D", rear, obd));
    console.log(compare("wheels mean / GNSS", wheels, gnss));
    const fronts = wheels.filter((w) => w.kph > 20);
    if (fronts.length) {
      const lr = quantile(fronts.map((w) => (w.v[2] - w.v[3]) / ((w.v[2] + w.v[3]) / 2)), 0.5);
      const fr = quantile(fronts.map((w) => (w.v[0] + w.v[1]) / (w.v[2] + w.v[3])), 0.5);
      console.log(`  wheels above 20 km/h: front/rear median ${fr.toFixed(4)}, rear left−right median ${(100 * lr).toFixed(2)} %`);
    }
  }
  if (speed.length) {
    console.log(compare("CAN speed / 010D", speed, obd));
    console.log(compare("CAN speed / GNSS", speed, gnss));
  }

  const gears = by("gear");
  if (gears.length) {
    const counts = new Map<string, number>();
    for (const g of gears) counts.set(g.gear ?? `?${g.raw}`, (counts.get(g.gear ?? `?${g.raw}`) ?? 0) + 1);
    console.log(`  gear samples: ${[...counts].map(([g, n]) => `${g} ${n}`).join(", ")}`);
    console.log(`  gear runs: ${gearRuns(gears, trip.startUs).join(", ")}`);
    // Moving in P or N would be a wrong value table.
    const moving = gears.filter((g) => (g.gear === "P" || g.gear === "N") && (nearest(obd, g.tUs)?.kph ?? 0) > MIN_KPH);
    if (moving.length) console.log(`  ! ${moving.length} gear samples read P/N above ${MIN_KPH} km/h`);
  }
  const steer = by("steer").map((s) => s.deg);
  if (steer.length) {
    console.log(`  steering: ${steer.length} samples, ${Math.min(...steer).toFixed(0)}…${Math.max(...steer).toFixed(0)}°, median ${quantile(steer, 0.5).toFixed(1)}°`);
  }
  const brake = by("brake");
  if (brake.length) {
    let presses = 0;
    let last = false;
    for (const b of brake) {
      if (b.on && !last) presses++;
      last = b.on;
    }
    console.log(`  brake: on in ${pct(brake.filter((b) => b.on).length / brake.length)} of samples, ${presses} presses heard`);
  }
  const yaw = by("yaw").map((s) => s.radps);
  if (yaw.length) console.log(`  yaw rate: ${yaw.length} samples, |p90| ${quantile(yaw.map(Math.abs), 0.9).toFixed(3)} rad/s`);
}

console.log(`profiles from opendbc ${OPENDBC_COMMIT.slice(0, 10)}`);
for (const file of files) {
  const trip = readTripLog(new Uint8Array(readFileSync(file)));
  if (trip.can?.length) report(file, trip);
}
