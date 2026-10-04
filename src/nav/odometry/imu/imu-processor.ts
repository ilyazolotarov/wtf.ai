// Phone IMU → yaw rate about the local vertical, handling and stillness flags (SPEC §3.2, §3.6).

import type { ImuSample, Vec3 } from "../../types";

export interface ImuConfig {
  /** Gravity direction vs its slow average beyond this = phone moved (mounted driving stays < 4°). */
  handlingTiltRad: number;
  /** Rotation off the vertical, averaged as a vector over 0.1 s, beyond this = phone moved. A bump
   *  shakes the phone back and forth, so the vector mean stays ≤ 0.7 rad/s (its magnitude averaged
   *  reached 1.8); handling turns it one way, ≥ 1.4 rad/s (14 real drives). */
  handlingRateRadS: number;
  /** Gyro stays invalid this long after the last handling trigger. */
  handlingHoldUs: number;
  gravityTauS: number;
  /** Stillness window and thresholds on the 0.1 s low-passed yaw rate / acceleration. */
  stillWindow: number;
  stillYawStdRadS: number;
  stillYawMeanRadS: number;
  stillAccelStdMS2: number;
}

export const DEFAULT_IMU_CONFIG: ImuConfig = {
  handlingTiltRad: (8 * Math.PI) / 180,
  handlingRateRadS: 1.0,
  handlingHoldUs: 1_500_000,
  gravityTauS: 3,
  stillWindow: 100,
  stillYawStdRadS: 0.01,
  // The bias is learned from this mean: a phone held still in a hand turns slowly (~0.3 °/s).
  stillYawMeanRadS: 0.005,
  stillAccelStdMS2: 0.2,
};

export interface ImuOutput {
  tUs: number;
  /** Rotation about "up", rad/s, counter-clockwise seen from above (left turn) positive. */
  yawRate: number;
  /** False while the phone is being handled: the yaw rate is not the car's. */
  valid: boolean;
  /** Not rotating and not vibrating like a moving car (needs OBD speed 0 to mean standstill). */
  quiet: boolean;
  /** Mean yaw rate over the stillness window (bias estimate when the car stands). */
  windowMeanYaw: number;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3) => Math.sqrt(dot(a, a));

/** Rolling mean / std over the last n values. */
class RollingStats {
  private buf: number[] = [];
  private sum = 0;
  private sumSq = 0;
  private readonly n: number;
  constructor(n: number) {
    this.n = n;
  }
  push(v: number): void {
    this.buf.push(v);
    this.sum += v;
    this.sumSq += v * v;
    if (this.buf.length > this.n) {
      const old = this.buf.shift()!;
      this.sum -= old;
      this.sumSq -= old * old;
    }
  }
  get full(): boolean {
    return this.buf.length >= this.n;
  }
  get mean(): number {
    return this.buf.length ? this.sum / this.buf.length : 0;
  }
  get std(): number {
    const n = this.buf.length;
    if (n < 2) return Infinity;
    return Math.sqrt(Math.max(0, (this.sumSq - (this.sum * this.sum) / n) / (n - 1)));
  }
  reset(): void {
    this.buf = [];
    this.sum = this.sumSq = 0;
  }
}

export class ImuProcessor {
  private readonly config: ImuConfig;
  private gravityRef: [number, number, number] | null = null;
  private lastTUs: number | null = null;
  private handlingUntilUs = -Infinity;
  private yawLp = new RollingStats(10);
  private accelLp = new RollingStats(10);
  private offLp = [new RollingStats(10), new RollingStats(10), new RollingStats(10)];
  private yawWindow: RollingStats;
  private yawLpWindow: RollingStats;
  private accelLpWindow: RollingStats;

  constructor(config: Partial<ImuConfig> = {}) {
    this.config = { ...DEFAULT_IMU_CONFIG, ...config };
    this.yawWindow = new RollingStats(this.config.stillWindow);
    this.yawLpWindow = new RollingStats(this.config.stillWindow);
    this.accelLpWindow = new RollingStats(this.config.stillWindow);
  }

  process(s: ImuSample): ImuOutput {
    const c = this.config;
    const gNorm = norm(s.gravity);
    const up: Vec3 = gNorm > 0 ? [-s.gravity[0] / gNorm, -s.gravity[1] / gNorm, -s.gravity[2] / gNorm] : [0, 0, 1];
    const yawRate = dot(s.gyro, up);

    const dt = this.lastTUs === null ? 0 : Math.max(0, (s.tUs - this.lastTUs) / 1e6);
    this.lastTUs = s.tUs;
    if (this.gravityRef === null || dt > 1) {
      this.gravityRef = [up[0], up[1], up[2]];
    } else {
      const a = Math.min(1, dt / c.gravityTauS);
      const r = this.gravityRef;
      for (let i = 0; i < 3; i++) r[i] += (up[i] - r[i]) * a;
      const n = norm(r);
      for (let i = 0; i < 3; i++) r[i] /= n;
    }
    const tilt = Math.acos(Math.min(1, Math.max(-1, dot(up, this.gravityRef))));
    const off: Vec3 = [s.gyro[0] - yawRate * up[0], s.gyro[1] - yawRate * up[1], s.gyro[2] - yawRate * up[2]];
    for (let i = 0; i < 3; i++) this.offLp[i].push(off[i]);
    const offMean = norm([this.offLp[0].mean, this.offLp[1].mean, this.offLp[2].mean]);
    if (tilt > c.handlingTiltRad || offMean > c.handlingRateRadS) this.handlingUntilUs = s.tUs + c.handlingHoldUs;
    const valid = s.tUs >= this.handlingUntilUs;

    this.yawLp.push(yawRate);
    this.accelLp.push(norm(s.userAccel));
    this.yawWindow.push(yawRate);
    this.yawLpWindow.push(this.yawLp.mean);
    this.accelLpWindow.push(this.accelLp.mean);
    if (!valid) {
      this.yawWindow.reset();
      this.yawLpWindow.reset();
      this.accelLpWindow.reset();
    }
    const quiet =
      valid &&
      this.yawWindow.full &&
      this.yawLpWindow.std < c.stillYawStdRadS &&
      Math.abs(this.yawWindow.mean) < c.stillYawMeanRadS &&
      this.accelLpWindow.std < c.stillAccelStdMS2;

    return { tUs: s.tUs, yawRate, valid, quiet, windowMeanYaw: this.yawWindow.mean };
  }
}
