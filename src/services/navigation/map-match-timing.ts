import { UpdateTiming, type UpdateTimingSummary } from "@/nav/mapmatch/update-timing";

interface Totals {
  count: number;
  totalMs: number;
  maxMs: number;
}

const none = (): Totals => ({ count: 0, totalMs: 0, maxMs: 0 });

/**
 * How long the particle filter takes on the phone (MAPMATCH-SPEC §11): its updates this drive, those since the last
 * `nav_mapmatch` record, and its starts apart (the first reads the roads around the car from storage).
 */
export class MapMatchTiming {
  private timing = new UpdateTiming();
  private starts = none();
  private since = 0;
  private interval = none();

  constructor(private readonly nowMs: () => number) {}

  /** Every filter start and update since the last drain, out of the filter (whose lists would grow all drive). */
  drain(pf: { updateTimes: number[]; startTimes: number[] } | null | undefined): void {
    if (!pf || (!pf.updateTimes.length && !pf.startTimes.length)) return;
    if (!this.timing.count && !this.starts.count) this.since = this.nowMs();
    for (const ms of pf.startTimes.splice(0)) {
      this.starts.count++;
      this.starts.totalMs += ms;
      this.starts.maxMs = Math.max(this.starts.maxMs, ms);
    }
    for (const ms of pf.updateTimes.splice(0)) {
      this.timing.add(ms);
      this.interval.count++;
      this.interval.totalMs += ms;
      this.interval.maxMs = Math.max(this.interval.maxMs, ms);
    }
  }

  /** This drive's updates, and their share of the time (starts included); null: none yet. */
  summary(): (UpdateTimingSummary & { share: number }) | null {
    const s = this.timing.summary();
    if (!s) return null;
    return { ...s, share: (s.totalMs + this.starts.totalMs) / Math.max(1, this.nowMs() - this.since) };
  }

  /** This drive's starts (null: none). */
  startSummary(): { count: number; maxMs: number } | null {
    return this.starts.count ? { count: this.starts.count, maxMs: this.starts.maxMs } : null;
  }

  /** At the end of a drive: its trip-log line (null: no updates), and counting starts afresh. */
  endDrive(): string | null {
    const s = this.summary();
    const starts = this.starts;
    this.timing = new UpdateTiming();
    this.starts = none();
    if (!s) return null;
    const ms = (v: number) => (v < 10 ? v.toFixed(2) : v.toFixed(0));
    return (
      `mm timing: ${s.count} updates, p50 ${ms(s.p50Ms)} ms, p99 ${ms(s.p99Ms)} ms, max ${ms(s.maxMs)} ms, ` +
      `${(s.share * 100).toFixed(2)} % of the time, ${s.overBudget} over 5 ms` +
      (starts.count ? `; ${starts.count} start${starts.count === 1 ? "" : "s"}, slowest ${ms(starts.maxMs)} ms` : "")
    );
  }

  /** The updates since the last `nav_mapmatch` record, for the next one, and counting them afresh. */
  takeInterval(): { count: number; totalUs: number; maxUs: number } {
    const i = this.interval;
    this.interval = none();
    return { count: i.count, totalUs: i.totalMs * 1000, maxUs: i.maxMs * 1000 };
  }

  /** A new navigator: the next record counts from now. */
  resetInterval(): void {
    this.interval = none();
  }
}
