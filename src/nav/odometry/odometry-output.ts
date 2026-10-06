// Calibrated odometry for the map-matching particle filter (MAPMATCH-SPEC §6.1): distance and
// heading change, summed into chunks of a few metres, with variances and flags. Stage 2/3
// odometry sources produce the same steps.

export type OdometrySource = "ekf" | "relative";

export interface OdometryStep {
  t0Us: number;
  t1Us: number;
  /** Distance travelled, m (≥ 0: OBD speed is unsigned). */
  dsM: number;
  /** Heading change, rad, clockwise positive (the heading convention). */
  dpsiRad: number;
  dsVar: number;
  dpsiVar: number;
  /** Cumulative distance and unwrapped cumulative heading change at `t1Us`, since the navigator started. */
  distanceM: number;
  turnRad: number;
  /** The car stood still for the whole chunk (standstill detected, or speed below 0.2 m/s). */
  stopped: boolean;
  /** Part of the chunk had no valid gyro while moving: `dpsiRad` is 0 and `dpsiVar` large. */
  yawUnknown: boolean;
  /** Part of the chunk had no fresh OBD speed. */
  speedUnknown: boolean;
  /** `ekf`: EKF speed and calibrated gyro (mode dr). `relative`: OBD × stored speed scale and gyro − learned bias (before the EKF starts). */
  source: OdometrySource;
}

/** One integration step of the navigator (one IMU or OBD event). */
export interface OdometryIncrement {
  tUs: number;
  dtS: number;
  dsM: number;
  dpsiRad: number;
  /** White-noise part of the heading-change variance for this step (gyro noise, or handling noise). */
  dpsiWhiteVar: number;
  stopped: boolean;
  yawUnknown: boolean;
  speedUnknown: boolean;
  source: OdometrySource;
}

/** Calibration uncertainty at the time of the step: correlated over a chunk. */
export interface OdometryCalibration {
  /** Relative speed-scale σ (σ_ks / k_s). */
  speedScaleRelSigma: number;
  /** Gyro bias σ, rad/s, and yaw scale σ. */
  gyroBiasSigma: number;
  gyroScaleSigma: number;
}

export interface OdometryChunkConfig {
  maxDistanceM: number;
  maxDurationS: number;
  /** White speed noise (OBD 1 km/h resolution, timing), m/s. */
  speedNoiseMps: number;
}

export const DEFAULT_ODOMETRY_CHUNK: OdometryChunkConfig = { maxDistanceM: 2, maxDurationS: 0.2, speedNoiseMps: 0.1 };

const NO_STEPS: readonly OdometryStep[] = [];

/**
 * Sums increments into chunks of ≤ 2 m or ≤ 0.2 s (whichever first) and hands them out: `add` and `flush` return the
 * chunks they close (returned, not called back, so a forked navigator's chunker holds no closure).
 */
export class OdometryChunker {
  private readonly config: OdometryChunkConfig;
  private pending: (OdometryIncrement & { t0Us: number; durationS: number; whiteVar: number; calibration: OdometryCalibration }) | null = null;
  private distanceM = 0;
  private turnRad = 0;

  constructor(config: Partial<OdometryChunkConfig> = {}) {
    this.config = { ...DEFAULT_ODOMETRY_CHUNK, ...config };
  }

  /** The chunks this closes: none, one, or two (a source change closes the one before). */
  add(inc: OdometryIncrement, calibration: OdometryCalibration): readonly OdometryStep[] {
    const before = this.pending && this.pending.source !== inc.source ? this.flush() : null;
    const p = this.pending;
    if (!p) {
      this.pending = { ...inc, t0Us: inc.tUs - inc.dtS * 1e6, durationS: inc.dtS, whiteVar: inc.dpsiWhiteVar, calibration };
    } else {
      p.tUs = inc.tUs;
      p.durationS += inc.dtS;
      p.dsM += inc.dsM;
      p.dpsiRad += inc.dpsiRad;
      p.whiteVar += inc.dpsiWhiteVar;
      p.stopped &&= inc.stopped;
      p.yawUnknown ||= inc.yawUnknown;
      p.speedUnknown ||= inc.speedUnknown;
      p.calibration = calibration;
    }
    const q = this.pending!;
    const closed = q.dsM >= this.config.maxDistanceM || q.durationS >= this.config.maxDurationS ? this.flush() : null;
    if (before) return closed ? [before, closed] : [before];
    return closed ? [closed] : NO_STEPS;
  }

  /** The source of the chunk being summed (null: none). */
  get pendingSource(): OdometryIncrement["source"] | null {
    return this.pending?.source ?? null;
  }

  /** Cumulative distance and turn of the chunks emitted so far. */
  get totals(): { distanceM: number; turnRad: number } {
    return { distanceM: this.distanceM, turnRad: this.turnRad };
  }

  /** Close what has been summed so far (source change, reset, end of input); null: nothing was. */
  flush(): OdometryStep | null {
    const p = this.pending;
    if (!p) return null;
    this.pending = null;
    const c = p.calibration;
    this.distanceM += p.dsM;
    this.turnRad += p.dpsiRad;
    return {
      t0Us: p.t0Us,
      t1Us: p.tUs,
      dsM: p.dsM,
      dpsiRad: p.dpsiRad,
      // Scale errors are correlated over the chunk; speed noise is white.
      dsVar: (c.speedScaleRelSigma * p.dsM) ** 2 + (this.config.speedNoiseMps * p.durationS) ** 2,
      dpsiVar: p.whiteVar + (c.gyroBiasSigma * p.durationS) ** 2 + (c.gyroScaleSigma * p.dpsiRad) ** 2,
      distanceM: this.distanceM,
      turnRad: this.turnRad,
      stopped: p.stopped,
      yawUnknown: p.yawUnknown,
      speedUnknown: p.speedUnknown,
      source: p.source,
    };
  }
}
