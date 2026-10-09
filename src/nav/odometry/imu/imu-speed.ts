// Phone-only speed along the car's axis, without OBD (experiment). The accelerometer is integrated between stops; a
// stop (quiet phone) pins the speed at zero, and a turn measures it: the sideways acceleration in a turn is v · ω.
// The car's axes in the phone frame are learned from turns: the acceleration that goes with the yaw rate points left.

import type { ImuSample, Vec3 } from "../../types";
import { ImuProcessor, type ImuConfig } from "./imu-processor";

export interface ImuSpeedConfig {
  /** Where "down" comes from: CoreMotion's gravity, which slowly takes a long acceleration for a tilt, or our own:
   *  the gyro turns it, and it levels to the measured specific force minus the car's estimated acceleration. */
  vertical: "coremotion" | "gyro";
  /** Levelling time constant of our own vertical while driving, and while stopped. */
  levelTauS: number;
  levelStopTauS: number;
  /** Also take the car's estimated acceleration along its axis out of the levelling (else only the turn's). */
  levelAlong: boolean;
  /** Averaging window for the turn measurement and the axis learning. */
  windowS: number;
  /** Yaw rate (window mean) above which a turn teaches the axis (and can end a reverse). */
  turnRateRadS: number;
  /** Yaw rate above which the sideways acceleration measures the speed: a highway curve at 120 km/h turns ~2 °/s. */
  curveRateRadS: number;
  /** σ of the sideways acceleration as a measurement of v · ω: `noise + share · |a|` (bank, tilt, lever arm). */
  curveNoiseMS2: number;
  curveShare: number;
  /** After the phone was handled, the axis is learned again only if it now sits this differently. */
  axisResetRad: number;
  /** Turning time before the axis is used. */
  axisMinTurnS: number;

  /**
   * Pulling away from a stop teaches the axis too: the car almost always leaves forwards, at 1–2 m/s². The mean
   * horizontal acceleration over the first `pullAwayS` (if above `pullAwayMinMS2`) counts as `pullAwayTurnS` of turns.
   */
  pullAwayS: number;
  pullAwayMinMS2: number;
  pullAwayTurnS: number;
  /** Agreement of the sideways direction over the turns so far (1 = every turn agreed). */
  axisMinAgreement: number;
  /** Velocity random walk (accelerometer noise, attitude errors), (m/s)²/s. */
  qSpeed: number;
  /** Acceleration bias random walk, (m/s²)²/s. */
  qBias: number;
  initBiasSigmaMS2: number;
  /** The bias is a tilt the levelling missed: more than ~1° (0.17 m/s²) is a bad update, not a tilt. */
  maxBiasMS2: number;
  zuptSigmaMps: number;
  /** A stop needs the phone quiet this long. */
  stopQuietS: number;
  /** …and its vertical vibration (RMS over the window, unfiltered) below this: a smooth road at 50 km/h is as quiet
   *  as a red light once low-passed, but still shakes the phone ≥ 0.4 m/s²; standing ~0.07 (30 drives). */
  stopVibrationMS2: number;
  /** A stop ends at once when the horizontal acceleration over `stopEndWindowS` exceeds this: the quiet test looks
   *  back a whole window, and a stop held into the pull-away pins the speed at 0 and levels the start away. */
  stopEndAccelMS2: number;
  stopEndWindowS: number;
  /**
   * A weak prior on the speed while driving (`priorAfterS` past a stop): the drift between corrections can't take it
   * to 0 or past any city speed. σ is per second of driving (an information rate); 0 switches it off.
   */
  priorSpeedMps: number;
  priorSigmaMps: number;
  priorAfterS: number;
  /** The direction is decided when the speed since the last stop first reaches this. */
  reverseStartMps: number;
  /** …within this long after the stop; later, the car is going forward. */
  reverseWindowS: number;
  /** A turn measuring this much forward speed ends a reverse: nobody reverses that fast. */
  reverseEndMps: number;
}

export const DEFAULT_IMU_SPEED_CONFIG: ImuSpeedConfig = {
  vertical: "gyro",
  levelTauS: 60,
  levelStopTauS: 1,
  levelAlong: false,
  windowS: 1,
  turnRateRadS: 0.1,
  curveRateRadS: 0.03,
  curveNoiseMS2: 1,
  curveShare: 0,
  axisResetRad: (6 * Math.PI) / 180,
  axisMinTurnS: 4,
  pullAwayS: 3,
  pullAwayMinMS2: 0.5,
  pullAwayTurnS: 2,
  axisMinAgreement: 0.5,
  qSpeed: 0.01,
  qBias: 1e-5,
  initBiasSigmaMS2: 0.1,
  maxBiasMS2: 0.1,
  zuptSigmaMps: 0.05,
  stopQuietS: 1,
  stopVibrationMS2: 0.25,
  stopEndAccelMS2: 0.2,
  stopEndWindowS: 0.25,
  priorSpeedMps: 10,
  priorSigmaMps: 0,
  priorAfterS: 10,
  reverseStartMps: 1,
  reverseWindowS: 5,
  reverseEndMps: 3,
};

/**
 * How the phone sat in the car on an earlier drive: its "up" and the car's left axis, both in the phone frame. A drive
 * that finds the phone sitting the same way starts with that axis instead of learning it from its first turns.
 */
export interface PhoneMount {
  up: Vec3;
  left: Vec3;
  agreement: number;
  turnS: number;
  /** Σ|ω||a_h| per second of turning (the scale of the learning sums). */
  absPerS: number;
}

/** A stored mount counts as this many seconds of turns at most, so the new drive's turns can overrule it. */
const MOUNT_SEED_MAX_TURN_S = 20;
/** The phone must sit still this long before it is compared with the stored mount (not while being put in). */
const MOUNT_SETTLE_S = 3;

export interface ImuSpeedOutput {
  tUs: number;
  /** m/s along the car's axis, negative in reverse; NaN until the axis is known and no turn measured it. */
  speedMps: number;
  sigmaMps: number;
  stopped: boolean;
  /** The car's forward axis in the phone frame is known. */
  axisLocked: boolean;
  /** +1 forward, −1 reverse, 0 stopped (direction since the last stop). */
  direction: -1 | 0 | 1;
  /** Speed measured by the latest turn this sample, if any. */
  turnSpeedMps?: number;
  yawRate: number;
  valid: boolean;
  /** Acceleration along the car's axis minus the learned bias, m/s² (NaN until the axis is known). */
  accelAlongMS2: number;
  /** Vertical vibration, RMS over the window, m/s²: ≥ ~0.4 while driving, ~0.07 standing (30 drives). */
  vibrationMS2: number;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3) => Math.sqrt(dot(a, a));
const unit = (a: Vec3): Vec3 => {
  const n = norm(a);
  return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
};
const horizontal = (a: Vec3, up: Vec3): Vec3 => {
  const k = dot(a, up);
  return [a[0] - k * up[0], a[1] - k * up[1], a[2] - k * up[2]];
};

/** Time-weighted box mean of a few channels. */
class BoxMean {
  private buf: { dt: number; v: number[] }[] = [];
  private sum: number[];
  private span = 0;
  constructor(
    private readonly channels: number,
    private readonly windowS: number,
  ) {
    this.sum = new Array(channels).fill(0);
  }
  push(dt: number, v: number[]): void {
    this.buf.push({ dt, v });
    this.span += dt;
    for (let i = 0; i < this.channels; i++) this.sum[i] += v[i] * dt;
    while (this.buf.length > 1 && this.span - this.buf[0].dt >= this.windowS) {
      const old = this.buf.shift()!;
      this.span -= old.dt;
      for (let i = 0; i < this.channels; i++) this.sum[i] -= old.v[i] * old.dt;
    }
  }
  get full(): boolean {
    return this.span >= this.windowS * 0.9;
  }
  mean(i: number): number {
    return this.span > 0 ? this.sum[i] / this.span : 0;
  }
  reset(): void {
    this.buf = [];
    this.span = 0;
    this.sum.fill(0);
  }
}

export class ImuSpeedEstimator {
  readonly config: ImuSpeedConfig;
  private readonly imu: ImuProcessor;
  private lastTUs: number | null = null;
  private window: BoxMean;
  /** Σ ω · a_h dt over turns (phone frame): points to the car's left. */
  private leftSum: [number, number, number] = [0, 0, 0];
  private leftAbsSum = 0;
  private turnS = 0;
  // Kalman state: speed, accelerometer bias along the axis.
  private v = 0;
  private b = 0;
  private P: [number, number, number, number];
  private known = false;
  private quietS = 0;
  private direction: -1 | 0 | 1 = 0;
  private movingS = 0;
  /** Σ horizontal acceleration · dt since the last stop ended, while within `pullAwayS`. */
  private pullSum: [number, number, number] = [0, 0, 0];
  /** Our own "up" in the phone frame (vertical "gyro"). */
  private upOwn: [number, number, number] | null = null;
  private wasStopped = false;
  /** The car's estimated horizontal acceleration (specific-force convention), from the last sample. */
  private carAccel: [number, number, number] = [0, 0, 0];
  /** How the phone sits (slow "up" while valid), to tell a bump from a re-seated phone. */
  private upRef: [number, number, number] | null = null;
  private handled = false;
  /** Vertical acceleration and its square over the window. */
  private vibration: BoxMean;
  /** Horizontal acceleration over a short window: the car pulling away. */
  private pull: BoxMean;
  /** Time the phone has sat the same way (since `upRef` was set). */
  private settledS = 0;
  private mountChecked = false;
  private seeded = false;
  private readonly stored: PhoneMount | null;

  constructor(config: Partial<ImuSpeedConfig> = {}, imuConfig: Partial<ImuConfig> = {}, stored: PhoneMount | null = null) {
    this.stored = stored;
    this.config = { ...DEFAULT_IMU_SPEED_CONFIG, ...config };
    this.imu = new ImuProcessor(imuConfig);
    this.window = new BoxMean(4, this.config.windowS);
    this.vibration = new BoxMean(2, this.config.windowS);
    this.pull = new BoxMean(3, this.config.stopEndWindowS);
    const s = this.config.initBiasSigmaMS2;
    this.P = [100, 0, 0, s * s];
  }

  /** Learned left axis (phone frame) and how consistently the turns agreed on it. */
  get axis(): { left: Vec3; agreement: number; turnS: number } {
    return { left: unit(this.leftSum), agreement: this.leftAbsSum > 0 ? norm(this.leftSum) / this.leftAbsSum : 0, turnS: this.turnS };
  }

  /** The mount learned so far, to store for the next drive (null until the axis is known). */
  get mount(): PhoneMount | null {
    if (!this.locked || this.upRef === null) return null;
    const a = this.axis;
    return { up: [...this.upRef], left: a.left, agreement: a.agreement, turnS: a.turnS, absPerS: this.leftAbsSum / a.turnS };
  }

  /** Whether this drive started from the stored mount. */
  get usedStoredMount(): boolean {
    return this.seeded;
  }

  private get locked(): boolean {
    const a = this.axis;
    return a.turnS >= this.config.axisMinTurnS && a.agreement >= this.config.axisMinAgreement;
  }

  /** Measurement z = hv · v. */
  private update(z: number, sigma: number, hv = 1): void {
    const [p00, p01, p10, p11] = this.P;
    const s = hv * hv * p00 + sigma * sigma;
    const k0 = (p00 * hv) / s;
    const k1 = (p10 * hv) / s;
    const r = z - hv * this.v;
    this.v += k0 * r;
    this.b += k1 * r;
    this.P = [(1 - k0 * hv) * p00, (1 - k0 * hv) * p01, p10 - k1 * hv * p00, p11 - k1 * hv * p01];
    const m = this.config.maxBiasMS2;
    this.b = Math.max(-m, Math.min(m, this.b));
  }

  process(s: ImuSample): ImuSpeedOutput {
    const c = this.config;
    const out = this.imu.process(s);
    const dt = this.lastTUs === null ? 0 : Math.min(0.1, Math.max(0, (s.tUs - this.lastTUs) / 1e6));
    this.lastTUs = s.tUs;

    const gNorm = norm(s.gravity);
    const upCm: Vec3 = gNorm > 0 ? [-s.gravity[0] / gNorm, -s.gravity[1] / gNorm, -s.gravity[2] / gNorm] : [0, 0, 1];
    let up = upCm;
    let h: Vec3;
    if (c.vertical === "gyro") {
      // Specific force as CoreMotion measured it (its gravity + user acceleration), levelled by our own vertical.
      const total: Vec3 = [s.gravity[0] + s.userAccel[0], s.gravity[1] + s.userAccel[1], s.gravity[2] + s.userAccel[2]];
      if (this.upOwn === null || !out.valid) this.upOwn = [upCm[0], upCm[1], upCm[2]];
      else {
        const u = this.upOwn;
        // A world-fixed vector seen from the rotating phone: u' = −ω × u.
        const w = cross(s.gyro, u);
        for (let i = 0; i < 3; i++) u[i] -= w[i] * dt;
        const meas = unit([-(total[0] - this.carAccel[0]), -(total[1] - this.carAccel[1]), -(total[2] - this.carAccel[2])]);
        const a = Math.min(1, dt / (this.wasStopped ? c.levelStopTauS : c.levelTauS));
        for (let i = 0; i < 3; i++) u[i] += (meas[i] - u[i]) * a;
        const n = norm(u);
        for (let i = 0; i < 3; i++) u[i] /= n;
      }
      up = [this.upOwn[0], this.upOwn[1], this.upOwn[2]];
      h = horizontal(total, up);
    } else {
      h = horizontal(s.userAccel, up);
    }

    if (!out.valid) {
      this.window.reset();
      this.handled = true;
    } else {
      // A bump also looks like handling; only a phone that now sits differently has new axes in the car.
      if (this.handled && this.upRef && Math.acos(Math.min(1, dot(upCm, this.upRef))) > c.axisResetRad) {
        this.leftSum = [0, 0, 0];
        this.leftAbsSum = 0;
        this.turnS = 0;
        this.upRef = null;
        this.mountChecked = false;
        this.seeded = false;
        // The bias along the old axis means nothing along the new one.
        this.b = 0;
        this.P = [this.P[0], 0, 0, c.initBiasSigmaMS2 ** 2];
      }
      this.handled = false;
      if (this.upRef === null) {
        this.upRef = [upCm[0], upCm[1], upCm[2]];
        this.settledS = 0;
      } else {
        this.settledS += dt;
        const a = Math.min(1, dt / 10);
        for (let i = 0; i < 3; i++) this.upRef[i] += (upCm[i] - this.upRef[i]) * a;
        const n = norm(this.upRef);
        for (let i = 0; i < 3; i++) this.upRef[i] /= n;
      }
      this.window.push(dt, [h[0], h[1], h[2], out.yawRate]);
      const st = this.stored;
      if (st && !this.mountChecked && this.settledS >= MOUNT_SETTLE_S && this.turnS < Math.min(st.turnS, MOUNT_SEED_MAX_TURN_S)) {
        this.mountChecked = true;
        if (Math.acos(Math.min(1, dot(this.upRef!, st.up))) <= c.axisResetRad) {
          this.seeded = true;
          this.turnS = Math.min(st.turnS, MOUNT_SEED_MAX_TURN_S);
          this.leftAbsSum = st.absPerS * this.turnS;
          this.leftSum = [st.left[0] * st.agreement * this.leftAbsSum, st.left[1] * st.agreement * this.leftAbsSum, st.left[2] * st.agreement * this.leftAbsSum];
        }
      }
    }

    const vert = dot(s.userAccel, upCm);
    this.vibration.push(dt, [vert, vert * vert]);
    const vib = Math.sqrt(Math.max(0, this.vibration.mean(1) - this.vibration.mean(0) ** 2));

    this.pull.push(dt, [h[0], h[1], h[2]]);
    const pulling = this.pull.full && norm([this.pull.mean(0), this.pull.mean(1), this.pull.mean(2)]) > c.stopEndAccelMS2;

    // Stop: the phone quiet for a while pins the speed at zero and teaches the bias.
    this.quietS = out.quiet && vib < c.stopVibrationMS2 && !pulling ? this.quietS + dt : 0;
    const stopped = this.quietS >= c.stopQuietS;
    this.wasStopped = stopped;

    const left = unit(horizontal(this.leftSum, up));
    const forward = cross(left, up);
    const locked = this.locked;

    // Predict.
    const q = (this.known ? c.qSpeed : 100) * dt;
    const accelAlongMS2 = locked ? dot(h, forward) - this.b : NaN;
    if (locked && out.valid) {
      this.v += accelAlongMS2 * dt;
      const [p00, p01, p10, p11] = this.P;
      // F = [[1, −dt], [0, 1]]
      const n00 = p00 - dt * (p10 + p01) + dt * dt * p11;
      const n01 = p01 - dt * p11;
      const n10 = p10 - dt * p11;
      this.P = [n00 + q, n01, n10, p11 + c.qBias * dt];
    } else {
      this.P = [this.P[0] + Math.max(q, 0.25 * dt), this.P[1], this.P[2], this.P[3] + c.qBias * dt];
    }

    let turnSpeedMps: number | undefined;
    if (stopped) {
      this.update(0, c.zuptSigmaMps);
      this.known = true;
      this.direction = 0;
    } else if (out.valid && this.window.full) {
      const w = this.window.mean(3);
      const hm: Vec3 = [this.window.mean(0), this.window.mean(1), this.window.mean(2)];
      if (Math.abs(w) >= c.turnRateRadS) {
        // Learn the axis from this sample's share of the turn.
        for (let i = 0; i < 3; i++) this.leftSum[i] += w * hm[i] * dt;
        this.leftAbsSum += Math.abs(w) * norm(hm) * dt;
        this.turnS += dt;
      }
      if (locked && Math.abs(w) >= c.curveRateRadS) {
        // Sideways acceleration = v · ω: a measurement of v whose weight grows with the turn rate.
        const aLat = dot(hm, left);
        if (Math.abs(w) >= c.turnRateRadS) turnSpeedMps = aLat / w;
        this.update(aLat, c.curveNoiseMS2 + c.curveShare * Math.abs(aLat), w);
        this.known = true;
      }
    }

    if (c.priorSigmaMps > 0 && locked && !stopped && this.movingS >= c.priorAfterS && dt > 0) {
      this.update(c.priorSpeedMps, c.priorSigmaMps / Math.sqrt(dt));
    }

    // Direction since the last stop: the car leaves a stop forwards unless it pulls away backwards.
    const wasMovingS = this.movingS;
    this.movingS = stopped ? 0 : this.movingS + dt;
    if (stopped || !out.valid) this.pullSum = [0, 0, 0];
    else if (this.movingS <= c.pullAwayS) for (let i = 0; i < 3; i++) this.pullSum[i] += h[i] * dt;
    else if (wasMovingS <= c.pullAwayS && c.pullAwayTurnS > 0) {
      // The pull-away just ended: its mean acceleration points forward, so up × it points left.
      const mean: Vec3 = [this.pullSum[0] / c.pullAwayS, this.pullSum[1] / c.pullAwayS, this.pullSum[2] / c.pullAwayS];
      const hm = horizontal(mean, up);
      if (norm(hm) >= c.pullAwayMinMS2) {
        const l = unit(cross(up, hm));
        // Scaled like turn evidence: Σ|ω||a| per second of turning, as learned so far (else a typical 0.5).
        const perS = this.turnS > 0 ? this.leftAbsSum / this.turnS : 0.5;
        const w = perS * c.pullAwayTurnS;
        const wasLocked = this.locked;
        for (let i = 0; i < 3; i++) this.leftSum[i] += l[i] * w;
        this.leftAbsSum += w;
        this.turnS += c.pullAwayTurnS;
        if (!wasLocked && this.locked) {
          // The axis is known from this pull-away: the speed is what it added since the stop.
          const fwd = cross(unit(horizontal(this.leftSum, up)), up);
          this.v = Math.max(0, dot(this.pullSum, fwd));
          this.known = true;
          this.P = [1, 0, 0, this.P[3]];
        }
      }
    }
    if (!stopped && this.direction === 0) {
      if (this.movingS > c.reverseWindowS) this.direction = 1;
      else if (Math.abs(this.v) >= c.reverseStartMps) this.direction = this.v > 0 ? 1 : -1;
    }
    if (this.direction === -1 && turnSpeedMps !== undefined && turnSpeedMps >= c.reverseEndMps) this.direction = 1;
    if (this.direction === 1 && this.v < 0) this.v = 0;
    if (this.direction === -1 && this.v > 0) this.v = 0;

    // The car's acceleration as the accelerometer sees it: along the axis, and v · ω to the left in a turn.
    if (locked && out.valid && !stopped) {
      const along = c.levelAlong ? dot(h, forward) - this.b : 0;
      const side = this.v * out.yawRate;
      for (let i = 0; i < 3; i++) this.carAccel[i] = along * forward[i] + side * left[i];
    } else this.carAccel = [0, 0, 0];

    return {
      tUs: s.tUs,
      // Moving with the axis unknown, the speed is unknown, not the 0 of the last stop.
      speedMps: this.known && (locked || stopped) ? this.v : NaN,
      sigmaMps: Math.sqrt(this.P[0]),
      stopped,
      axisLocked: locked,
      direction: this.direction,
      turnSpeedMps,
      yawRate: out.yawRate,
      valid: out.valid,
      accelAlongMS2,
      vibrationMS2: vib,
    };
  }

  /** A speed measured elsewhere (satellite GNSS when not jammed), unsigned. */
  updateSpeed(speedMps: number, sigmaMps: number): void {
    if (this.direction === -1 && speedMps >= this.config.reverseEndMps) this.direction = 1;
    this.update(this.direction === -1 ? -speedMps : speedMps, sigmaMps);
    this.known = true;
  }
}
