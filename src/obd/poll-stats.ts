// Poll rate and latency statistics (docs/VEHICLE-LINK-SPEC.md §10.1).

import type { PollStats } from "./types";

const WINDOW = 100;
const RATE_TAU_US = 2_000_000;
const ERROR_WINDOW_US = 60_000_000;

export class PollStatsTracker {
  private latenciesMs: number[] = [];
  private lastSpeedUs: number | null = null;
  private rateHz = 0;
  private errorTimes: number[] = [];

  constructor(public capHz: number) {}

  /** A completed speed poll (any status) at rx time `tUs`. */
  onSpeedPoll(tUs: number, latencyUs: number, ok: boolean): void {
    if (this.lastSpeedUs !== null) {
      const dt = tUs - this.lastSpeedUs;
      if (dt > 0) {
        const instHz = 1e6 / dt;
        const alpha = 1 - Math.exp(-dt / RATE_TAU_US);
        this.rateHz = this.rateHz === 0 ? instHz : this.rateHz + alpha * (instHz - this.rateHz);
      }
    }
    this.lastSpeedUs = tUs;
    this.latenciesMs.push(latencyUs / 1000);
    if (this.latenciesMs.length > WINDOW) this.latenciesMs.shift();
    if (!ok) this.onError(tUs);
  }

  onError(tUs: number): void {
    this.errorTimes.push(tUs);
  }

  /** Speed polling paused (ignition off): the rate restarts from scratch. */
  pause(): void {
    this.lastSpeedUs = null;
    this.rateHz = 0;
  }

  snapshot(nowUs: number): PollStats {
    this.errorTimes = this.errorTimes.filter((t) => nowUs - t <= ERROR_WINDOW_US);
    const sorted = [...this.latenciesMs].sort((a, b) => a - b);
    const pct = (p: number) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]);
    return {
      speedHz: this.rateHz,
      latencyP50Ms: pct(0.5),
      latencyP95Ms: pct(0.95),
      errorsLastMinute: this.errorTimes.length,
      speedCapHz: this.capHz,
    };
  }
}
