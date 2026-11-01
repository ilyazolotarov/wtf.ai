// What blocked the JS thread during a drive (MAPMATCH-SPEC §14): React Native reports every task that held the
// thread for 50 ms or more as a `longtask` performance entry. Each is attributed to the work running then, which the
// callers bracket with `label` (the filter's update, a routing slice, the map's smoothing frame, a publish), and the
// drive ends with one trip-log line beside `mm timing`. Pure: the clock and the observer are injected (Jest), and the
// phone's are the defaults.
import { UpdateTiming, type UpdateTimingSummary } from "@/nav/mapmatch/update-timing";

/** React Native's own threshold: shorter tasks are never reported. */
export const LONG_TASK_MS = 50;
/** Labels remembered for attribution: a task is reported right after it ends, so a few dozen suffice. */
const RING = 64;

export interface LongTaskEntry {
  /** `performance.now()` time base, ms. */
  startTime: number;
  duration: number;
}

export interface LongTasksDeps {
  /** `performance.now()`: the time base the entries use. */
  nowMs?(): number;
  /** Starts delivering long-task entries; null when the platform can't (then `endDrive` has nothing to say). */
  observe?(onEntries: (entries: readonly LongTaskEntry[]) => void): (() => void) | null;
}

interface Labelled {
  name: string;
  start: number;
  end: number;
}

interface PerLabel {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface LongTasksSummary extends UpdateTimingSummary {
  /** Since the drive's counting began, ms. */
  spanMs: number;
  byLabel: Record<string, PerLabel>;
}

/** The phone's observer: React Native's `PerformanceObserver` on `longtask` entries; null where there is none. */
function observeOnDevice(onEntries: (entries: readonly LongTaskEntry[]) => void): (() => void) | null {
  const Observer = (globalThis as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
  if (!Observer || !Observer.supportedEntryTypes?.includes("longtask")) return null;
  try {
    const observer = new Observer((list) => onEntries(list.getEntries().map((e) => ({ startTime: e.startTime, duration: e.duration }))));
    observer.observe({ type: "longtask" });
    return () => observer.disconnect();
  } catch {
    return null;
  }
}

export class LongTasks {
  private readonly nowMs: () => number;
  private readonly observeWith: NonNullable<LongTasksDeps["observe"]>;
  private readonly ring: (Labelled | null)[] = new Array(RING).fill(null);
  private next = 0;
  /** Labels in progress (nested: the innermost is attributed). */
  private readonly open: { name: string; start: number }[] = [];
  private timing = new UpdateTiming(LONG_TASK_MS);
  private byLabel = new Map<string, PerLabel>();
  private since: number | null = null;
  private stop: (() => void) | null = null;
  private supported = false;

  constructor(deps: LongTasksDeps = {}) {
    this.nowMs = deps.nowMs ?? (() => performance.now());
    this.observeWith = deps.observe ?? observeOnDevice;
  }

  /** Starts observing; counting begins now. */
  start(): void {
    if (this.stop) return;
    this.stop = this.observeWith((entries) => this.take(entries));
    this.supported = this.stop !== null;
    this.since = this.nowMs();
  }

  dispose(): void {
    this.stop?.();
    this.stop = null;
  }

  /** Runs `fn` as `name`: a long task overlapping it is counted under that name. */
  label<T>(name: string, fn: () => T): T {
    const start = this.nowMs();
    this.open.push({ name, start });
    try {
      return fn();
    } finally {
      this.open.pop();
      this.ring[this.next] = { name, start, end: this.nowMs() };
      this.next = (this.next + 1) % RING;
    }
  }

  /** Long-task entries as the platform reports them (after each task). */
  take(entries: readonly LongTaskEntry[]): void {
    for (const e of entries) {
      const name = this.attribute(e.startTime, e.startTime + e.duration);
      this.timing.add(e.duration);
      const per = this.byLabel.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
      per.count++;
      per.totalMs += e.duration;
      per.maxMs = Math.max(per.maxMs, e.duration);
      this.byLabel.set(name, per);
    }
  }

  /** The label whose run overlaps the task most; a label still open counts to its end; none: "other". */
  private attribute(start: number, end: number): string {
    let best = "other";
    let bestOverlap = 0;
    const consider = (name: string, s: number, e: number) => {
      const overlap = Math.min(end, e) - Math.max(start, s);
      if (overlap > bestOverlap || (overlap === bestOverlap && overlap > 0)) {
        best = name;
        bestOverlap = overlap;
      }
    };
    for (const r of this.ring) if (r) consider(r.name, r.start, r.end);
    const now = this.nowMs();
    for (const o of this.open) consider(o.name, o.start, now);
    return best;
  }

  /** This drive so far; null when the platform reports no long tasks or counting hasn't started. */
  summary(): LongTasksSummary | null {
    if (!this.supported || this.since === null) return null;
    const s = this.timing.summary() ?? { count: 0, p50Ms: 0, p99Ms: 0, maxMs: 0, totalMs: 0, overBudget: 0 };
    return { ...s, spanMs: Math.max(0, this.nowMs() - this.since), byLabel: Object.fromEntries(this.byLabel) };
  }

  /** At the end of a drive: its trip-log line (null: nothing observed), and counting starts afresh. */
  endDrive(): string | null {
    const s = this.summary();
    this.timing = new UpdateTiming(LONG_TASK_MS);
    this.byLabel = new Map();
    this.since = this.supported ? this.nowMs() : null;
    if (!s) return null;
    const minutes = s.spanMs / 60_000;
    if (!s.count) return `js long tasks: none in ${minutes.toFixed(1)} min`;
    const ms = (v: number) => v.toFixed(0);
    const perMin = minutes > 0 ? (s.count / minutes).toFixed(1) : "–";
    const labels = Object.entries(s.byLabel)
      .sort((a, b) => b[1].totalMs - a[1].totalMs)
      .map(([name, p]) => `${name} ${p.count} (max ${ms(p.maxMs)} ms)`)
      .join(", ");
    return (
      `js long tasks: ${s.count} (${perMin}/min), p50 ${ms(s.p50Ms)} ms, p99 ${ms(s.p99Ms)} ms, max ${ms(s.maxMs)} ms, ` +
      `${((s.totalMs / Math.max(1, s.spanMs)) * 100).toFixed(2)} % of the time; ${labels}`
    );
  }
}

/** The app's one instance: the services label their work on it, the runtime starts it and writes its drive line. */
export const jsLongTasks = new LongTasks();
