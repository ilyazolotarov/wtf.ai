// Heading alignment without a GNSS course (jamming: only Wi-Fi/cell fixes, no speed/course).
//
// Before the absolute heading is known, a relative track is integrated from OBD speed and
// gyro yaw in a frame of arbitrary rotation. Its shape is accurate to a few metres over a
// kilometre, so fitting the rotation (and translation) that maps it onto the coarse fixes
// gives the heading: with fixes ±50 m spread over 1 km the angle is good to a few degrees.

export interface AlignPoint {
  /** Relative-track position at the fix time, m. */
  relE: number;
  relN: number;
  /** Fix position in the world ENU frame, m. */
  worldE: number;
  worldN: number;
  /** 1σ of the fix position, m. */
  sigma: number;
}

export interface Alignment {
  /** World = rot(θ)·rel + t, θ counter-clockwise in the E/N plane. Heading ψ_world = ψ_rel − θ. */
  theta: number;
  thetaSigma: number;
  tE: number;
  tN: number;
  /** Fixes kept after outlier rejection. */
  used: number;
  /** Largest distance between two used fixes along the relative track, m. (Not weighted:
   *  one precise fix at the parking spot would otherwise make a 450 m drive look tiny.) */
  spreadM: number;
}

export interface AlignConfig {
  minPoints: number;
  minSpreadM: number;
  maxThetaSigma: number;
  /** Residual beyond this many σ drops the worst fix (repeated). */
  outlierSigmas: number;
}

export const DEFAULT_ALIGN_CONFIG: AlignConfig = {
  minPoints: 3,
  minSpreadM: 150,
  maxThetaSigma: (10 * Math.PI) / 180,
  outlierSigmas: 3,
};

function fit(points: AlignPoint[]): Alignment & { residuals: number[] } {
  let sw = 0;
  let aE = 0;
  let aN = 0;
  let bE = 0;
  let bN = 0;
  for (const p of points) {
    const w = 1 / (p.sigma * p.sigma);
    sw += w;
    aE += w * p.relE;
    aN += w * p.relN;
    bE += w * p.worldE;
    bN += w * p.worldN;
  }
  aE /= sw;
  aN /= sw;
  bE /= sw;
  bN /= sw;

  let cross = 0;
  let dotSum = 0;
  let info = 0;
  for (const p of points) {
    const w = 1 / (p.sigma * p.sigma);
    const xE = p.relE - aE;
    const xN = p.relN - aN;
    const yE = p.worldE - bE;
    const yN = p.worldN - bN;
    cross += w * (xE * yN - xN * yE);
    dotSum += w * (xE * yE + xN * yN);
    info += w * (xE * xE + xN * xN);
  }
  let extent = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      extent = Math.max(extent, Math.hypot(points[i].relE - points[j].relE, points[i].relN - points[j].relN));
    }
  }
  const theta = Math.atan2(cross, dotSum);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const tE = bE - (c * aE - s * aN);
  const tN = bN - (s * aE + c * aN);

  let chi2 = 0;
  const residuals = points.map((p) => {
    const e = c * p.relE - s * p.relN + tE - p.worldE;
    const n = s * p.relE + c * p.relN + tN - p.worldN;
    const r = Math.hypot(e, n) / p.sigma;
    chi2 += r * r;
    return r;
  });
  // 2 residual dimensions per point, 3 fitted parameters.
  const dof = Math.max(1, 2 * points.length - 3);
  const inflate = Math.max(1, chi2 / dof);
  return {
    theta,
    thetaSigma: Math.sqrt(inflate / info),
    tE,
    tN,
    used: points.length,
    spreadM: extent,
    residuals,
  };
}

/** Best rotation + translation, or null when the fixes don't pin the heading down yet. */
export function alignHeading(points: AlignPoint[], config: Partial<AlignConfig> = {}): Alignment | null {
  const c = { ...DEFAULT_ALIGN_CONFIG, ...config };
  let kept = [...points];
  if (kept.length < c.minPoints) return null;
  let result = fit(kept);
  while (kept.length > c.minPoints) {
    let worst = 0;
    for (let i = 1; i < kept.length; i++) if (result.residuals[i] > result.residuals[worst]) worst = i;
    if (result.residuals[worst] <= c.outlierSigmas) break;
    kept = kept.filter((_, i) => i !== worst);
    result = fit(kept);
  }
  if (result.spreadM < c.minSpreadM || result.thetaSigma > c.maxThetaSigma) return null;
  const { residuals: _residuals, ...alignment } = result;
  return alignment;
}
