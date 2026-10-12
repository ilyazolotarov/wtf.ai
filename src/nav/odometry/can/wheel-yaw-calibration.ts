// Learns how the rear wheels' speed difference becomes the yaw rate, from the phone gyro while both see the same
// turning (SPEC §2.1 Stage 2): difference = track · yaw + tyre · speed. The tyre term is the rear tyres' rolling
// radii apart (0.05 % reads as 0.3 °/s of turning at 60 km/h). Replay only for now: on the drives of 2026-10-12 it
// learned 1.59–1.61 m and −0.005…−0.02 % within a drive, and the wheels' heading after the gyro stopped was no
// better than with the defaults (track 1.60 m, no tyre term; worst 7–22° against 6–14° over 1–4 min).
// No constant term: the phone gyro's bias is ~0 standing (iOS calibrates it, 0.00–0.035 °/s on those drives), and a
// free constant took the tyre term's place over the narrow speeds of a mounted stretch (−0.16 % learned, ~1 °/s off
// at 60 km/h).
import { DEFAULT_TRACK_M } from "./wheel-yaw";

export interface WheelYawCalibration {
  /** Rear track, m: difference per rad/s of yaw. */
  trackM: number;
  /** Rear tyres' radii apart: difference per m/s of speed (right over left, minus 1). */
  tyre: number;
  /** 1σ of each, from the filter. */
  trackSigmaM: number;
  tyreSigma: number;
  /** Seconds of agreeing gyro and wheels it learned from. */
  learnedS: number;
}

export interface WheelYawCalibrationConfig {
  /** Samples are averaged this long (wheel yaw lags the gyro ~0.1 s; a longer mean hides it). */
  windowS: number;
  /** Below this speed the difference is mostly quantisation (0.01 km/h steps). */
  minSpeedMps: number;
  /** Gyro and calibrated wheels further apart than this: the phone moves on its own, nothing learned. */
  agreeRadps: number;
  /** A window turning faster than this changes too fast for the lag to average out. */
  maxYawAccelRadps2: number;
  /**
   * Noise of one window's mean difference, m/s: the residuals' RMS (0.7–1 °/s on 0.5 s bins, ×1.6 m), with room for
   * what isn't noise (the lag, a curve's lateral load); 0.01 made the filter sure of a tyre term in a minute.
   */
  noiseMps: number;
  /** Drift per minute (random walk) of the tyre term; the track stays. */
  tyrePerMin: number;
  prior: { trackM: number; trackSigmaM: number; tyreSigma: number };
}

export const DEFAULT_WHEEL_YAW_CALIBRATION_CONFIG: WheelYawCalibrationConfig = {
  windowS: 1,
  minSpeedMps: 3,
  agreeRadps: (4 * Math.PI) / 180,
  maxYawAccelRadps2: (10 * Math.PI) / 180,
  noiseMps: 0.03,
  tyrePerMin: 0.0001,
  prior: { trackM: DEFAULT_TRACK_M, trackSigmaM: 0.03, tyreSigma: 0.0003 },
};

/** A 2-state Kalman filter over [track, tyre]: each window's mean difference = [yaw, speed] · state. */
export class WheelYawCalibrator {
  private readonly c: WheelYawCalibrationConfig;
  private x: [number, number];
  private p: [[number, number], [number, number]];
  private learnedS = 0;
  private lastUs: number | null = null;
  private win: { startUs: number; n: number; diff: number; yaw: number; speed: number; yawFirst: number; yawLast: number } | null = null;

  constructor(start?: WheelYawCalibration | null, config: Partial<WheelYawCalibrationConfig> = {}) {
    this.c = { ...DEFAULT_WHEEL_YAW_CALIBRATION_CONFIG, ...config };
    const pr = this.c.prior;
    const s = start ?? { trackM: pr.trackM, tyre: 0, trackSigmaM: pr.trackSigmaM, tyreSigma: pr.tyreSigma, learnedS: 0 };
    this.x = [s.trackM, s.tyre];
    this.p = [
      [s.trackSigmaM ** 2, 0],
      [0, s.tyreSigma ** 2],
    ];
    this.learnedS = s.learnedS;
  }

  get calibration(): WheelYawCalibration {
    return { trackM: this.x[0], tyre: this.x[1], trackSigmaM: Math.sqrt(this.p[0][0]), tyreSigma: Math.sqrt(this.p[1][1]), learnedS: this.learnedS };
  }

  /** The yaw rate from a rear difference (right − left, m/s) at a speed (unsigned), forward. */
  yaw(diffMps: number, speedMps: number): number {
    return (diffMps - this.x[1] * speedMps) / this.x[0];
  }

  /**
   * One sample: the rear wheels (m/s) and the gyro's yaw then (rad/s; null: not to be trusted). Reverse, slow, a
   * gyro that disagrees and a window turning too fast teach nothing. Returns whether the gyro agreed (null: no verdict).
   */
  push(tUs: number, rl: number, rr: number, gyroYaw: number | null, reverse: boolean): boolean | null {
    const speed = (rl + rr) / 2;
    const diff = rr - rl;
    if (gyroYaw === null || reverse || speed < this.c.minSpeedMps) {
      this.win = null;
      return null;
    }
    if (Math.abs(this.yaw(diff, speed) - gyroYaw) > this.c.agreeRadps) {
      this.win = null;
      return false;
    }
    if (this.win && tUs - this.win.startUs > 2 * this.c.windowS * 1e6) this.win = null;
    this.win ??= { startUs: tUs, n: 0, diff: 0, yaw: 0, speed: 0, yawFirst: gyroYaw, yawLast: gyroYaw };
    const w = this.win;
    w.n++;
    w.diff += diff;
    w.yaw += gyroYaw;
    w.speed += speed;
    w.yawLast = gyroYaw;
    const spanS = (tUs - w.startUs) / 1e6;
    if (spanS < this.c.windowS) return true;
    this.win = null;
    if (Math.abs(w.yawLast - w.yawFirst) / spanS <= this.c.maxYawAccelRadps2) this.update(tUs, w.diff / w.n, w.yaw / w.n, w.speed / w.n, spanS);
    return true;
  }

  private update(tUs: number, diff: number, yaw: number, speed: number, spanS: number): void {
    const c = this.c;
    if (this.lastUs !== null) this.p[1][1] += c.tyrePerMin ** 2 * Math.min(10, (tUs - this.lastUs) / 60e6);
    this.lastUs = tUs;
    const p = this.p;
    const ph: [number, number] = [p[0][0] * yaw + p[0][1] * speed, p[1][0] * yaw + p[1][1] * speed];
    const s = yaw * ph[0] + speed * ph[1] + c.noiseMps ** 2;
    const k: [number, number] = [ph[0] / s, ph[1] / s];
    const r = diff - (yaw * this.x[0] + speed * this.x[1]);
    this.x = [this.x[0] + k[0] * r, this.x[1] + k[1] * r];
    this.p = [
      [p[0][0] - k[0] * ph[0], p[0][1] - k[0] * ph[1]],
      [p[1][0] - k[1] * ph[0], p[1][1] - k[1] * ph[1]],
    ];
    this.learnedS += spanS;
  }
}
