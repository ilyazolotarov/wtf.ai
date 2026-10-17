// The phone's IMU in a simulated car, as measured on the real drives (NAVIGATOR-SPEC §9.8): the phone sits tilted in a
// holder, the car pitches and rolls on the road's slope and camber and on its own suspension, the holder shakes, the
// gyro drifts, and CoreMotion splits the specific force into a gravity that leans with long accelerations and a
// user acceleration. The car's own motion (speed, yaw rate) comes from the simulator; this adds everything a phone
// adds to it. Pure TS, seeded.

import type { ImuSample, Vec3 } from "../types";

/** RMS per octave band (Hz edges `VIBRATION_OCTAVES_HZ`), by speed band (`VIBRATION_SPEEDS_KPH`). */
type OctaveTable = readonly (readonly number[])[];

/** Octave band edges, Hz. */
export const VIBRATION_OCTAVES_HZ = [0.2, 0.5, 1, 2, 4, 8, 16, 32, 50] as const;
/** The speed each table row was measured at (band centres: standing, < 10, 10–30, 30–50, 50–70, 70+ km/h). */
export const VIBRATION_SPEEDS_KPH = [0, 5, 20, 40, 60, 80] as const;

export interface PhoneImuModelConfig {
  /** The holder tilts the phone's screen back from vertical (deg: mean, σ), turns it towards the driver (± deg), and
   *  the phone sits a little rotated in it (σ deg). */
  mountTiltDeg: [number, number];
  mountYawDeg: number;
  mountRollDeg: number;
  /** How far ahead of the point the car turns about (the rear axle) the phone sits, m (mean, σ): a turn's yaw
   *  acceleration then pushes it sideways (L · dω/dt) and the turn pulls it back (−L · ω²). */
  leverM: [number, number];
  /** Road slope (σ, as a grade) and camber/bank (σ, deg), each correlated over this many metres. */
  slopeSigma: number;
  slopeCorrelationM: number;
  bankSigmaDeg: number;
  bankCorrelationM: number;
  /** Body pitch per m/s² along the car (nose up accelerating), roll per m/s² sideways (outwards), deg; suspension lag, s. */
  pitchPerMS2Deg: number;
  rollPerMS2Deg: number;
  suspensionTauS: number;
  /** Vibration in the car frame (fwd, left, up) by speed: accelerometer m/s², gyro °/s (RMS per octave). */
  accelVibration: readonly [OctaveTable, OctaveTable, OctaveTable];
  gyroVibration: readonly [OctaveTable, OctaveTable, OctaveTable];
  /** A car's and road's shake against the table: per drive (lognormal σ of the factor) and along the road (σ, m). */
  vibrationDriveSigma: number;
  roughnessSigma: number;
  roughnessCorrelationM: number;
  /** Gyro: bias per axis at the start (σ °/s), drifting (σ °/s, correlation s); scale on every axis. */
  gyroBiasDegS: number;
  gyroDriftDegS: number;
  gyroDriftTauS: number;
  gyroScale: number;
  /** Accelerometer bias per axis, σ m/s². */
  accelBiasMS2: number;
  /** CoreMotion's gravity: a complementary filter of the gyro and the specific force with this time constant. */
  gravityTauS: number;
}

/**
 * Measured on the test iPhone (one holder, two cars) over 63 drives, 2026-10-17: mount tilt from the stops' vertical;
 * slope, bank, body pitch and roll from the specific force against OBD speed and v · ω; vibration as Welch spectra
 * (5.1 s, Hann, detrended) of the car-frame axes, the median segment's power by speed band (the mean is the
 * phone being touched). Bands below 1 Hz while moving hold the car's own motion, which the simulator drives
 * itself: there the standing row is used. A turn's speed (∫a_lat / ∫ω) puts the phone ~0.7 m ahead of the point the
 * car turns about. CoreMotion's gravity fits a
 * 20 s complementary filter (0.9° RMS while moving). The gyro carried from one stop's vertical to the next was
 * 0.9° off at the median (2° p90) after 1–4 min: the drift, not the bias at stops (~0.01 °/s).
 */
export const MEASURED_PHONE_IMU: PhoneImuModelConfig = {
  mountTiltDeg: [20, 7],
  mountYawDeg: 25,
  mountRollDeg: 3,
  leverM: [0.7, 0.4],
  slopeSigma: 0.012,
  slopeCorrelationM: 150,
  bankSigmaDeg: 1.1,
  bankCorrelationM: 80,
  pitchPerMS2Deg: 0.25,
  rollPerMS2Deg: 0.3,
  suspensionTauS: 0.3,
  accelVibration: [
    [
      [0.001, 0.001, 0.002, 0.006, 0.004, 0.035, 0.073, 0.038],
      [0.001, 0.001, 0.091, 0.073, 0.034, 0.134, 0.132, 0.127],
      [0.001, 0.001, 0.11, 0.107, 0.085, 0.526, 0.327, 0.368],
      [0.001, 0.001, 0.095, 0.095, 0.081, 0.798, 0.598, 0.593],
      [0.001, 0.001, 0.094, 0.119, 0.083, 0.874, 0.693, 0.615],
      [0.001, 0.001, 0.129, 0.152, 0.088, 1.545, 1.017, 0.679],
    ],
    [
      [0.001, 0.001, 0.002, 0.007, 0.004, 0.013, 0.094, 0.01],
      [0.001, 0.001, 0.11, 0.108, 0.037, 0.052, 0.16, 0.04],
      [0.001, 0.001, 0.182, 0.237, 0.178, 0.247, 0.27, 0.105],
      [0.001, 0.001, 0.085, 0.144, 0.18, 0.363, 0.407, 0.178],
      [0.001, 0.001, 0.106, 0.088, 0.202, 0.339, 0.505, 0.191],
      [0.001, 0.001, 0.168, 0.132, 0.117, 0.517, 0.757, 0.202],
    ],
    [
      [0.001, 0.001, 0.001, 0.004, 0.005, 0.033, 0.039, 0.03],
      [0.001, 0.001, 0.068, 0.108, 0.045, 0.113, 0.069, 0.09],
      [0.001, 0.001, 0.16, 0.287, 0.205, 0.383, 0.163, 0.282],
      [0.001, 0.001, 0.108, 0.268, 0.223, 0.565, 0.274, 0.466],
      [0.001, 0.001, 0.157, 0.202, 0.237, 0.591, 0.306, 0.499],
      [0.001, 0.001, 0.432, 0.29, 0.173, 1.174, 0.387, 0.469],
    ],
  ],
  gyroVibration: [
    [
      [0.01, 0.01, 0.02, 0.03, 0.03, 0.1, 0.43, 0.09],
      [0.01, 0.01, 0.49, 0.32, 0.23, 0.34, 0.82, 0.27],
      [0.01, 0.01, 0.92, 0.77, 0.87, 1.36, 1.44, 0.71],
      [0.01, 0.01, 0.48, 0.59, 0.78, 2.24, 2.2, 1.27],
      [0.01, 0.01, 0.63, 0.45, 0.85, 2.43, 2.69, 1.42],
      [0.01, 0.01, 1.08, 0.66, 0.57, 3.99, 3.65, 1.29],
    ],
    [
      [0.01, 0.01, 0.02, 0.03, 0.03, 0.35, 0.77, 0.27],
      [0.01, 0.01, 0.36, 0.26, 0.14, 1.31, 1.21, 0.73],
      [0.01, 0.01, 0.86, 0.66, 0.69, 5.26, 2.24, 2.23],
      [0.01, 0.01, 0.96, 0.66, 0.77, 7.99, 3.9, 3.73],
      [0.01, 0.01, 1.05, 0.75, 0.86, 8.95, 4.96, 4],
      [0.01, 0.01, 1.58, 1.07, 0.57, 15, 7.21, 4.2],
    ],
    [
      [0.01, 0.02, 0.03, 0.05, 0.06, 0.18, 0.85, 0.1],
      [0.01, 0.02, 0.13, 0.24, 0.15, 0.5, 1.54, 0.36],
      [0.01, 0.02, 0.26, 0.47, 0.52, 2.06, 2.55, 0.95],
      [0.01, 0.02, 0.19, 0.33, 0.57, 3.05, 3.77, 1.6],
      [0.01, 0.02, 0.26, 0.29, 0.63, 3.16, 4.75, 1.9],
      [0.01, 0.02, 0.38, 0.44, 0.71, 5.18, 7.57, 2.22],
    ],
  ],
  vibrationDriveSigma: 0.25,
  roughnessSigma: 0.3,
  roughnessCorrelationM: 150,
  gyroBiasDegS: 0.01,
  gyroDriftDegS: 0.015,
  gyroDriftTauS: 300,
  gyroScale: 1.007,
  accelBiasMS2: 0.03,
  gravityTauS: 20,
};

/** What the simulated car does at this sample. */
export interface CarMotion {
  tUs: number;
  /** Speed, m/s, and its rate of change, m/s². */
  speedMps: number;
  accelMS2: number;
  /** Heading, rad clockwise from north, and yaw rate, rad/s counter-clockwise (left turn) positive. */
  headingRad: number;
  yawRateRadS: number;
  /** Distance driven so far, m (the road's slope and roughness are functions of it). */
  distanceM: number;
}

type Rng = { uniform(): number; gauss(): number };
type Mat = [Vec3, Vec3, Vec3];

const DEG = Math.PI / 180;
const G = 9.80665;

const mul = (m: Mat, v: Vec3): Vec3 => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];
const mulT = (m: Mat, v: Vec3): Vec3 => [
  m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
  m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
  m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
];
const v3 = (f: (i: number) => number): Vec3 => [f(0), f(1), f(2)];
const matMul = (a: Mat, b: Mat): Mat => [
  v3((j) => a[0][0] * b[0][j] + a[0][1] * b[1][j] + a[0][2] * b[2][j]),
  v3((j) => a[1][0] * b[0][j] + a[1][1] * b[1][j] + a[1][2] * b[2][j]),
  v3((j) => a[2][0] * b[0][j] + a[2][1] * b[1][j] + a[2][2] * b[2][j]),
];
const transpose = (m: Mat): Mat => [v3((i) => m[i][0]), v3((i) => m[i][1]), v3((i) => m[i][2])];
const rotZ = (a: number): Mat => [
  [Math.cos(a), -Math.sin(a), 0],
  [Math.sin(a), Math.cos(a), 0],
  [0, 0, 1],
];
const rotY = (a: number): Mat => [
  [Math.cos(a), 0, Math.sin(a)],
  [0, 1, 0],
  [-Math.sin(a), 0, Math.cos(a)],
];
const rotX = (a: number): Mat => [
  [1, 0, 0],
  [0, Math.cos(a), -Math.sin(a)],
  [0, Math.sin(a), Math.cos(a)],
];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const n = Math.hypot(a[0], a[1], a[2]);
  return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 1];
};

/** An Ornstein–Uhlenbeck process stepped by a distance or a time, with stationary σ. */
class Ou {
  value: number;
  constructor(
    private readonly sigma: number,
    private readonly correlation: number,
    private readonly rng: Rng,
  ) {
    this.value = sigma * rng.gauss();
  }
  step(by: number): number {
    if (by <= 0 || this.sigma === 0) return this.value;
    const k = Math.exp(-by / this.correlation);
    this.value = k * this.value + Math.sqrt(1 - k * k) * this.sigma * this.rng.gauss();
    return this.value;
  }
}

/** White noise through an RBJ band-pass biquad, scaled to unit RMS. */
class BandNoise {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private readonly b0: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  private readonly gain: number;
  constructor(loHz: number, hiHz: number, rateHz: number, private readonly rng: Rng) {
    const f0 = Math.sqrt(loHz * hiHz);
    const q = f0 / (hiHz - loHz);
    const w = (2 * Math.PI * f0) / rateHz;
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b2 = -alpha / a0;
    this.a1 = (-2 * Math.cos(w)) / a0;
    this.a2 = (1 - alpha) / a0;
    // Output variance for unit white input: Σ h[n]² of the impulse response.
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, energy = 0;
    for (let n = 0; n < 20000; n++) {
      const x = n === 0 ? 1 : 0;
      const y = this.b0 * x + this.b2 * x2 - this.a1 * y1 - this.a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      energy += y * y;
    }
    this.gain = energy > 0 ? 1 / Math.sqrt(energy) : 0;
  }
  next(): number {
    const x = this.rng.gauss();
    const y = this.b0 * x + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y * this.gain;
  }
}

/** RMS of each octave at a speed, interpolated between the table's rows. */
function octavesAt(table: OctaveTable, kph: number): readonly number[] {
  const s = VIBRATION_SPEEDS_KPH;
  if (kph <= s[0]) return table[0];
  // Standing (row 0) only at a standstill: the slowest moving row from the first km/h.
  if (kph < 1) return table[0].map((a, k) => a + (table[1][k] - a) * kph);
  for (let i = 1; i + 1 < s.length; i++) {
    if (kph <= s[i + 1]) {
      const f = Math.max(0, (kph - s[i]) / (s[i + 1] - s[i]));
      return table[i].map((a, k) => a + (table[i + 1][k] - a) * f);
    }
  }
  return table[s.length - 1];
}

/** One simulated phone in one car: call `sample` at the IMU rate, in time order. */
export class PhoneImuModel {
  private readonly c: PhoneImuModelConfig;
  /** Phone axes in the car frame (columns: the phone's x, y, z). */
  private readonly mount: Mat;
  private readonly slope: Ou;
  private readonly bank: Ou;
  private readonly roughness: Ou;
  private readonly driveShake: number;
  private readonly gyroBias: Vec3;
  private readonly drift: [Ou, Ou, Ou];
  private readonly accelBias: Vec3;
  /** Per car axis, per octave. */
  private readonly accelBands: BandNoise[][];
  private readonly gyroBands: BandNoise[][];
  private readonly octaves: number;
  private readonly lever: number;
  private lastYawRate: number | null = null;
  private yawAccel = 0;
  private bodyPitch = 0;
  private bodyRoll = 0;
  private lastDistanceM: number | null = null;
  private lastTUs: number | null = null;
  /** The car's attitude at the last sample (car axes in the world, ENU). */
  private lastAttitude: Mat | null = null;
  /** CoreMotion's "up" in the phone frame. */
  private up: Vec3 | null = null;

  constructor(
    private readonly rng: Rng,
    private readonly rateHz: number,
    config: Partial<PhoneImuModelConfig> = {},
  ) {
    const c = (this.c = { ...MEASURED_PHONE_IMU, ...config });
    // The holder: screen to the driver (phone z = car backwards), top up, tilted back, turned and rotated a little.
    const tilt = (c.mountTiltDeg[0] + c.mountTiltDeg[1] * rng.gauss()) * DEG;
    const zp: Vec3 = [-Math.cos(tilt), 0, Math.sin(tilt)];
    const yp: Vec3 = [Math.sin(tilt), 0, Math.cos(tilt)];
    const xp = cross(yp, zp);
    const holder: Mat = [
      [xp[0], yp[0], zp[0]],
      [xp[1], yp[1], zp[1]],
      [xp[2], yp[2], zp[2]],
    ];
    this.mount = matMul(matMul(rotZ((2 * rng.uniform() - 1) * c.mountYawDeg * DEG), holder), rotZ(c.mountRollDeg * DEG * rng.gauss()));
    this.lever = Math.max(0, c.leverM[0] + c.leverM[1] * rng.gauss());
    this.slope = new Ou(Math.atan(c.slopeSigma), c.slopeCorrelationM, rng);
    this.bank = new Ou(c.bankSigmaDeg * DEG, c.bankCorrelationM, rng);
    this.roughness = new Ou(c.roughnessSigma, c.roughnessCorrelationM, rng);
    this.driveShake = Math.exp(c.vibrationDriveSigma * rng.gauss());
    this.gyroBias = v3(() => c.gyroBiasDegS * DEG * rng.gauss());
    this.drift = [0, 1, 2].map(() => new Ou(c.gyroDriftDegS * DEG, c.gyroDriftTauS, rng)) as [Ou, Ou, Ou];
    this.accelBias = v3(() => c.accelBiasMS2 * rng.gauss());
    // Octaves the IMU rate can carry.
    const edges = VIBRATION_OCTAVES_HZ;
    let octaves = 0;
    while (octaves + 1 < edges.length && Math.sqrt(edges[octaves] * edges[octaves + 1]) < 0.45 * rateHz) octaves++;
    this.octaves = octaves;
    const bands = () => Array.from({ length: octaves }, (_, k) => new BandNoise(edges[k], Math.min(edges[k + 1], 0.49 * rateHz), rateHz, rng));
    this.accelBands = [bands(), bands(), bands()];
    this.gyroBands = [bands(), bands(), bands()];
  }

  /** The car's axes (x forward, y left, z up) in the world (x east, y north, z up). */
  private attitude(headingRad: number, pitch: number, roll: number): Mat {
    return matMul(matMul(rotZ(Math.PI / 2 - headingRad), rotY(-pitch)), rotX(roll));
  }

  sample(car: CarMotion): ImuSample {
    const c = this.c;
    const dt = this.lastTUs === null ? 0 : (car.tUs - this.lastTUs) / 1e6;
    this.lastTUs = car.tUs;
    const ds = this.lastDistanceM === null ? 0 : Math.max(0, car.distanceM - this.lastDistanceM);
    this.lastDistanceM = car.distanceM;

    // The road under the car, and the body on its springs (nose up accelerating, rolling out of a turn).
    const slope = this.slope.step(ds);
    const bank = this.bank.step(ds);
    const lateral = car.speedMps * car.yawRateRadS;
    const k = dt > 0 ? 1 - Math.exp(-dt / c.suspensionTauS) : 1;
    this.bodyPitch += (c.pitchPerMS2Deg * DEG * car.accelMS2 - this.bodyPitch) * k;
    // Roll positive = left side up: a left turn (lateral > 0) throws the body to the right.
    this.bodyRoll += (c.rollPerMS2Deg * DEG * lateral - this.bodyRoll) * k;
    const att = this.attitude(car.headingRad, slope + this.bodyPitch, bank + this.bodyRoll);

    // Rotation rate of the car in its own frame, from the attitude's change (exactly what the gyro must integrate to).
    let omega: Vec3 = [0, 0, car.yawRateRadS];
    if (this.lastAttitude && dt > 0) {
      const d = matMul(transpose(this.lastAttitude), att);
      omega = [(d[2][1] - d[1][2]) / (2 * dt), (d[0][2] - d[2][0]) / (2 * dt), (d[1][0] - d[0][1]) / (2 * dt)];
    }
    this.lastAttitude = att;

    // Specific force (what an accelerometer measures: acceleration minus gravity), in the car frame.
    const fwd: Vec3 = [att[0][0], att[1][0], att[2][0]];
    const leftH = unit([-Math.cos(car.headingRad), Math.sin(car.headingRad), 0]);
    const aWorld: Vec3 = [
      car.accelMS2 * fwd[0] + lateral * leftH[0],
      car.accelMS2 * fwd[1] + lateral * leftH[1],
      car.accelMS2 * fwd[2] + G,
    ];
    const fFrame = mulT(att, aWorld);
    // The phone ahead of the turning point: the yaw acceleration's sideways push, the turn's pull back.
    // (The simulator steers in 10 ms steps: its yaw acceleration is smoothed over 0.2 s, as a car's body would.)
    if (this.lastYawRate !== null && dt > 0) this.yawAccel += ((car.yawRateRadS - this.lastYawRate) / dt - this.yawAccel) * Math.min(1, dt / 0.2);
    this.lastYawRate = car.yawRateRadS;
    const fCar: Vec3 = [fFrame[0] - this.lever * car.yawRateRadS * car.yawRateRadS, fFrame[1] + this.lever * this.yawAccel, fFrame[2]];

    // The holder's shake, in the car frame, scaled by this car and this stretch of road.
    const kph = car.speedMps * 3.6;
    const shake = car.speedMps > 0.3 ? this.driveShake * Math.exp(this.roughness.step(ds) - (c.roughnessSigma * c.roughnessSigma) / 2) : this.driveShake;
    const vib = (bands: BandNoise[][], tables: readonly OctaveTable[], scale: number): Vec3 =>
      v3((axis) => {
        const rms = octavesAt(tables[axis], kph);
        let sum = 0;
        for (let o = 0; o < this.octaves; o++) sum += rms[o] * bands[axis][o].next();
        return sum * scale * shake;
      });
    const accelVib = vib(this.accelBands, c.accelVibration, 1);
    const gyroVib = vib(this.gyroBands, c.gyroVibration, DEG);

    // Into the phone's frame, with the sensors' errors.
    const fPhone = mulT(this.mount, [fCar[0] + accelVib[0], fCar[1] + accelVib[1], fCar[2] + accelVib[2]]);
    const wPhone = mulT(this.mount, [omega[0] + gyroVib[0], omega[1] + gyroVib[1], omega[2] + gyroVib[2]]);
    const gyro = v3((i) => wPhone[i] * c.gyroScale + this.gyroBias[i] + this.drift[i].step(dt));
    const force = v3((i) => fPhone[i] + this.accelBias[i]);

    // CoreMotion: its vertical carried by the gyro, levelled to the specific force; gravity points down along it.
    if (this.up === null) this.up = unit(force);
    else {
      const u = this.up;
      const w = cross(gyro, u);
      const a = Math.min(1, dt / c.gravityTauS);
      const meas = unit(force);
      this.up = unit([u[0] - w[0] * dt + (meas[0] - u[0]) * a, u[1] - w[1] * dt + (meas[1] - u[1]) * a, u[2] - w[2] * dt + (meas[2] - u[2]) * a]);
    }
    const gravity: Vec3 = [-G * this.up[0], -G * this.up[1], -G * this.up[2]];
    // The log's convention: gravity + user acceleration = −specific force (at rest: gravity, pointing down).
    return { tUs: car.tUs, gyro, gravity, userAccel: [-force[0] - gravity[0], -force[1] - gravity[1], -force[2] - gravity[2]] };
  }

  /** Where the car's up is in the phone frame (for tests). */
  get mountUp(): Vec3 {
    return mulT(this.mount, [0, 0, 1]);
  }

  /** Car-frame vector to phone frame (for tests). */
  toPhone(v: Vec3): Vec3 {
    return mulT(this.mount, v);
  }

  /** Phone-frame vector to car frame (for tests). */
  toCar(v: Vec3): Vec3 {
    return mul(this.mount, v);
  }
}
