// The app process in the trip log (docs/TRIP-LOGGER-SPEC.md §4.4): every 5 s what it uses (`app_stats`), and at a
// trip's start how it was launched, how the run before it ended, and what the OS reported since (iOS MetricKit,
// Android's exit history). A process the OS ends can't log it; the next one does.

import type {
  HealthReport,
  LaunchInfo,
  NativeProcessStats,
  PreviousRun,
} from "../../modules/sensor-capture/src/SensorCaptureModule";
import { APP_STATE_CODES, THERMAL_CODES, type AppStatsRecord } from "@/triplog/schema";

export const APP_STATS_EVERY_MS = 5000;
/** A wake this soon after the process started is what started it. */
export const WOKEN_WITHIN_S = 60;

export interface AppHealthDeps {
  launchInfo(): LaunchInfo;
  processStats(appState: string, context: string): Promise<NativeProcessStats>;
  takeReports(): HealthReport[];
  onMemoryWarning(listener: (level?: string) => void): () => void;
  appState(): string;
  /** What the app is doing, kept with the heartbeat (e.g. "recording u37h65"). */
  context(): string;
  nowUs(): number;
  record(r: AppStatsRecord): void;
  note(text: string): void;
  /** An ending worth knowing about without the log (Sentry). */
  report(message: string, extra: Record<string, unknown>): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export class AppHealth {
  private launch: LaunchInfo;
  private timer: unknown = null;
  private offWarning: (() => void) | null = null;
  private last: { cpuS: number; uptimeUs: number } | null = null;
  private stats: NativeProcessStats | null = null;
  /** The previous run and the OS reports go into the first trip of this process only. */
  private toldPrevious = false;

  constructor(private readonly deps: AppHealthDeps) {
    this.launch = deps.launchInfo();
  }

  start(): void {
    if (this.timer) return;
    const prev = this.launch.previous;
    if (prev && endedMidTrip(prev)) {
      this.deps.report("app ended mid-trip without notice", {
        appState: prev.appState,
        footprintMb: prev.footprintMb,
        headroomMb: prev.headroomMb,
        thermal: prev.thermal,
        memoryWarnings: prev.memoryWarnings,
        secondsBeforeLaunch: Math.round((this.launch.wallMs - prev.wallMs) / 1000),
        launchedInBackground: this.launch.inBackground,
        launchReasons: this.launch.reasons.join(","),
      });
    }
    this.offWarning = this.deps.onMemoryWarning((level) => {
      const s = this.stats;
      const now = s ? `; ${formatMemory(s.footprintMb, s.headroomMb)} at the last check` : "";
      this.deps.note(`app memory warning${level ? ` (${level})` : ""}${now}`);
    });
    this.timer = this.deps.setInterval(() => void this.poll(), APP_STATS_EVERY_MS);
    void this.poll();
  }

  stop(): void {
    if (this.timer) this.deps.clearInterval(this.timer);
    this.timer = null;
    this.offWarning?.();
    this.offWarning = null;
  }

  /** What woke this process (Android's companion wake): a reason in the launch note when the wake is what started it. */
  woken(how: string): void {
    const ageS = (this.deps.nowUs() - this.launch.uptimeUs) / 1e6;
    if (!this.launch.inBackground || ageS > WOKEN_WITHIN_S || this.launch.reasons.includes(how)) return;
    this.launch = { ...this.launch, reasons: [...this.launch.reasons, how] };
  }

  /** A trip's log is open: how this process came to be, and the first time, how the one before it ended. */
  tripStarted(): void {
    const ageS = (this.deps.nowUs() - this.launch.uptimeUs) / 1e6;
    this.deps.note(launchNote(this.launch, ageS));
    if (this.toldPrevious) return;
    this.toldPrevious = true;
    if (this.launch.previous) this.deps.note(previousRunNote(this.launch.previous, this.launch.wallMs));
    for (const r of this.deps.takeReports()) this.deps.note(reportNote(r));
  }

  private async poll(): Promise<void> {
    const appState = this.deps.appState();
    let s: NativeProcessStats;
    try {
      s = await this.deps.processStats(appState, this.deps.context());
    } catch {
      return;
    }
    this.stats = s;
    const nowUs = this.deps.nowUs();
    const cpuPct = this.last && nowUs > this.last.uptimeUs ? (100 * (s.cpuS - this.last.cpuS)) / ((nowUs - this.last.uptimeUs) / 1e6) : NaN;
    this.last = { cpuS: s.cpuS, uptimeUs: nowUs };
    this.deps.record({
      timestampUs: Math.round(nowUs),
      footprintMb: s.footprintMb,
      headroomMb: s.headroomMb,
      cpuPct,
      thermal: (THERMAL_CODES as readonly string[]).includes(s.thermal) ? s.thermal : "nominal",
      appState: (APP_STATE_CODES as readonly string[]).includes(appState) ? (appState as AppStatsRecord["appState"]) : "unknown",
      lowPower: s.lowPower,
    });
  }
}

/** The run before was recording and nothing told it it would end: killed, crashed or swiped away mid-drive. */
export function endedMidTrip(prev: PreviousRun): boolean {
  return prev.context.startsWith("recording") && prev.willTerminateWallMs === undefined;
}

export function launchNote(launch: LaunchInfo, ageS: number): string {
  const how = launch.inBackground ? `in the background${launch.reasons.length ? ` (${launch.reasons.join(", ")})` : ""}` : "in front";
  return `app launched ${Math.round(ageS)} s before this, ${how}`;
}

export function previousRunNote(prev: PreviousRun, launchWallMs: number): string {
  const parts = [`previous run: last seen ${formatDuration((launchWallMs - prev.wallMs) / 1000)} before this launch`, prev.appState];
  if (prev.context) parts.push(prev.context);
  const memory = formatMemory(prev.footprintMb, prev.headroomMb);
  if (memory) parts.push(memory);
  if (prev.thermal && prev.thermal !== "nominal") parts.push(`thermal ${prev.thermal}`);
  if (prev.memoryWarnings > 0) parts.push(`${prev.memoryWarnings} memory warning${prev.memoryWarnings > 1 ? "s" : ""}`);
  const end =
    prev.willTerminateWallMs !== undefined
      ? `the OS said it would end it ${formatDuration((prev.willTerminateWallMs - prev.wallMs) / 1000)} after`
      : "ended without notice";
  return `${parts.join(", ")}; ${end}`;
}

export function reportNote(r: HealthReport): string {
  switch (r.kind) {
    case "exits": {
      const counts = [
        ...Object.entries(r.foreground).filter(([, n]) => n > 0).map(([k, n]) => `in front ${words(k)} ${n}`),
        ...Object.entries(r.background).filter(([, n]) => n > 0).map(([k, n]) => `background ${words(k)} ${n}`),
      ];
      return `iOS exits ${utc(r.fromMs)} to ${utc(r.toMs)}: ${counts.length ? counts.join(", ") : "none"}`;
    }
    case "crash": {
      const parts = [
        r.signal !== undefined ? `signal ${r.signal}` : null,
        r.exceptionType !== undefined ? `exception type ${r.exceptionType}` : null,
        r.exceptionCode !== undefined ? `code ${r.exceptionCode}` : null,
        r.terminationReason ? `"${r.terminationReason}"` : null,
        r.build ? `build ${r.build}` : null,
      ].filter((p) => p !== null);
      return `iOS crash report ${utc(r.atMs)}: ${parts.join(", ") || "no detail"}`;
    }
    case "hang":
      return `iOS hang report ${utc(r.atMs)}: ${r.seconds.toFixed(1)} s`;
    case "cpu":
      return `iOS CPU report ${utc(r.atMs)}: ${Math.round(r.cpuSeconds)} s of CPU in ${Math.round(r.sampledSeconds)} s`;
    case "exit": {
      const memory = [r.pssMb !== undefined ? `${Math.round(r.pssMb)} MB PSS` : null, r.rssMb !== undefined ? `${Math.round(r.rssMb)} MB RSS` : null].filter(Boolean);
      return `Android exit ${utc(r.atMs)}: ${r.reason}, ${r.importance}${memory.length ? `, ${memory.join(", ")}` : ""}${r.description ? `; ${r.description}` : ""}`;
    }
  }
}

function formatMemory(footprintMb: number, headroomMb: number): string {
  const parts: string[] = [];
  if (Number.isFinite(footprintMb) && footprintMb >= 0) parts.push(`${Math.round(footprintMb)} MB`);
  if (Number.isFinite(headroomMb) && headroomMb >= 0) parts.push(`${Math.round(headroomMb)} MB to spare`);
  return parts.join(", ");
}

function formatDuration(s: number): string {
  if (!Number.isFinite(s)) return "?";
  if (Math.abs(s) < 120) return `${Math.round(s)} s`;
  if (Math.abs(s) < 7200) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

/** camelCase counter names in words: `memoryPressure` → "memory pressure". */
function words(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function utc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
