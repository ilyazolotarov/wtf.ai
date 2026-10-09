// Phone-only speed (src/nav/odometry/imu/imu-speed.ts) against OBD speed, per drive. OBD is only the answer key here.
//
//   npm run replay:imuspeed -- [--gnss] [--reverse] [--cfg '{"qSpeed":0.02}'] [logs…]
//
// --gnss also feeds satellite GNSS speed (the phone-only app when not jammed); without it, jammed all drive.
// --reverse lists every stretch the estimate drove backwards.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { ImuSpeedEstimator, type ImuSpeedConfig, type PhoneMount } from "../../src/nav/odometry/imu/imu-speed";
import { isSatelliteFix } from "../../src/nav/types";
import { readTripLog, type TripLog } from "../../src/triplog/trip-log-reader";

const LOGS = path.resolve(import.meta.dirname, "../triplog/logs");
const argv = process.argv.slice(2);
const flag = (f: string) => argv.includes(f);
const value = (f: string) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const useGnss = flag("--gnss");
const listReverse = flag("--reverse");
// --chain: each drive starts with the phone mount the previous drive of the same car left (as the app would store it).
const chain = flag("--chain");
const mounts = new Map<string, PhoneMount>();
const cfg = JSON.parse(value("--cfg") ?? "{}") as Partial<ImuSpeedConfig>;
const named = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--cfg");
const files = named.length ? named : readdirSync(LOGS).filter((f) => f.endsWith(".ulg")).sort().map((f) => path.join(LOGS, f));

const OBD_STALE_US = 2_500_000;
const KPH = 3.6;
const BANDS = [0, 30, 60, 90, Infinity];
const WINDOW_M = 500;

const pct = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const f0 = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : "–");
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "–");

/** OBD speed at t (linear between samples), undefined when stale. */
function obdAt(trip: TripLog, cursor: { i: number }, tUs: number): number | undefined {
  const o = trip.obdSpeed;
  while (cursor.i + 1 < o.length && o[cursor.i + 1].tUs <= tUs) cursor.i++;
  const a = o[cursor.i];
  const b = o[cursor.i + 1];
  if (!a || a.tUs > tUs) return undefined;
  if (!b || b.tUs - a.tUs > OBD_STALE_US) return tUs - a.tUs < OBD_STALE_US ? a.speedMps : undefined;
  return a.speedMps + ((b.speedMps - a.speedMps) * (tUs - a.tUs)) / (b.tUs - a.tUs);
}

interface Row {
  name: string;
  min: number;
  km: number;
  lockS: number;
  storedMount: boolean;
  covered: number;
  medKph: number;
  p90Kph: number;
  band: number[];
  distPct: number;
  winMedPct: number;
  winP90Pct: number;
  falseStopS: number;
  stopRecall: number;
  reverseS: number;
  turnMed: number;
  turnP10: number;
  turnP90: number;
}

const all = { err: [] as number[], band: BANDS.slice(1).map(() => [] as number[]), win: [] as number[], km: 0, imuKm: 0 };

function run(file: string): Row | null {
  const trip = readTripLog(new Uint8Array(readFileSync(file)));
  if (!trip.imu.length || !trip.obdSpeed.length) return null;
  const car = String(trip.info.vehicle_vin ?? trip.info.obd_protocol ?? "car");
  const est = new ImuSpeedEstimator(cfg, {}, chain ? (mounts.get(car) ?? null) : null);
  const cursor = { i: 0 };
  const gnss = trip.gnss.filter(isSatelliteFix);
  let gi = 0;

  let lockUs: number | null = null;
  let lastT: number | null = null;
  let obdM = 0;
  let imuM = 0;
  let movingS = 0;
  let coveredS = 0;
  let falseStopS = 0;
  let zeroS = 0;
  let zeroStoppedS = 0;
  let reverseS = 0;
  const err: number[] = [];
  const band = BANDS.slice(1).map(() => [] as number[]);
  const win: number[] = [];
  let winObd = 0;
  let winImu = 0;
  let rev: { from: number; m: number; obdM: number } | null = null;
  const reverses: string[] = [];
  const turnRatio: number[] = [];

  for (const s of trip.imu) {
    while (useGnss && gi < gnss.length && gnss[gi].tUs <= s.tUs) {
      const g = gnss[gi++];
      est.updateSpeed(g.speedMps!, Math.max(0.3, g.speedAccMps ?? 1));
    }
    const o = est.process(s);
    const dt = lastT === null ? 0 : Math.min(0.1, (s.tUs - lastT) / 1e6);
    lastT = s.tUs;
    if (o.axisLocked && lockUs === null) lockUs = s.tUs;
    const obd = obdAt(trip, cursor, s.tUs);
    if (obd === undefined) {
      continue;
    }
    if (o.turnSpeedMps !== undefined && obd * KPH >= 10) turnRatio.push(o.turnSpeedMps / obd);
    const v = Number.isFinite(o.speedMps) ? o.speedMps : 0;
    obdM += obd * dt;
    imuM += Math.abs(v) * dt;
    winObd += obd * dt;
    winImu += Math.abs(v) * dt;
    if (winObd >= WINDOW_M) {
      win.push((100 * Math.abs(winImu - winObd)) / winObd);
      winObd = winImu = 0;
    }
    if (obd * KPH >= 5) {
      movingS += dt;
      if (Number.isFinite(o.speedMps)) {
        coveredS += dt;
        const e = Math.abs(v - obd) * KPH;
        err.push(e);
        const bi = BANDS.findIndex((b, i) => obd * KPH >= b && obd * KPH < BANDS[i + 1]);
        band[bi].push(e);
      }
      if (o.stopped && obd * KPH >= 10) falseStopS += dt;
    }
    if (obd === 0) {
      zeroS += dt;
      if (o.stopped) zeroStoppedS += dt;
    }
    if (o.direction === -1) {
      reverseS += dt;
      rev ??= { from: s.tUs, m: 0, obdM: 0 };
      rev.m += Math.abs(v) * dt;
      rev.obdM += obd * dt;
    } else if (rev) {
      if (listReverse && rev.m >= 1)
        reverses.push(`    reverse at ${f0((rev.from - trip.startUs) / 1e6)} s for ${f1((s.tUs - rev.from) / 1e6)} s: ${f1(rev.m)} m (OBD saw ${f1(rev.obdM)} m)`);
      rev = null;
    }
  }

  const learned = est.mount;
  if (learned) mounts.set(car, learned);

  for (const r of reverses) console.log(`${path.basename(file)}\n${r}`);
  for (const e of err) all.err.push(e);
  band.forEach((b, i) => {
    for (const e of b) all.band[i].push(e);
  });
  for (const e of win) all.win.push(e);
  all.km += obdM / 1000;
  all.imuKm += imuM / 1000;
  return {
    name: path.basename(file).replace(/\.ulg$/, "").slice(-6),
    min: (trip.imu[trip.imu.length - 1].tUs - trip.imu[0].tUs) / 60e6,
    km: obdM / 1000,
    lockS: lockUs === null ? NaN : (lockUs - trip.imu[0].tUs) / 1e6,
    storedMount: est.usedStoredMount,
    covered: movingS > 0 ? (100 * coveredS) / movingS : NaN,
    medKph: pct(err, 0.5),
    p90Kph: pct(err, 0.9),
    band: band.map((b) => pct(b, 0.5)),
    distPct: obdM > 0 ? (100 * (imuM - obdM)) / obdM : NaN,
    winMedPct: pct(win, 0.5),
    winP90Pct: pct(win, 0.9),
    falseStopS,
    stopRecall: zeroS > 0 ? (100 * zeroStoppedS) / zeroS : NaN,
    reverseS,
    turnMed: pct(turnRatio, 0.5),
    turnP10: pct(turnRatio, 0.1),
    turnP90: pct(turnRatio, 0.9),
  };
}

const header = [
  "drive ",
  "  min",
  "   km",
  "lock s",
  "mount",
  "cov%",
  "err med",
  "p90",
  "<30",
  "30-60",
  "60-90",
  ">90",
  "dist%",
  "500m med%",
  "p90%",
  "falseStop s",
  "stop%",
  "rev s",
  "turn v/obd p10/med/p90",
];
console.log(`speed errors in km/h (median unless p90); 500m = along-track error per 500 m driven${useGnss ? "; GNSS speed on" : "; jammed: IMU only"}`);
console.log(header.join(" "));
for (const file of files) {
  const r = run(file);
  if (!r || r.km < 0.3) continue;
  console.log(
    [
      r.name.padEnd(6),
      f1(r.min).padStart(5),
      f1(r.km).padStart(5),
      f0(r.lockS).padStart(6),
      (r.storedMount ? "kept" : "new").padStart(5),
      f0(r.covered).padStart(4),
      f1(r.medKph).padStart(7),
      f1(r.p90Kph).padStart(3),
      ...r.band.map((b, i) => f1(b).padStart(header[9 + i].length)),
      f0(r.distPct).padStart(5),
      f0(r.winMedPct).padStart(9),
      f0(r.winP90Pct).padStart(4),
      f0(r.falseStopS).padStart(11),
      f0(r.stopRecall).padStart(5),
      f0(r.reverseS).padStart(5),
      `${r.turnP10.toFixed(2)}/${r.turnMed.toFixed(2)}/${r.turnP90.toFixed(2)}`,
    ].join(" "),
  );
}
console.log(
  `\nall: ${f1(all.km)} km by OBD, ${f1(all.imuKm)} km by IMU; speed error median ${f1(pct(all.err, 0.5))} km/h, p90 ${f1(pct(all.err, 0.9))}; ` +
    `by band ${all.band.map((b, i) => `${BANDS[i]}+: ${f1(pct(b, 0.5))}`).join(", ")}; per 500 m median ${f0(pct(all.win, 0.5))} %, p90 ${f0(pct(all.win, 0.9))} %`,
);
