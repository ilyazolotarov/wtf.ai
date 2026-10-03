// Stage 1 dead-reckoning EKF (SPEC §3.4). State in a local ENU plane:
// [E, N, ψ (heading, clockwise from north), v, k_s (v = k_s·s_OBD), b_ω (gyro yaw bias), k_ω (gyro yaw scale)].

import { identity, inverse, maxEigen2, mul, symmetrize, transpose, zeros, type Mat } from "./matrix";

export const IX = { E: 0, N: 1, PSI: 2, V: 3, KS: 4, BW: 5, KW: 6 } as const;
const DIM = 7;

export interface EkfConfig {
  /** Speed random walk (acceleration), m/s². */
  accelNoise: number;
  /** Gyro yaw-rate white noise, rad/s. */
  gyroNoise: number;
  /** Heading diffusion while the gyro is invalid (phone handled), rad/s. */
  handlingYawNoise: number;
  /** Bias random walk, rad/s/√s. */
  biasWalk: number;
  speedScaleWalk: number;
  yawScaleWalk: number;
  /** Position model slack, m/√s. */
  positionNoise: number;
  initSpeedScaleSigma: number;
  initBiasSigma: number;
  initYawScaleSigma: number;
}

export const DEFAULT_EKF_CONFIG: EkfConfig = {
  accelNoise: 2,
  // Replay of 7 drives (tools/replay/bench.ts): 0.01 kept the heading too loose (outage error
  // ~half the predicted σ); ≤ 0.001 made the filter overconfident.
  gyroNoise: 0.003,
  handlingYawNoise: 0.3,
  biasWalk: 2e-5,
  speedScaleWalk: 1e-5,
  yawScaleWalk: 1e-5,
  positionNoise: 0.1,
  initSpeedScaleSigma: 0.03,
  // CoreMotion's rotation rate is already bias-corrected (0.007 °/s measured at standstill);
  // a loose prior lets heading errors from GNSS course leak into the bias.
  initBiasSigma: 0.0005,
  initYawScaleSigma: 0.02,
};

export interface EkfInit {
  east: number;
  north: number;
  psi: number;
  speed: number;
  posSigma: number;
  psiSigma: number;
  speedSigma: number;
  /** Carry over learned parameters (and their variances) from a previous run. */
  params?: Partial<{ ks: number; bw: number; kw: number; ksVar: number; bwVar: number; kwVar: number }>;
}

export interface UpdateResult {
  accepted: boolean;
  /** Normalized innovation squared. */
  nis: number;
}

export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class DrEkf {
  readonly x: number[];
  readonly P: Mat;
  private readonly config: EkfConfig;

  constructor(init: EkfInit, config: Partial<EkfConfig> = {}) {
    this.config = { ...DEFAULT_EKF_CONFIG, ...config };
    const c = this.config;
    const p = init.params;
    this.x = [init.east, init.north, init.psi, init.speed, p?.ks ?? 1, p?.bw ?? 0, p?.kw ?? 1];
    this.P = zeros(DIM, DIM);
    this.P[IX.E][IX.E] = this.P[IX.N][IX.N] = init.posSigma ** 2;
    this.P[IX.PSI][IX.PSI] = init.psiSigma ** 2;
    this.P[IX.V][IX.V] = init.speedSigma ** 2;
    this.P[IX.KS][IX.KS] = p?.ksVar ?? c.initSpeedScaleSigma ** 2;
    this.P[IX.BW][IX.BW] = p?.bwVar ?? c.initBiasSigma ** 2;
    this.P[IX.KW][IX.KW] = p?.kwVar ?? c.initYawScaleSigma ** 2;
  }

  get east() {
    return this.x[IX.E];
  }
  get north() {
    return this.x[IX.N];
  }
  get psi() {
    return this.x[IX.PSI];
  }
  get speed() {
    return this.x[IX.V];
  }

  /** 1σ along the worst horizontal axis, m. */
  get positionSigma(): number {
    return Math.sqrt(maxEigen2(this.P[IX.E][IX.E], this.P[IX.E][IX.N], this.P[IX.N][IX.N]));
  }

  get psiSigma(): number {
    return Math.sqrt(this.P[IX.PSI][IX.PSI]);
  }

  /**
   * Propagate by dt seconds. `yawRate`: measured rotation about "up" (counter-clockwise
   * positive), or null while the gyro is invalid (heading held with inflated variance).
   */
  predict(dt: number, yawRate: number | null): void {
    if (dt <= 0) return;
    const c = this.config;
    const [, , psi, v, , bw, kw] = this.x;
    const s = Math.sin(psi);
    const co = Math.cos(psi);
    const omega = yawRate === null ? 0 : yawRate - bw;

    this.x[IX.E] += v * s * dt;
    this.x[IX.N] += v * co * dt;
    this.x[IX.PSI] = wrapAngle(psi - kw * omega * dt);

    const F = identity(DIM);
    F[IX.E][IX.PSI] = v * co * dt;
    F[IX.E][IX.V] = s * dt;
    F[IX.N][IX.PSI] = -v * s * dt;
    F[IX.N][IX.V] = co * dt;
    if (yawRate !== null) {
      F[IX.PSI][IX.BW] = kw * dt;
      F[IX.PSI][IX.KW] = -omega * dt;
    }

    const next = mul(mul(F, this.P), transpose(F));
    const yawNoise = yawRate === null ? c.handlingYawNoise : c.gyroNoise * kw;
    next[IX.E][IX.E] += c.positionNoise ** 2 * dt;
    next[IX.N][IX.N] += c.positionNoise ** 2 * dt;
    next[IX.PSI][IX.PSI] += yawNoise ** 2 * dt;
    next[IX.V][IX.V] += c.accelNoise ** 2 * dt;
    next[IX.KS][IX.KS] += c.speedScaleWalk ** 2 * dt;
    next[IX.BW][IX.BW] += c.biasWalk ** 2 * dt;
    next[IX.KW][IX.KW] += c.yawScaleWalk ** 2 * dt;
    symmetrize(next);
    for (let i = 0; i < DIM; i++) this.P[i] = next[i];
  }

  /** OBD speed: s_OBD = v / k_s. */
  updateObdSpeed(speedMps: number, sigma: number): UpdateResult {
    const v = this.x[IX.V];
    const ks = this.x[IX.KS];
    const H = zeros(1, DIM);
    H[0][IX.V] = 1 / ks;
    H[0][IX.KS] = -v / (ks * ks);
    return this.update(H, [speedMps - v / ks], [[sigma * sigma]]);
  }

  /** Zero-velocity update at standstill. */
  updateZeroSpeed(sigma: number): UpdateResult {
    const H = zeros(1, DIM);
    H[0][IX.V] = 1;
    return this.update(H, [-this.x[IX.V]], [[sigma * sigma]]);
  }

  /** At standstill the measured yaw rate is the bias. */
  updateGyroBias(meanYawRate: number, sigma: number, gate = Infinity): UpdateResult {
    const H = zeros(1, DIM);
    H[0][IX.BW] = 1;
    return this.update(H, [meanYawRate - this.x[IX.BW]], [[sigma * sigma]], gate);
  }

  /** Position residual already computed against the state at the fix time (lag-corrected). */
  updatePosition(residualE: number, residualN: number, sigma: number, gate: number): UpdateResult {
    const H = zeros(2, DIM);
    H[0][IX.E] = 1;
    H[1][IX.N] = 1;
    const r = sigma * sigma;
    return this.update(H, [residualE, residualN], [
      [r, 0],
      [0, r],
    ], gate);
  }

  updateSpeed(residual: number, sigma: number, gate: number): UpdateResult {
    const H = zeros(1, DIM);
    H[0][IX.V] = 1;
    return this.update(H, [residual], [[sigma * sigma]], gate);
  }

  updateHeading(residual: number, sigma: number, gate: number): UpdateResult {
    const H = zeros(1, DIM);
    H[0][IX.PSI] = 1;
    return this.update(H, [wrapAngle(residual)], [[sigma * sigma]], gate);
  }

  /** Move the frame origin: the state shifts by (-dE, -dN). */
  shift(dE: number, dN: number): void {
    this.x[IX.E] -= dE;
    this.x[IX.N] -= dN;
  }

  params() {
    return {
      ks: this.x[IX.KS],
      bw: this.x[IX.BW],
      kw: this.x[IX.KW],
      ksVar: this.P[IX.KS][IX.KS],
      bwVar: this.P[IX.BW][IX.BW],
      kwVar: this.P[IX.KW][IX.KW],
    };
  }

  private update(H: Mat, y: number[], R: Mat, gate = Infinity): UpdateResult {
    const Ht = transpose(H);
    const PHt = mul(this.P, Ht);
    const S = mul(H, PHt);
    for (let i = 0; i < S.length; i++) for (let j = 0; j < S.length; j++) S[i][j] += R[i][j];
    const Si = inverse(S);
    const ySi = mul([y], Si)[0];
    const nis = ySi.reduce((acc, v, i) => acc + v * y[i], 0);
    if (!(nis <= gate)) return { accepted: false, nis };

    const K = mul(PHt, Si);
    for (let i = 0; i < DIM; i++) this.x[i] += K[i].reduce((acc, k, j) => acc + k * y[j], 0);
    this.x[IX.PSI] = wrapAngle(this.x[IX.PSI]);

    // Joseph form keeps P symmetric positive-definite.
    const IKH = identity(DIM);
    const KH = mul(K, H);
    for (let i = 0; i < DIM; i++) for (let j = 0; j < DIM; j++) IKH[i][j] -= KH[i][j];
    const next = mul(mul(IKH, this.P), transpose(IKH));
    const KRKt = mul(mul(K, R), transpose(K));
    for (let i = 0; i < DIM; i++) for (let j = 0; j < DIM; j++) next[i][j] += KRKt[i][j];
    symmetrize(next);
    for (let i = 0; i < DIM; i++) this.P[i] = next[i];
    return { accepted: true, nis };
  }
}
