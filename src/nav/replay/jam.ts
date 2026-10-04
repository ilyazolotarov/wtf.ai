// Simulated jamming for replay (MAPMATCH-SPEC §10.3): inside a window the satellite fixes are
// replaced by Wi-Fi/cell-like ones, as iOS reports them under jamming: position only (no speed or
// course), a slowly wandering error of tens of metres, every 5–10 s, often repeated.

import { LocalFrame } from "../geo/local-frame";
import { isSatelliteFix, type GnssFix } from "../types";

export interface JamWindow {
  /** Seconds since log start. */
  fromS: number;
  toS: number;
}

export interface JamOptions {
  /** Stationary σ of the error per axis, m (magnitude median ≈ 1.18 σ). */
  errorSigmaM: number;
  /** Correlation time of the error, s. */
  correlationS: number;
  /** Reported accuracy, m. */
  hAccM: number;
  /** Interval between fixes, s (uniform). */
  intervalS: [number, number];
  /** Chance that a fix repeats the previous position. */
  repeatShare: number;
  seed: number;
}

export const DEFAULT_JAM: JamOptions = {
  errorSigmaM: 45,
  correlationS: 120,
  hAccM: 65,
  intervalS: [5, 10],
  repeatShare: 0.3,
  seed: 7,
};

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

/**
 * The fixes with jamming simulated in `windows`: satellite fixes there are dropped, and coarse ones
 * are made from them (true position = the satellite fix). Coarse fixes the log already has stay.
 */
export function jamFixes(gnss: GnssFix[], startUs: number, windows: JamWindow[], options: Partial<JamOptions> = {}): GnssFix[] {
  if (!windows.length) return gnss;
  const o = { ...DEFAULT_JAM, ...options };
  const r = rng(o.seed);
  const inJam = (f: GnssFix) => {
    const t = (f.tUs - startUs) / 1e6;
    return windows.some((w) => t >= w.fromS && t < w.toS);
  };
  const out: GnssFix[] = [];
  const frame = gnss.length ? new LocalFrame(gnss[0]) : null;
  let err = [o.errorSigmaM * r.gauss(), o.errorSigmaM * r.gauss()];
  let errTUs: number | null = null;
  let nextUs = -Infinity;
  let last: GnssFix | null = null;
  for (const f of gnss) {
    if (!inJam(f) || !frame) {
      out.push(f);
      continue;
    }
    if (!isSatelliteFix(f) || f.tUs < nextUs) {
      if (!isSatelliteFix(f)) out.push(f);
      continue;
    }
    const gapS = errTUs === null ? Infinity : (f.tUs - errTUs) / 1e6;
    // Ornstein–Uhlenbeck error: correlated over `correlationS`, stationary σ `errorSigmaM`.
    const a = Number.isFinite(gapS) ? Math.exp(-gapS / o.correlationS) : 0;
    const b = o.errorSigmaM * Math.sqrt(1 - a * a);
    err = [a * err[0] + b * r.gauss(), a * err[1] + b * r.gauss()];
    errTUs = f.tUs;
    nextUs = f.tUs + (o.intervalS[0] + (o.intervalS[1] - o.intervalS[0]) * r.uniform()) * 1e6;
    if (last && r.uniform() < o.repeatShare) {
      out.push({ ...last, tUs: f.tUs });
      continue;
    }
    const [e, n] = frame.toEnu(f);
    const c = frame.toCoordinate(e + err[0], n + err[1]);
    last = { tUs: f.tUs, lat: c.lat, lon: c.lon, hAccM: o.hAccM };
    out.push(last);
  }
  return out;
}
