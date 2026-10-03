// Online estimate of how late CoreLocation positions are relative to the phone gyro / OBD
// speed (SPEC §3.4, §3.6). Apple's filtering can differ per phone model and iOS version, so
// the lag is measured on the device instead of hard-coded.
//
// Method: in 30 s windows that contain a turn, the relative track (OBD speed + gyro yaw, in
// an unknown rotation) is fitted to the satellite fixes by rotation + translation + scale,
// once for each candidate lag. A wrong lag cuts corners in turns, so the residual is
// smallest at the true lag. At constant speed on a straight road a lag is invisible, which
// is why only turn windows count. On 7 real drives (iPhone 13, iOS 26) every drive gave
// −0.2…0.0 s, with a clear minimum (fit RMS 1.4 m at −0.1 s vs 2.6 m at +0.4 s).

import type { Coordinate } from "../geo";
import { LocalFrame } from "../geo/local-frame";

export interface GnssLagConfig {
  minLagS: number;
  maxLagS: number;
  stepS: number;
  windowS: number;
  /** Start a new window this often. */
  windowStepS: number;
  /** Fixes needed per window (1 Hz satellite fixes: most of the window). */
  minFixes: number;
  /** Heading change within the window. */
  minTurnRad: number;
  minSpeedMps: number;
  /** Only fixes at least this accurate. */
  maxAccuracyM: number;
  /** Turn windows needed before the estimate is used. */
  minWindows: number;
}

export const DEFAULT_GNSS_LAG_CONFIG: GnssLagConfig = {
  minLagS: -0.5,
  maxLagS: 1.5,
  stepS: 0.05,
  windowS: 30,
  windowStepS: 10,
  minFixes: 25,
  minTurnRad: (30 * Math.PI) / 180,
  minSpeedMps: 3,
  maxAccuracyM: 10,
  // Windows overlap (30 s every 10 s), so one turn counts up to 3 times: 6 ≈ two turns.
  minWindows: 6,
};

export interface GnssLagEstimate {
  lagS: number;
  /** Turn windows behind the estimate. */
  windows: number;
  /** Fit RMS at the estimate, m. */
  rmsM: number;
}

interface TrackSample {
  tUs: number;
  e: number;
  n: number;
  psi: number;
  speed: number;
}

export class GnssLagEstimator {
  readonly config: GnssLagConfig;
  private readonly lags: number[];
  private readonly sse: number[];
  private points = 0;
  private windows = 0;
  private track: TrackSample[] = [];
  private fixes: { tUs: number; coord: Coordinate }[] = [];
  private nextWindowEndUs: number | null = null;

  constructor(config: Partial<GnssLagConfig> = {}) {
    this.config = { ...DEFAULT_GNSS_LAG_CONFIG, ...config };
    const { minLagS, maxLagS, stepS } = this.config;
    this.lags = [];
    for (let l = minLagS; l <= maxLagS + 1e-9; l += stepS) this.lags.push(Math.round(l * 1000) / 1000);
    this.sse = this.lags.map(() => 0);
  }

  /**
   * Relative track sample: position and heading (clockwise) in any fixed frame, plus speed.
   * Feed at ≥ 10 Hz; a broken track (gyro unknown) must call `breakTrack()`.
   */
  onTrack(tUs: number, e: number, n: number, psi: number, speed: number): void {
    const last = this.track.at(-1);
    if (last && tUs - last.tUs < 100_000) return;
    this.track.push({ tUs, e, n, psi, speed });
    this.prune(tUs);
  }

  /** The relative track's shape is unreliable across this point (phone handled). */
  breakTrack(): void {
    this.track = [];
    this.fixes = [];
  }

  onFix(tUs: number, coord: Coordinate, accuracyM: number, satellite: boolean): void {
    if (!satellite || accuracyM > this.config.maxAccuracyM) return;
    this.fixes.push({ tUs, coord });
    this.nextWindowEndUs ??= tUs + this.config.windowS * 1e6;
    if (tUs >= this.nextWindowEndUs) {
      this.evaluate(this.nextWindowEndUs);
      this.nextWindowEndUs += this.config.windowStepS * 1e6;
    }
  }

  estimate(): GnssLagEstimate | null {
    if (this.windows < this.config.minWindows) return null;
    let best = 0;
    for (let k = 1; k < this.lags.length; k++) if (this.sse[k] < this.sse[best]) best = k;
    // A minimum on the edge of the grid means the true lag is outside it: don't trust it.
    if (best === 0 || best === this.lags.length - 1) return null;
    return { lagS: this.lags[best], windows: this.windows, rmsM: Math.sqrt(this.sse[best] / this.points) };
  }

  private prune(nowUs: number): void {
    const keepUs = nowUs - (this.config.windowS + this.config.maxLagS + 2) * 1e6;
    while (this.track.length && this.track[0].tUs < keepUs) this.track.shift();
    while (this.fixes.length && this.fixes[0].tUs < keepUs) this.fixes.shift();
  }

  private at(tUs: number): TrackSample | null {
    const tr = this.track;
    if (!tr.length || tUs < tr[0].tUs || tUs > tr[tr.length - 1].tUs) return null;
    let lo = 0;
    let hi = tr.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (tr[mid].tUs <= tUs) lo = mid;
      else hi = mid;
    }
    const a = tr[lo];
    const b = tr[hi];
    const f = (tUs - a.tUs) / (b.tUs - a.tUs || 1);
    return { tUs, e: a.e + f * (b.e - a.e), n: a.n + f * (b.n - a.n), psi: a.psi, speed: a.speed + f * (b.speed - a.speed) };
  }

  private evaluate(endUs: number): void {
    const c = this.config;
    const startUs = endUs - c.windowS * 1e6;
    const fixes = this.fixes.filter((f) => f.tUs >= startUs && f.tUs < endUs);
    if (fixes.length < c.minFixes) return;
    // Every candidate lag must find the track: it has to cover the whole shifted window.
    const samples = fixes.map((f) => this.at(f.tUs - c.minLagS * 1e6));
    if (samples.some((s) => s === null) || fixes.some((f) => !this.at(f.tUs - c.maxLagS * 1e6))) return;
    if (samples.some((s) => s!.speed < c.minSpeedMps)) return;
    let psiMin = Infinity;
    let psiMax = -Infinity;
    // Unwrap heading over the window.
    let prev = samples[0]!.psi;
    let acc = prev;
    for (const s of samples) {
      acc += Math.atan2(Math.sin(s!.psi - prev), Math.cos(s!.psi - prev));
      prev = s!.psi;
      psiMin = Math.min(psiMin, acc);
      psiMax = Math.max(psiMax, acc);
    }
    if (psiMax - psiMin < c.minTurnRad) return;

    const frame = new LocalFrame(fixes[0].coord);
    const world = fixes.map((f) => frame.toEnu(f.coord));
    for (let k = 0; k < this.lags.length; k++) {
      const rel = fixes.map((f) => this.at(f.tUs - this.lags[k] * 1e6)!);
      this.sse[k] += similarityResidual(
        rel.map((s) => [s.e, s.n]),
        world,
      );
    }
    this.points += fixes.length;
    this.windows++;
  }
}

/** Sum of squared residuals after the best rotation + translation + scale mapping a onto b. */
export function similarityResidual(a: [number, number][], b: [number, number][]): number {
  const n = a.length;
  let aE = 0;
  let aN = 0;
  let bE = 0;
  let bN = 0;
  for (let i = 0; i < n; i++) {
    aE += a[i][0];
    aN += a[i][1];
    bE += b[i][0];
    bN += b[i][1];
  }
  aE /= n;
  aN /= n;
  bE /= n;
  bN /= n;
  let dot = 0;
  let cross = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) {
    const xE = a[i][0] - aE;
    const xN = a[i][1] - aN;
    const yE = b[i][0] - bE;
    const yN = b[i][1] - bN;
    dot += xE * yE + xN * yN;
    cross += xE * yN - xN * yE;
    aa += xE * xE + xN * xN;
    bb += yE * yE + yN * yN;
  }
  // Best rotation+scale leaves bb − (dot² + cross²)/aa.
  return aa > 0 ? Math.max(0, bb - (dot * dot + cross * cross) / aa) : bb;
}
