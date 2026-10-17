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
  /** Share of the error's variance that wanders slowly instead, over `slowCorrelationS` (0: none). */
  slowShare: number;
  slowCorrelationS: number;
  /** Reported accuracy, m. */
  hAccM: number;
  /** Interval between fixes, s (uniform). */
  intervalS: [number, number];
  /** Chance that a fix repeats the previous position. */
  repeatShare: number;
  seed: number;
  /**
   * Instead of `intervalS`: the gaps between fixes as quantiles at `GAP_QUANTILES` (s), interpolated: real fixes come
   * in bursts with minutes between them.
   */
  gapQuantilesS?: readonly number[];
  /**
   * Cell fixes besides (0: none): per minute, their claimed accuracy as quantiles at `CELL_QUANTILES` (m), and their
   * error as a share of it (quantiles at `CELL_QUANTILES` too), its direction and size held over `cellCorrelationS`.
   */
  cellPerMin?: number;
  cellAccQuantilesM?: readonly number[];
  cellErrorQuantiles?: readonly number[];
  cellCorrelationS?: number;
}

/** The probabilities `gapQuantilesS` are given at. */
export const GAP_QUANTILES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1] as const;
/** The probabilities `cellAccQuantilesM` and `cellErrorQuantiles` are given at. */
export const CELL_QUANTILES = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1] as const;

export const DEFAULT_JAM: JamOptions = {
  errorSigmaM: 45,
  correlationS: 120,
  slowShare: 0,
  slowCorrelationS: 300,
  hAccM: 65,
  intervalS: [5, 10],
  repeatShare: 0.3,
  seed: 7,
};

/**
 * Wi-Fi/cell fixes as measured on the drawn real drives (2026-10-16, 793 fixes where the drawing's timing is within
 * 20 m): ±35 m claimed (median), 24 m off (median; σ ≈ 20 m an axis), and the error's correlation 0.62 / 0.40 / 0.36
 * / 0.25 / 0.17 between fixes 10 / 30 / 60 / 120 / 240 s apart — mostly gone in seconds, a third of it lasting
 * minutes. `DEFAULT_JAM` is twice the size and holds it for minutes, which skews the speed scale and the doubt rule
 * further than real fixes do.
 */
export const MEASURED_JAM: Partial<JamOptions> = { errorSigmaM: 20, hAccM: 35, correlationS: 10, slowShare: 0.35, slowCorrelationS: 300 };

/**
 * `MEASURED_JAM` with the fixes arriving as on the 45 jammed real drives (2026-10-17, 450 min): Wi-Fi-grade fixes
 * (≤ 100 m) 1.85 a minute in bursts (gaps 0.4 / 5.1 / 39.8 / 76.9 s at p10 / p50 / p90 / p95; 32 s on average, the
 * last 5 % up to 15 min), 3 % repeats; and 4.06 cell fixes a minute claiming 158 / 1414 / 3412 m (p10 / p50 / p90),
 * off by 0.11 / 0.20 / 0.38 / 0.60 of that (p25 / p50 / p75 / p90; 1824 fixes against the drawings).
 */
export const MEASURED_JAM_ARRIVALS: Partial<JamOptions> = {
  ...MEASURED_JAM,
  repeatShare: 0.03,
  gapQuantilesS: [0.2, 0.4, 0.8, 1.6, 2.7, 5.1, 6.1, 9.7, 18.7, 39.8, 76.9, 900],
  cellPerMin: 4.06,
  cellAccQuantilesM: [100, 158, 644, 1414, 2000, 3412, 5000],
  cellErrorQuantiles: [0, 0.05, 0.11, 0.2, 0.38, 0.6, 1.2],
  cellCorrelationS: 120,
};

/** Linear interpolation of a quantile table at probability u. */
function quantileAt(ps: readonly number[], values: readonly number[], u: number): number {
  for (let i = 1; i < ps.length; i++) {
    if (u <= ps[i]) return values[i - 1] + ((values[i] - values[i - 1]) * (u - ps[i - 1])) / (ps[i] - ps[i - 1]);
  }
  return values[values.length - 1];
}

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
  const fastSigma = o.errorSigmaM * Math.sqrt(1 - o.slowShare);
  const slowSigma = o.errorSigmaM * Math.sqrt(o.slowShare);
  let err = [fastSigma * r.gauss(), fastSigma * r.gauss()];
  // Drawn only with a slow part, so the default draws the fixes it always has.
  let slow = o.slowShare > 0 ? [slowSigma * r.gauss(), slowSigma * r.gauss()] : [0, 0];
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
    const sinceS = errTUs === null ? Infinity : (f.tUs - errTUs) / 1e6;
    // Ornstein–Uhlenbeck errors: correlated over `correlationS` and `slowCorrelationS`, stationary σ `errorSigmaM` together.
    const a = Number.isFinite(sinceS) ? Math.exp(-sinceS / o.correlationS) : 0;
    const b = fastSigma * Math.sqrt(1 - a * a);
    err = [a * err[0] + b * r.gauss(), a * err[1] + b * r.gauss()];
    if (o.slowShare > 0) {
      const as = Number.isFinite(sinceS) ? Math.exp(-sinceS / o.slowCorrelationS) : 0;
      const bs = slowSigma * Math.sqrt(1 - as * as);
      slow = [as * slow[0] + bs * r.gauss(), as * slow[1] + bs * r.gauss()];
    }
    errTUs = f.tUs;
    const gapS = o.gapQuantilesS ? quantileAt(GAP_QUANTILES, o.gapQuantilesS, r.uniform()) : o.intervalS[0] + (o.intervalS[1] - o.intervalS[0]) * r.uniform();
    nextUs = f.tUs + gapS * 1e6;
    if (last && r.uniform() < o.repeatShare) {
      out.push({ ...last, tUs: f.tUs });
      continue;
    }
    const [e, n] = frame.toEnu(f);
    const c = frame.toCoordinate(e + err[0] + slow[0], n + err[1] + slow[1]);
    last = { tUs: f.tUs, lat: c.lat, lon: c.lon, hAccM: o.hAccM };
    out.push(last);
  }
  return o.cellPerMin ? withCells(out, gnss, inJam, frame, o, r) : out;
}

/** Cell fixes inside the jam, from the satellite fixes' true positions: a tower's error, held for a while. */
function withCells(out: GnssFix[], gnss: GnssFix[], inJam: (f: GnssFix) => boolean, frame: LocalFrame | null, o: JamOptions, r: ReturnType<typeof rng>): GnssFix[] {
  if (!frame || !o.cellAccQuantilesM || !o.cellErrorQuantiles) return out;
  const cells: GnssFix[] = [];
  let nextUs = -Infinity;
  let heldUs = -Infinity;
  let acc = 0;
  let dir = 0;
  let share = 0;
  for (const f of gnss) {
    if (!isSatelliteFix(f) || !inJam(f) || f.tUs < nextUs) continue;
    nextUs = f.tUs - (60 / o.cellPerMin!) * Math.log(1 - r.uniform()) * 1e6;
    if (f.tUs - heldUs > (o.cellCorrelationS ?? 120) * 1e6 * -Math.log(1 - r.uniform())) {
      heldUs = f.tUs;
      acc = quantileAt(CELL_QUANTILES, o.cellAccQuantilesM, r.uniform());
      dir = 2 * Math.PI * r.uniform();
      share = quantileAt(CELL_QUANTILES, o.cellErrorQuantiles, r.uniform());
    }
    const [e, n] = frame.toEnu(f);
    const c = frame.toCoordinate(e + acc * share * Math.sin(dir), n + acc * share * Math.cos(dir));
    cells.push({ tUs: f.tUs, lat: c.lat, lon: c.lon, hAccM: Math.round(acc) });
  }
  return [...out, ...cells].sort((a, b) => a.tUs - b.tUs);
}
