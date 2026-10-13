// Learns how the rear wheels' speed difference becomes the yaw rate, from the phone gyro while both see the same
// turning (SPEC §2.1 Stage 2, NAVIGATOR-SPEC §5.4): ∫ difference dt = track · ∫ yaw dt + tyre · ∫ speed dt, over
// stretches of `windowS`. The tyre term is the rear tyres' rolling radii apart: on one car the right rear read slow by
// 0.025 % one day, 0.056 % and 0.119 % the next morning and afternoon (2026-10-12/13), 0.55 °/s of turning that
// isn't at 46 km/h. So it is learned while driving, and keeps being learned.
// Integrated over a stretch, not compared sample by sample: the wheels' 0.1 s lag behind the gyro in a tight town
// turn alone parts them by over 4 °/s, and a per-sample gate learned from 10 s of 138 (2026-10-13).
// No constant term for the wheels: standing they read exactly 0. The gyro's bias (~0 standing on iOS, 0.00–0.035 °/s)
// would take the tyre term's place over the narrow speeds of a stretch.
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
  /** A stretch is compared after this long. */
  windowS: number;
  /** A sample this long after the last one breaks the stretch (the monitor's break, a lost frame run). */
  maxGapS: number;
  /** Below this speed the difference is mostly quantisation (0.01 km/h steps). */
  minSpeedMps: number;
  /**
   * The wheels' turning over a stretch further from the gyro's than this plus `agreeShare` of it: the phone moved on
   * its own (a hand, a pocket, sliding on a seat), nothing learned.
   */
  agreeRad: number;
  agreeShare: number;
  /** Noise of a stretch's integrated difference, m (~1.8° of heading over the track). */
  noiseM: number;
  /** Drift per minute (random walk) of the tyre term; the track stays. */
  tyrePerMin: number;
  prior: { trackM: number; trackSigmaM: number; tyreSigma: number };
}

export const DEFAULT_WHEEL_YAW_CALIBRATION_CONFIG: WheelYawCalibrationConfig = {
  windowS: 5,
  maxGapS: 0.3,
  minSpeedMps: 2,
  agreeRad: (3 * Math.PI) / 180,
  agreeShare: 0.1,
  noiseM: 0.05,
  tyrePerMin: 0.0002,
  // The track is the car's and stays: learned from a few minutes it wandered to 1.56–1.59 m and over-read every turn
  // (2026-10-13: 39° off the gyro in 110 s where the fixed 1.60 m stayed within 6°).
  prior: { trackM: DEFAULT_TRACK_M, trackSigmaM: 0.003, tyreSigma: 0.001 },
};

/** A 2-state Kalman filter over [track, tyre]: each stretch's ∫ difference = [∫ yaw, distance] · state. */
export class WheelYawCalibrator {
  private readonly c: WheelYawCalibrationConfig;
  private x: [number, number];
  private p: [[number, number], [number, number]];
  private learnedS = 0;
  private lastUpdateUs: number | null = null;
  private win: { startUs: number; lastUs: number; diffM: number; yawRad: number; distM: number } | null = null;

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
   * One wheel sample: the rear wheels (m/s, unsigned) and the gyro's yaw over the same time (rad/s, the wheels' lag
   * allowed for; null: not to be trusted). Reverse, slow, an untrusted gyro and a gap break the stretch. Returns, when
   * a stretch closes, whether the gyro agreed with the wheels over it; else null.
   */
  push(tUs: number, rl: number, rr: number, gyroYaw: number | null, reverse: boolean): boolean | null {
    const speed = (rl + rr) / 2;
    if (gyroYaw === null || reverse || speed < this.c.minSpeedMps) {
      this.win = null;
      return null;
    }
    const w = this.win;
    if (!w || (tUs - w.lastUs) / 1e6 > this.c.maxGapS) {
      this.win = { startUs: tUs, lastUs: tUs, diffM: 0, yawRad: 0, distM: 0 };
      return null;
    }
    const dt = (tUs - w.lastUs) / 1e6;
    w.lastUs = tUs;
    w.diffM += (rr - rl) * dt;
    w.yawRad += gyroYaw * dt;
    w.distM += speed * dt;
    const spanS = (tUs - w.startUs) / 1e6;
    if (spanS < this.c.windowS) return null;
    this.win = { startUs: tUs, lastUs: tUs, diffM: 0, yawRad: 0, distM: 0 };
    const wheelsRad = (w.diffM - this.x[1] * w.distM) / this.x[0];
    const agrees = Math.abs(wheelsRad - w.yawRad) <= this.c.agreeRad + this.c.agreeShare * Math.abs(w.yawRad);
    if (agrees) this.update(tUs, w.diffM, w.yawRad, w.distM, spanS);
    return agrees;
  }

  private update(tUs: number, diffM: number, yawRad: number, distM: number, spanS: number): void {
    const c = this.c;
    if (this.lastUpdateUs !== null) this.p[1][1] += c.tyrePerMin ** 2 * Math.min(10, (tUs - this.lastUpdateUs) / 60e6);
    this.lastUpdateUs = tUs;
    const p = this.p;
    const ph: [number, number] = [p[0][0] * yawRad + p[0][1] * distM, p[1][0] * yawRad + p[1][1] * distM];
    const s = yawRad * ph[0] + distM * ph[1] + c.noiseM ** 2;
    const k: [number, number] = [ph[0] / s, ph[1] / s];
    const r = diffM - (yawRad * this.x[0] + distM * this.x[1]);
    this.x = [this.x[0] + k[0] * r, this.x[1] + k[1] * r];
    this.p = [
      [p[0][0] - k[0] * ph[0], p[0][1] - k[0] * ph[1]],
      [p[1][0] - k[1] * ph[0], p[1][1] - k[1] * ph[1]],
    ];
    this.learnedS += spanS;
  }
}
