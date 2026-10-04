// Long simulated city drives on a real road graph (MAPMATCH-SPEC §9.4): a random route over the
// graph, a car that follows it like a driver (speed by road class, slowing for turns, cutting
// corners, keeping to a lane, stopping at some junctions), and the sensors the phone would log
// (IMU, OBD speed, CoreLocation) with realistic errors. Pure TS; the ground truth is exact.
//
// It is optimistic where the world is messy: no parking, reversing, yards, unmapped roads, traffic
// jams or phone handling. It finds what goes wrong on the roads themselves over hours: grids and
// parallel streets, long straights, drift between turns.

import type { TripLog } from "../../triplog/trip-log-reader";
import type { LocalFrame } from "../geo/local-frame";
import { EdgeFlag, RoadClass } from "../mapmatch/graph/format";
import type { EdgeId, RoadGraph } from "../mapmatch/graph/road-graph";
import type { GnssFix, ImuSample, ObdSpeedSample } from "../types";

export interface CityDriveOptions {
  /** The graph to drive on, in `frame`. Use a reader of its own: the navigator moves its reader's frame. */
  graph: RoadGraph;
  frame: LocalFrame;
  /** Start near this point (frame metres). */
  start?: { e: number; n: number };
  /** Driving time after the initial stop, s. */
  durationS: number;
  seed?: number;
  /** IMU rate (the app logs 100 Hz; 50 Hz halves the cost of hour-long runs). */
  imuHz?: number;
  sensors?: Partial<SensorErrors>;
  /** Share of junctions where the car stops (lights, give way), and for how long (s). */
  stops?: { share: number; minS: number; maxS: number };
}

export interface SensorErrors {
  /** Gyro bias at the start, °/s, and its random walk, °/s per √h. */
  gyroBiasDegS: number;
  gyroBiasWalkDegSPerSqrtH: number;
  /** Gyro scale (measured 1.007 on the iPhone 13). */
  gyroScale: number;
  gyroNoiseRadS: number;
  /** OBD reads true km/h × scale + offset, rounded, 0 below `obdZeroKph` (CX-5: 1.019⁻¹, −0.23 km/h). */
  obdScale: number;
  obdOffsetKph: number;
  obdZeroKph: number;
  /** GNSS error per axis, m, and its correlation time, s. */
  gnssSigmaM: number;
  gnssCorrelationS: number;
  /** The car's line against the map's: lane offset to the right (two-way roads), m, and a slow lateral wander for
   *  OSM geometry error (σ m, correlation m). */
  laneOffsetM: [number, number];
  mapWanderSigmaM: number;
  mapWanderCorrelationM: number;
}

export const DEFAULT_SENSOR_ERRORS: SensorErrors = {
  gyroBiasDegS: 0.05,
  gyroBiasWalkDegSPerSqrtH: 0.03,
  gyroScale: 1.007,
  gyroNoiseRadS: 0.003,
  obdScale: 0.981,
  obdOffsetKph: -0.23,
  obdZeroKph: 2.5,
  gnssSigmaM: 2.5,
  gnssCorrelationS: 30,
  laneOffsetM: [1.5, 3.5],
  mapWanderSigmaM: 1.5,
  mapWanderCorrelationM: 150,
};

export interface CityTruth {
  tUs: number;
  lat: number;
  lon: number;
  /** Clockwise from north. */
  psi: number;
  speedMps: number;
  /** The route edge the car is on (for wrong-road checks). */
  edge: EdgeId;
}

export interface CityDrive {
  trip: TripLog;
  /** At 10 Hz. */
  truth: CityTruth[];
  truthAt(tUs: number): CityTruth;
  /** Route length driven, m; junctions passed; stops made. */
  distanceM: number;
  junctions: number;
  stopsMade: number;
}

const DT = 0.01;
const START_US = 1_000_000_000;
/** Standing still at the start, s: the gyro bias is learned at stops, as in a real session. */
const START_STOP_S = 20;
/** Cruise speed by road class, km/h (city). */
const CLASS_KPH = [90, 70, 55, 50, 45, 40, 30, 15, 20, 20, 30];
const MAX_LAT_ACCEL = 2.5;
const ACCEL = 1.5;
const BRAKE = 2.5;
const MAX_YAW_RATE = 0.7;
const RESAMPLE_M = 1;

function rng(seed: number) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
  return { uniform, gauss };
}

const wrap = (a: number) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
const drivable = (cls: number, flags: number) =>
  cls <= RoadClass.livingStreet && !(flags & EdgeFlag.private) && !(flags & EdgeFlag.minorService);

interface RoutePoint {
  e: number;
  n: number;
  cls: number;
  edge: EdgeId;
  oneway: boolean;
}

/** A random route over the graph, as points every ~1 m, at least `lengthM` long. */
function buildRoute(graph: RoadGraph, start: { e: number; n: number }, lengthM: number, r: ReturnType<typeof rng>) {
  const near = graph.edgesNear(start.e, start.n, 500).find((x) => drivable(x.edge.cls, x.edge.flags));
  if (!near) throw new Error("no drivable road within 500 m of the start");
  let edge = near.edge;
  // Start along the geometry unless that is against a one-way.
  let dir: 1 | -1 = edge.oneway === 2 ? -1 : edge.oneway === 1 ? 1 : r.uniform() < 0.5 ? 1 : -1;
  const pts: RoutePoint[] = [];
  const junctionAt: { index: number; turnRad: number }[] = [];
  let length = 0;
  for (let guard = 0; length < lengthM && guard < 100_000; guard++) {
    const n = edge.cum.length;
    const order = dir === 1 ? Array.from({ length: n }, (_, i) => i) : Array.from({ length: n }, (_, i) => n - 1 - i);
    for (const v of order) {
      const p = { e: edge.xy[2 * v], n: edge.xy[2 * v + 1], cls: edge.cls, edge: edge.id, oneway: edge.oneway !== 0 };
      const last = pts.at(-1);
      if (last && Math.hypot(p.e - last.e, p.n - last.n) < 0.05) continue;
      if (last) length += Math.hypot(p.e - last.e, p.n - last.n);
      pts.push(p);
    }
    const exits = graph.exits(edge.id, dir);
    const ok = exits.filter((x) => {
      const ex = graph.edge(x.edge);
      return !x.againstOneway && !x.restricted && !x.uTurn && drivable(ex.cls, ex.flags);
    });
    const choices = ok.length ? ok : exits.filter((x) => !x.againstOneway && x.uTurn);
    if (!choices.length) break;
    // Straight on more often than turning, as on a real drive; a turn somewhere every few junctions.
    const weights = choices.map((x) => (Math.abs(x.turnRad) < (25 * Math.PI) / 180 ? 3 : 1.5));
    let pick = r.uniform() * weights.reduce((a, b) => a + b, 0);
    let k = 0;
    while (k < choices.length - 1 && (pick -= weights[k]) > 0) k++;
    const next = choices[k];
    junctionAt.push({ index: pts.length - 1, turnRad: next.turnRad });
    edge = graph.edge(next.edge);
    dir = next.dir;
  }
  return { pts, junctionAt };
}

/** Resample a polyline at `step` m; keep each point's attributes from the segment it lies on. */
function resample(pts: RoutePoint[], step: number): { e: Float64Array; n: Float64Array; at: RoutePoint[]; src: Int32Array } {
  const e: number[] = [];
  const n: number[] = [];
  const at: RoutePoint[] = [];
  const src: number[] = [];
  let carry = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.hypot(b.e - a.e, b.n - a.n);
    for (let d = carry; d < len; d += step) {
      const f = d / len;
      e.push(a.e + (b.e - a.e) * f);
      n.push(a.n + (b.n - a.n) * f);
      at.push(b);
      src.push(i);
    }
    carry = (((carry - len) % step) + step) % step;
  }
  return { e: Float64Array.from(e), n: Float64Array.from(n), at, src: Int32Array.from(src) };
}

export function cityDrive(o: CityDriveOptions): CityDrive {
  const r = rng(o.seed ?? 1);
  const s = { ...DEFAULT_SENSOR_ERRORS, ...o.sensors };
  const stops = o.stops ?? { share: 0.25, minS: 5, maxS: 45 };
  const imuEvery = Math.max(1, Math.round(1 / ((o.imuHz ?? 100) * DT)));

  // The route, longer than the car can drive in the time; then the line the car aims for: the
  // road's centre line, a lane to the right on two-way roads, and a slow wander for map error.
  const route = buildRoute(o.graph, o.start ?? { e: 0, n: 0 }, o.durationS * 20 + 2000, r);
  const path = resample(route.pts, RESAMPLE_M);
  const count = path.e.length;
  const heading = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const a = Math.max(0, i - 3);
    const b = Math.min(count - 1, i + 3);
    heading[i] = Math.atan2(path.e[b] - path.e[a], path.n[b] - path.n[a]);
  }
  const offset = new Float64Array(count);
  let lane = s.laneOffsetM[0] + r.uniform() * (s.laneOffsetM[1] - s.laneOffsetM[0]);
  let wander = 0;
  const wanderK = Math.exp(-RESAMPLE_M / s.mapWanderCorrelationM);
  for (let i = 0; i < count; i++) {
    if (i > 0 && path.at[i].edge !== path.at[i - 1].edge && r.uniform() < 0.3) {
      lane = path.at[i].oneway ? (r.uniform() - 0.5) * 4 : s.laneOffsetM[0] + r.uniform() * (s.laneOffsetM[1] - s.laneOffsetM[0]);
    }
    wander = wanderK * wander + Math.sqrt(1 - wanderK * wanderK) * s.mapWanderSigmaM * r.gauss();
    offset[i] = lane + wander;
  }
  // Lane changes take ~30 m, not a step: a centred moving average.
  const prefix = new Float64Array(count + 1);
  for (let i = 0; i < count; i++) prefix[i + 1] = prefix[i] + offset[i];
  const smooth = new Float64Array(count);
  for (let i = 0, w = 15; i < count; i++) {
    const a = Math.max(0, i - w);
    const b = Math.min(count, i + w + 1);
    smooth[i] = (prefix[b] - prefix[a]) / (b - a);
  }
  const tx = new Float64Array(count);
  const ty = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    tx[i] = path.e[i] + smooth[i] * Math.cos(heading[i]);
    ty[i] = path.n[i] - smooth[i] * Math.sin(heading[i]);
  }

  // Speed limit along the path: the class's speed, and the turns ahead (lateral acceleration).
  const vmax = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const a = Math.max(0, i - 8);
    const b = Math.min(count - 1, i + 8);
    const kappa = Math.abs(wrap(heading[b] - heading[a])) / Math.max(1, b - a);
    vmax[i] = Math.min(CLASS_KPH[path.at[i].cls] / 3.6, Math.sqrt(MAX_LAT_ACCEL / Math.max(kappa, 1e-4)));
  }
  for (let i = count - 2; i >= 0; i--) vmax[i] = Math.min(vmax[i], Math.sqrt(vmax[i + 1] ** 2 + 2 * BRAKE * RESAMPLE_M));
  // Junctions on the resampled path (first point at or after the junction vertex).
  const atOrAfter = (index: number) => {
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (path.src[mid] >= index) hi = mid;
      else lo = mid + 1;
    }
    return lo < count ? lo : -1;
  };
  const junctions = route.junctionAt.map((j) => ({ k: atOrAfter(j.index), turnRad: j.turnRad })).filter((j) => j.k >= 0);
  // Stops: at turns more often than going straight.
  const stopAt = new Map<number, number>();
  for (const j of junctions) {
    const k = j.k;
    const p = Math.abs(j.turnRad) > Math.PI / 6 ? stops.share * 1.6 : stops.share * 0.6;
    if (r.uniform() < p) stopAt.set(k, stops.minS + r.uniform() * (stops.maxS - stops.minS));
  }
  const stopIdx = [...stopAt.keys()].sort((a, b) => a - b);

  // Drive: pure pursuit on the target line, speed toward the limit.
  const imu: ImuSample[] = [];
  const obdSpeed: ObdSpeedSample[] = [];
  const gnss: GnssFix[] = [];
  const truth: CityTruth[] = [];
  let x = tx[0];
  let y = ty[0];
  let psi = heading[0];
  let v = 0;
  let idx = 0;
  let nextStop = 0;
  let stoppedUntil = START_STOP_S;
  let stopsMade = 0;
  let bias = (s.gyroBiasDegS * Math.PI) / 180;
  const biasWalk = ((s.gyroBiasWalkDegSPerSqrtH * Math.PI) / 180 / 60) * Math.sqrt(DT);
  let gE = 0;
  let gN = 0;
  const gK = Math.exp(-1 / s.gnssCorrelationS);
  let distance = 0;
  let mood = 1;
  const totalS = START_STOP_S + o.durationS;
  for (let step = 0; step * DT < totalS; step++) {
    const t = step * DT;
    const tUs = START_US + Math.round(t * 1e6);
    // Progress: the nearest target point ahead of the last one.
    let best = idx;
    let bestD = Infinity;
    for (let k = idx; k < Math.min(count, idx + 60); k++) {
      const d = (tx[k] - x) ** 2 + (ty[k] - y) ** 2;
      if (d < bestD) [best, bestD] = [k, d];
    }
    idx = best;
    if (idx >= count - 50) break;
    while (nextStop < stopIdx.length && stopIdx[nextStop] < idx) nextStop++;

    // Speed: the limit, a driver's slow variation, braking for the next stop, and the stops themselves.
    mood = 0.999 * mood + 0.001 * (1 + 0.08 * r.gauss());
    let target = vmax[idx] * Math.min(1.1, Math.max(0.85, mood));
    if (nextStop < stopIdx.length) {
      const toStop = (stopIdx[nextStop] - idx) * RESAMPLE_M - 2;
      target = Math.min(target, Math.sqrt(2 * BRAKE * Math.max(0, toStop)));
      if (toStop <= 0.5 && v < 0.3 && t >= stoppedUntil) {
        stoppedUntil = t + stopAt.get(stopIdx[nextStop])!;
        nextStop++;
        stopsMade++;
      }
    }
    if (t < stoppedUntil) target = 0;
    v = target > v ? Math.min(target, v + ACCEL * DT) : Math.max(target, v - (BRAKE + 1) * DT);
    if (v < 0.05 && target === 0) v = 0;

    // Steering: pure pursuit, within yaw-rate and lateral-acceleration limits.
    let yawCw = 0;
    if (v > 0) {
      const look = Math.min(count - 1, idx + Math.round(Math.max(5, 3 + 0.8 * v) / RESAMPLE_M));
      const alpha = wrap(Math.atan2(tx[look] - x, ty[look] - y) - psi);
      const L = Math.max(1, Math.hypot(tx[look] - x, ty[look] - y));
      const kappa = (2 * Math.sin(alpha)) / L;
      const maxKappa = Math.min(MAX_YAW_RATE / v, MAX_LAT_ACCEL / (v * v));
      yawCw = v * Math.max(-maxKappa, Math.min(maxKappa, kappa));
    }
    psi = wrap(psi + yawCw * DT);
    x += v * Math.sin(psi) * DT;
    y += v * Math.cos(psi) * DT;
    distance += v * DT;

    // Sensors. Gyro: counter-clockwise positive about up, as the IMU processor expects (synthetic-drive.ts).
    bias += biasWalk * r.gauss();
    if (step % imuEvery === 0) {
      imu.push({
        tUs,
        gyro: [0, 0, -yawCw * s.gyroScale + bias + s.gyroNoiseRadS * r.gauss()],
        gravity: [0, 0, -9.80665],
        userAccel: [0.02 * r.gauss(), 0.02 * r.gauss(), 0.02 * r.gauss()],
      });
    }
    if (step % 5 === 0) {
      const kph = v * 3.6;
      const rawKph = kph < s.obdZeroKph ? 0 : Math.max(0, Math.round(kph * s.obdScale + s.obdOffsetKph));
      obdSpeed.push({ tUs, speedMps: rawKph / 3.6, rawKph });
    }
    if (step % 10 === 0) {
      const c = o.frame.toCoordinate(x, y);
      truth.push({ tUs, lat: c.lat, lon: c.lon, psi, speedMps: v, edge: path.at[idx].edge });
    }
    if (step % 100 === 0 && step > 0) {
      gE = gK * gE + Math.sqrt(1 - gK * gK) * s.gnssSigmaM * r.gauss();
      gN = gK * gN + Math.sqrt(1 - gK * gK) * s.gnssSigmaM * r.gauss();
      const c = o.frame.toCoordinate(x + gE, y + gN);
      const lagged = truth[Math.max(0, truth.length - 7)];
      gnss.push({
        tUs,
        lat: c.lat,
        lon: c.lon,
        hAccM: s.gnssSigmaM * 1.5 + r.uniform(),
        speedMps: lagged.speedMps,
        speedAccMps: 0.3,
        courseRad: lagged.speedMps > 1 ? (lagged.psi + 2 * Math.PI) % (2 * Math.PI) : undefined,
        courseAccRad: lagged.speedMps > 1 ? 0.05 : undefined,
      });
    }
  }

  const truthAt = (tUs: number): CityTruth => {
    const i = Math.min(truth.length - 1, Math.max(0, Math.round((tUs - START_US) / 1e5)));
    return truth[i];
  };
  return {
    trip: {
      startUs: START_US, info: { sim: "city-drive" }, imu, mag: [], obdSpeed, gnss, engine: [], rpm: [], events: [],
      timeSync: [], messages: [], navEstimate: [], navMapMatch: [], truncated: false,
    },
    truth,
    truthAt,
    distanceM: distance,
    junctions: junctions.filter((j) => j.k <= idx).length,
    stopsMade,
  };
}
