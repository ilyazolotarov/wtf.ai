// A car's CAN profile on probation (VEHICLE-LINK-SPEC §16.5): before the navigator drives on a profile's speed, its
// decoded speed is checked against the car's own OBD speed (PID 0D) on the same drive. A wrong signal, unit or factor
// shows as a ratio away from 1, a loose correlation, a speed while the car stands or one wheel unlike the others.
// OBD only, not GNSS: the check works under jamming and needs no position. Pure: the app and replay run the same code.
import type { CanSpeed } from "./can-speed";

export interface ProbationConfig {
  /** Pairs at or above this OBD speed give the scale (1 km/h steps are under 5 % of it). */
  scaleKph: number;
  /** Pairs at or above this speed (OBD or CAN) give the correlation. */
  movingKph: number;
  /** The CAN samples around an OBD sample at most this far apart (a poll's break: ~160 ms MX+, ~270 ms vLinker). */
  bracketUs: number;
  /** A pair counts only where the CAN speed changed less than this across its bracket: no lag between the two. */
  steadyKph: number;
  /** OBD at 0 (not reversing): the CAN speed at most this (some ECUs read 0 below 2–3 km/h). */
  standKph: number;
  /** Least data for any verdict: scale pairs, OBD speed range of the moving pairs, standing pairs. */
  minScalePairs: number;
  minRangeKph: number;
  minStandPairs: number;
  /** A pass: scale within, spread (median absolute deviation / scale) under, correlation over, standing share over,
   *  every wheel within this share of the wheels' mean. */
  passScale: [number, number];
  passSpread: number;
  passCorrelation: number;
  passStandShare: number;
  passWheel: number;
  /** A fail at once (no profile that reads the speed right gets here): scale outside, correlation under, standing
   *  share under (with `failStandPairs`), a wheel this far off. */
  failScale: [number, number];
  failCorrelation: number;
  failStandShare: number;
  failStandPairs: number;
  failWheel: number;
  /** Neither by this many scale pairs: a fail, for the first pass rule unmet that the drive gave data for. */
  maxScalePairs: number;
}

export const PROBATION: ProbationConfig = {
  scaleKph: 20,
  movingKph: 5,
  bracketUs: 800_000,
  steadyKph: 1.5,
  standKph: 3,
  minScalePairs: 60,
  minRangeKph: 20,
  minStandPairs: 6,
  passScale: [0.92, 1.08],
  passSpread: 0.03,
  passCorrelation: 0.985,
  passStandShare: 0.8,
  passWheel: 0.03,
  failScale: [0.8, 1.25],
  failCorrelation: 0.9,
  failStandShare: 0.5,
  failStandPairs: 20,
  failWheel: 0.1,
  maxScalePairs: 600,
};

export type ProbationReason = "scale" | "spread" | "correlation" | "standstill" | "wheels";

export interface ProbationStats {
  /** Scale pairs (OBD at or above `scaleKph`, steady). */
  scalePairs: number;
  /** CAN / OBD, the median of the scale pairs; NaN without them. */
  scale: number;
  /** Median absolute deviation of the ratio, as a share of the scale. */
  spread: number;
  /** Pearson correlation of CAN and OBD over the moving pairs. */
  correlation: number;
  /** OBD speed range of the moving pairs, km/h. */
  rangeKph: number;
  standPairs: number;
  /** Share of the standing pairs whose CAN speed was at most `standKph`. */
  standShare: number;
  /** The wheel furthest from the wheels' mean (median over the scale pairs), as a share; null without wheel speeds. */
  wheelOff: number | null;
}

export interface ProbationVerdict {
  pass: boolean;
  /** Why it failed; null on a pass. */
  reason: ProbationReason | null;
  stats: ProbationStats;
}

interface Pair {
  obdKph: number;
  canKph: number;
  /** Each wheel / the wheels' mean, at the pair's time; null without wheel speeds. */
  wheels: number[] | null;
}

/** OBD samples wait this long at most for the CAN sample after them. */
const PENDING_US = 2_000_000;
/** CAN samples kept for the brackets. */
const KEEP_US = 3_000_000;
/** The verdict is looked at every this many pairs (moving or standing), not at each. */
const CHECK_EVERY = 10;

export class SpeedProbation {
  private can: CanSpeed[] = [];
  private pending: { tUs: number; kph: number }[] = [];
  private moving: Pair[] = [];
  private scalePairs: Pair[] = [];
  private stand = { n: 0, ok: 0 };
  private verdict_: ProbationVerdict | null = null;
  private sinceCheck = 0;

  constructor(private readonly config: ProbationConfig = PROBATION) {}

  get verdict(): ProbationVerdict | null {
    return this.verdict_;
  }

  /** A CAN speed sample (unsigned, with the gear), in time order. */
  addCan(s: CanSpeed): void {
    if (this.verdict_) return;
    this.can.push(s);
    while (this.can.length && s.tUs - this.can[0].tUs > KEEP_US) this.can.shift();
    while (this.pending.length && this.pending[0].tUs < s.tUs) this.pair(this.pending.shift()!);
    this.pending = this.pending.filter((p) => s.tUs - p.tUs <= PENDING_US);
  }

  /** An OBD speed sample: its time (the poll's midpoint) and reading, km/h. */
  addObd(tUs: number, kph: number): void {
    if (this.verdict_) return;
    this.pending.push({ tUs, kph });
  }

  stats(): ProbationStats {
    const ratios = this.scalePairs.map((p) => p.canKph / p.obdKph);
    const scale = median(ratios);
    const spread = median(ratios.map((r) => Math.abs(r - scale))) / scale;
    const obd = this.moving.map((p) => p.obdKph);
    const withWheels = this.scalePairs.filter((p) => p.wheels);
    const wheelOff = withWheels.length
      ? Math.max(...withWheels[0].wheels!.map((_, i) => Math.abs(median(withWheels.map((p) => p.wheels![i])) - 1)))
      : null;
    return {
      scalePairs: this.scalePairs.length,
      scale,
      spread,
      correlation: pearson(obd, this.moving.map((p) => p.canKph)),
      // A loop, not a spread: a drive waiting for its stop has thousands of pairs.
      rangeKph: obd.length ? obd.reduce((m, x) => Math.max(m, x), -Infinity) - obd.reduce((m, x) => Math.min(m, x), Infinity) : 0,
      standPairs: this.stand.n,
      standShare: this.stand.n ? this.stand.ok / this.stand.n : NaN,
      wheelOff,
    };
  }

  private pair(o: { tUs: number; kph: number }): void {
    const c = this.config;
    let k = this.can.length - 1;
    while (k >= 0 && this.can[k].tUs > o.tUs) k--;
    const before = this.can[k];
    const after = this.can[k + 1];
    if (!before || !after || after.tUs - before.tUs > c.bracketUs) return;
    const f = (o.tUs - before.tUs) / (after.tUs - before.tUs);
    const at = (a: number, b: number) => a + (b - a) * f;
    const canKph = at(before.speedMps, after.speedMps) * 3.6;
    if (o.kph === 0) {
      // Reversing, an ECU may read 0 (the main test car's does): not a standing car.
      if (before.reverse || after.reverse) return;
      this.stand.n++;
      if (canKph <= c.standKph) this.stand.ok++;
      this.counted();
      return;
    }
    if (Math.abs(after.speedMps - before.speedMps) * 3.6 > c.steadyKph) return;
    if (o.kph < c.movingKph && canKph < c.movingKph) return;
    let wheels: number[] | null = null;
    if (before.wheelsMps && after.wheelsMps) {
      const w = before.wheelsMps.map((v, i) => at(v, after.wheelsMps![i]));
      const mean = w.reduce((a, b) => a + b, 0) / w.length;
      wheels = mean > 0 ? w.map((v) => v / mean) : null;
    }
    const pair = { obdKph: o.kph, canKph, wheels };
    this.moving.push(pair);
    if (o.kph >= c.scaleKph) this.scalePairs.push(pair);
    this.counted();
  }

  private counted(): void {
    if (++this.sinceCheck < CHECK_EVERY) return;
    this.sinceCheck = 0;
    this.verdict_ = this.judge();
  }

  private judge(): ProbationVerdict | null {
    const c = this.config;
    const s = this.stats();
    const scaled = s.scalePairs >= c.minScalePairs;
    const ranged = s.rangeKph >= c.minRangeKph;
    const stood = s.standPairs >= c.minStandPairs;
    if (!scaled || !ranged || !stood) {
      // Not enough of a drive for a pass yet, but a scale or a wheel no right profile gives fails on what there is.
      if (scaled && (s.scale < c.failScale[0] || s.scale > c.failScale[1])) return fail("scale", s);
      if (scaled && s.wheelOff !== null && s.wheelOff > c.failWheel) return fail("wheels", s);
      // At the pairs' limit, a rule the drive gave data for fails; one it gave none for (no stop yet, a cruise too
      // steady for a correlation) waits: a lack of data never fails a profile, whose fail is kept for the car.
      const unmet = s.scalePairs >= c.maxScalePairs ? firstUnmet(s, c, { correlation: ranged, standstill: stood }) : null;
      return unmet ? fail(unmet, s) : null;
    }
    if (s.scale < c.failScale[0] || s.scale > c.failScale[1]) return fail("scale", s);
    if (s.correlation < c.failCorrelation) return fail("correlation", s);
    if (s.standPairs >= c.failStandPairs && s.standShare < c.failStandShare) return fail("standstill", s);
    if (s.wheelOff !== null && s.wheelOff > c.failWheel) return fail("wheels", s);
    const unmet = firstUnmet(s, c);
    if (!unmet) return { pass: true, reason: null, stats: s };
    return s.scalePairs >= c.maxScalePairs ? fail(unmet, s) : null;
  }
}

/** The first pass rule the stats don't meet, null when they meet all; `judged` false: a rule without its data, skipped. */
function firstUnmet(s: ProbationStats, c: ProbationConfig, judged = { correlation: true, standstill: true }): ProbationReason | null {
  if (!(s.scale >= c.passScale[0] && s.scale <= c.passScale[1])) return "scale";
  if (!(s.spread <= c.passSpread)) return "spread";
  if (judged.correlation && !(s.correlation >= c.passCorrelation)) return "correlation";
  if (judged.standstill && !(s.standShare >= c.passStandShare)) return "standstill";
  if (s.wheelOff !== null && !(s.wheelOff <= c.passWheel)) return "wheels";
  return null;
}

const fail = (reason: ProbationReason, stats: ProbationStats): ProbationVerdict => ({ pass: false, reason, stats });

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return NaN;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}
