// A car's CAN profile on probation (VEHICLE-LINK-SPEC §16.5): the first time a profile is chosen for a VIN, the
// navigator keeps OBD's speed, the polls run at their rate and the monitor listens in their breaks, while the check
// (`SpeedProbation`) compares the decoded speed with the polls. A pass moves the car to the wheels mid-drive and is
// kept per VIN; a fail keeps the car on OBD (the monitor off) until the profile changes or the driver turns the
// wheels' speed off and on. Each verdict, and a probation the link couldn't carry, is reported once (anonymous).
import { speedKey } from "@/nav/odometry/can/discovery";
import { OPENDBC_COMMIT, type Profile } from "@/nav/odometry/can/profile";
import { SpeedProbation, type ProbationStats, type ProbationVerdict } from "@/nav/odometry/can/probation";
import type { CanSpeed } from "@/nav/odometry/can/can-speed";
import type { CanFrame } from "@/obd/can-monitor";
import type { CanWindow } from "@/obd/can-shadow";
import type { SpeedSample } from "@/obd/types";
import type { KeyValueStore } from "@/obd/vehicle-link-core";

/** VIN → the profile's verdict. */
export const CAN_PROBATION_KEY = "vehicleLink.canProbation";
/** Reports already sent: `report key` → true, so a car's verdict goes out once per build of the app and adapter. */
export const CAN_PROBATION_REPORTED_KEY = "vehicleLink.canProbationReported";

type VerdictRecord = Record<string, { profile: string; pass: boolean; reason: string | null }>;

/**
 * A poll this late while the car moves (2 Hz: due every 0.5 s) is one the monitor held up. Two in a session end the
 * probation: the navigator must not lose its speed for a check. Longer gaps are the link lost, not a slow poll.
 */
const LATE_US = 2_000_000;
const LOST_US = 10_000_000;
const LATE_LIMIT = 2;
/** A break between two windows longer than this isn't a poll's (the monitor stopped, the car switched off). */
const BREAK_MAX_US = 3_000_000;

/**
 * Polls held up by the monitor while the car moves (§16.5–16.6): `add` each OBD speed sample; true once `LATE_LIMIT`
 * of them came over `LATE_US` after the one before (under `LOST_US`: longer is the link lost, not a slow poll).
 */
export class LatePollGuard {
  private last: { rxUs: number; raw: number } | null = null;
  late = 0;

  add(s: SpeedSample): boolean {
    const prev = this.last;
    this.last = { rxUs: s.rxUs, raw: s.raw };
    if (!prev || prev.raw < 1) return false;
    const gap = s.rxUs - prev.rxUs;
    return gap > LATE_US && gap < LOST_US && ++this.late >= LATE_LIMIT;
  }

  reset(): void {
    this.last = null;
    this.late = 0;
  }
}

export type CanProbationStatus =
  | { state: "idle" }
  | { state: "checking"; profile: string }
  | { state: "passed"; profile: string }
  | { state: "failed"; profile: string; reason: string }
  /** The link couldn't carry the check (polls held up): OBD for this session, tried again next time. */
  | { state: "aborted"; profile: string };

/** What goes to the anonymous report (no VIN, no position, no time beyond the report's own). */
export interface CanProbationReport {
  outcome: "pass" | "fail" | "aborted";
  reason: string | null;
  make: string;
  profile: string;
  opendbc: string;
  /** From a DBC no carstate reads (mappings.ts `dbcOnly`). */
  dbcOnly: boolean;
  /** "wheels" or "speed" (a profile without wheel speeds). */
  from: "wheels" | "speed";
  stats: ProbationStats;
  /** Seconds of the drive from the start of probation to the verdict. */
  durationS: number;
  /** The profile's ids heard, with frames per second of listening: "201:100 4B0:50". */
  ids: string;
  /** Breaks between listening windows (a poll and the monitor's stop and restart), ms. */
  breakP50Ms: number;
  breakP90Ms: number;
  /** Share of the probation the monitor listened. */
  listenShare: number;
  latePolls: number;
}

export interface CanProbationDeps {
  vin(): string | null;
  nowUs(): number;
  /** The link's speed samples: the OBD polls among them are the reference. */
  onSpeed(listener: (s: SpeedSample) => void): () => void;
  /** The feed's every decoded CAN speed sample. */
  onCanSpeed(listener: (s: CanSpeed) => void): () => void;
  onFrames(listener: (frames: CanFrame[]) => void): () => void;
  onWindow(listener: (w: CanWindow) => void): () => void;
  /** The link: CAN speed carries the navigation (true) or only the check (false). */
  setTrusted(on: boolean): void;
  /** The feed: the passed profile's speed goes to the navigator now. */
  promote(): void;
  /** The monitor off for this session: the car stays on OBD. */
  stopListening(): void;
  /** Adapter model and the app's build (its JS's commit), for the report's once-only key. */
  reportScope(): string;
  /** The driver's setting: false, nothing is reported, nor taken for reported. Absent: on. */
  reportsOn?(): boolean;
  report(r: CanProbationReport): void;
  store: KeyValueStore;
  note(text: string): void;
  onStatus?(status: CanProbationStatus): void;
}

export class CanProbation {
  private status_: CanProbationStatus = { state: "idle" };
  private check: SpeedProbation | null = null;
  private profile: Profile | null = null;
  private vin: string | null = null;
  private startUs = 0;
  private late = new LatePollGuard();
  private frames = new Map<number, number>();
  private windows: { startUs: number; endUs: number }[] = [];
  private off: (() => void) | null = null;

  constructor(private readonly deps: CanProbationDeps) {}

  get status(): CanProbationStatus {
    return this.status_;
  }

  start(): void {
    if (this.off) return;
    const offs = [
      this.deps.onSpeed((s) => this.onObd(s)),
      this.deps.onCanSpeed((s) => this.check?.addCan(s)),
      this.deps.onFrames((frames) => this.onFrames(frames)),
      this.deps.onWindow((w) => this.check && this.windows.push({ startUs: w.startUs, endUs: w.endUs })),
    ];
    this.off = () => offs.forEach((o) => o());
  }

  stop(): void {
    this.off?.();
    this.off = null;
    this.end();
    this.set({ state: "idle" });
  }

  /** Cars whose profile failed get another probation (the driver turned the wheels' speed on again). */
  forgetFailed(): void {
    const kept = Object.fromEntries(Object.entries(this.records()).filter(([, r]) => r.pass));
    this.deps.store.setJson(CAN_PROBATION_KEY, kept);
  }

  /**
   * The feed chose a profile for the car (`CanSpeedFeed.admit`): true when its speed may carry the navigation now (it
   * passed on this VIN before); false while on probation or after a fail.
   */
  admit(profile: Profile): boolean {
    this.end();
    const vin = this.deps.vin();
    this.vin = vin;
    this.profile = profile;
    const record = vin ? this.records()[vin] : undefined;
    // A find's wheels' order, learned since, changes no speed: its pass holds.
    const same = record !== undefined && speedKey(record.profile) === speedKey(profile.key);
    if (same && record.pass) {
      this.deps.setTrusted(true);
      this.set({ state: "passed", profile: profile.key });
      return true;
    }
    this.deps.setTrusted(false);
    if (same && !record.pass) {
      this.deps.note(`can probation: ${profile.key} failed on an earlier drive (${record.reason}), OBD speed stays`);
      // The monitor off before the status: what the status starts (the search going on, §16.6) sets its own ids.
      this.deps.stopListening();
      this.set({ state: "failed", profile: profile.key, reason: record.reason ?? "" });
      return false;
    }
    this.check = new SpeedProbation();
    this.startUs = this.deps.nowUs();
    this.set({ state: "checking", profile: profile.key });
    this.deps.note(`can probation: checking ${profile.key} against OBD speed, the navigator stays on OBD`);
    return false;
  }

  private onObd(s: SpeedSample): void {
    if (s.source === "can" || !this.check) return;
    if (this.late.add(s)) {
      this.abort(`${this.late.late} polls over ${LATE_US / 1e6} s late while moving`);
      return;
    }
    this.check.addObd(s.tUs, s.raw);
    const v = this.check.verdict;
    if (v) this.decide(v);
  }

  private onFrames(frames: CanFrame[]): void {
    if (!this.check) return;
    for (const f of frames) this.frames.set(f.id, (this.frames.get(f.id) ?? 0) + 1);
  }

  private decide(v: ProbationVerdict): void {
    const profile = this.profile!;
    const report = this.reportOf(v.pass ? "pass" : "fail", v.reason, v.stats);
    this.end();
    if (this.vin) this.deps.store.setJson(CAN_PROBATION_KEY, { ...this.records(), [this.vin]: { profile: profile.key, pass: v.pass, reason: v.reason } });
    const s = v.stats;
    const numbers = `scale ${s.scale.toFixed(3)}, spread ${s.spread.toFixed(3)}, r ${s.correlation.toFixed(4)}, ${s.scalePairs} pairs`;
    if (v.pass) {
      this.deps.setTrusted(true);
      this.deps.promote();
      this.set({ state: "passed", profile: profile.key });
      this.deps.note(`can probation: ${profile.key} passed (${numbers})`);
    } else {
      this.deps.note(`can probation: ${profile.key} failed: ${v.reason} (${numbers}), OBD speed stays`);
      // Off before the status, as in `admit`: a found layout's fail starts the search's next ids (§16.6).
      this.deps.stopListening();
      this.set({ state: "failed", profile: profile.key, reason: v.reason! });
    }
    this.send(report);
  }

  private abort(why: string): void {
    const profile = this.profile!;
    const report = this.reportOf("aborted", "late polls", this.check!.stats());
    this.end();
    this.deps.note(`can probation: stopped, ${why}; OBD speed stays this drive`);
    this.deps.stopListening();
    this.set({ state: "aborted", profile: profile.key });
    this.send(report);
  }

  private reportOf(outcome: CanProbationReport["outcome"], reason: string | null, stats: ProbationStats): CanProbationReport {
    const profile = this.profile!;
    const breaks: number[] = [];
    let listenUs = 0;
    for (let i = 0; i < this.windows.length; i++) {
      const w = this.windows[i];
      listenUs += w.endUs - w.startUs;
      const next = this.windows[i + 1];
      if (next && next.startUs - w.endUs > 0 && next.startUs - w.endUs < BREAK_MAX_US) breaks.push((next.startUs - w.endUs) / 1000);
    }
    const spanUs = this.windows.length ? this.windows.at(-1)!.endUs - this.windows[0].startUs : 0;
    const listenS = listenUs / 1e6;
    const ids = [...this.frames.entries()]
      .filter(([id]) => profile.ids.has(id))
      .sort(([a], [b]) => a - b)
      .map(([id, n]) => `${id.toString(16).toUpperCase()}:${listenS > 0 ? Math.round(n / listenS) : 0}`)
      .join(" ");
    return {
      outcome,
      reason,
      make: profile.make,
      profile: profile.key,
      opendbc: OPENDBC_COMMIT,
      dbcOnly: profile.dbcOnly,
      from: profile.wheels ? "wheels" : "speed",
      stats,
      durationS: Math.round((this.deps.nowUs() - this.startUs) / 1e6),
      ids,
      breakP50Ms: Math.round(quantile(breaks, 0.5)),
      breakP90Ms: Math.round(quantile(breaks, 0.9)),
      listenShare: spanUs > 0 ? Math.round((100 * listenUs) / spanUs) / 100 : 0,
      latePolls: this.late.late,
    };
  }

  /** Once per car profile, outcome, adapter model and app build: a fail tried again on every drive isn't news. */
  private send(r: CanProbationReport): void {
    if (this.deps.reportsOn && !this.deps.reportsOn()) return;
    const key = [r.profile, r.outcome, r.reason ?? "", this.deps.reportScope()].join("|");
    const reported = this.deps.store.getJson<Record<string, true>>(CAN_PROBATION_REPORTED_KEY) ?? {};
    if (reported[key]) return;
    this.deps.store.setJson(CAN_PROBATION_REPORTED_KEY, { ...reported, [key]: true });
    this.deps.report(r);
  }

  /** The check over (a verdict, aborted, another profile or the session's end): its counters go. */
  private end(): void {
    this.check = null;
    this.late.reset();
    this.frames = new Map();
    this.windows = [];
  }

  private records(): VerdictRecord {
    return this.deps.store.getJson<VerdictRecord>(CAN_PROBATION_KEY) ?? {};
  }

  private set(status: CanProbationStatus): void {
    this.status_ = status;
    this.deps.onStatus?.(status);
  }
}

/**
 * The report as Sentry log attributes: flat strings and numbers. Shares in per cent with 2 decimals at most, since the
 * scrubber (src/config/sentry-scrub.ts) drops finer decimals as possible coordinates. -1: not known.
 */
export function probationReportAttributes(r: CanProbationReport, protocol: string, adapter: string): Record<string, string | number> {
  const s = r.stats;
  const pct = (x: number) => (Number.isFinite(x) ? Math.round(x * 10_000) / 100 : -1);
  return {
    feature: "can-probation",
    outcome: r.outcome,
    reason: r.reason ?? "",
    make: r.make,
    profile: r.profile,
    opendbc: r.opendbc,
    dbc_only: r.dbcOnly ? "yes" : "no",
    speed_from: r.from,
    protocol,
    adapter_model: adapter,
    ids: r.ids,
    scale_pct: pct(s.scale),
    spread_pct: pct(s.spread),
    correlation_pct: pct(s.correlation),
    range_kph: Number.isFinite(s.rangeKph) ? Math.round(s.rangeKph) : -1,
    scale_pairs: s.scalePairs,
    stand_pairs: s.standPairs,
    stand_pct: pct(s.standShare),
    wheel_off_pct: s.wheelOff === null ? -1 : pct(s.wheelOff),
    duration_s: r.durationS,
    break_p50_ms: r.breakP50Ms,
    break_p90_ms: r.breakP90Ms,
    listen_pct: pct(r.listenShare),
    late_polls: r.latePolls,
  };
}

function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
