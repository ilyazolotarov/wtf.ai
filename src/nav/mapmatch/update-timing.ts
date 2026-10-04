/**
 * Particle-filter update times over a session, in bounded memory (MAPMATCH-SPEC §10.2, on device):
 * a log-spaced histogram (buckets 5 % apart from 1 µs to ~2 s) for the quantiles, plus exact count,
 * total and max. Quantiles are the upper edge of their bucket: at most 5 % high.
 */
const MIN_MS = 0.001;
const RATIO = 1.05;
const BUCKETS = 300;

export interface UpdateTimingSummary {
  count: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  totalMs: number;
  /** Updates over the budget (`overBudget`). */
  overBudget: number;
}

export class UpdateTiming {
  private readonly hist = new Uint32Array(BUCKETS);
  count = 0;
  totalMs = 0;
  maxMs = 0;
  overBudget = 0;

  /** `budgetMs`: the per-update target (SPEC §7.6: 5 ms). */
  constructor(private readonly budgetMs = 5) {}

  add(ms: number): void {
    const v = Math.max(0, ms);
    this.count++;
    this.totalMs += v;
    if (v > this.maxMs) this.maxMs = v;
    if (v > this.budgetMs) this.overBudget++;
    const k = v <= MIN_MS ? 0 : Math.min(BUCKETS - 1, Math.ceil(Math.log(v / MIN_MS) / Math.log(RATIO)));
    this.hist[k]++;
  }

  quantile(q: number): number {
    if (!this.count) return 0;
    const target = Math.max(1, Math.ceil(q * this.count));
    let seen = 0;
    for (let k = 0; k < BUCKETS; k++) {
      seen += this.hist[k];
      if (seen >= target) return Math.min(this.maxMs, MIN_MS * RATIO ** k);
    }
    return this.maxMs;
  }

  summary(): UpdateTimingSummary | null {
    if (!this.count) return null;
    return {
      count: this.count,
      p50Ms: this.quantile(0.5),
      p99Ms: this.quantile(0.99),
      maxMs: this.maxMs,
      totalMs: this.totalMs,
      overBudget: this.overBudget,
    };
  }
}
