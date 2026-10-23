// Finding a car's speed on its CAN bus without a profile (VEHICLE-LINK-SPEC §16.6). When the VIN's make has no profile,
// or none of its profiles' ids is heard (§16.4), and the adapter can monitor: once, at stops with the engine running, a
// survey of the ids at the OBD port, a slice of the id space at a time (every id at once overruns the link); then,
// while the car drives, the monitor listens to as many of them as the link carries while the polls keep their rate,
// and `SpeedFieldFinder` fits their fields against OBD speed. A find becomes the car's own profile
// (`discoveredProfile`), which goes through probation (§16.5) like any other before it carries the navigation. Kept per
// VIN, so a search goes on over several drives and a find is used at once on the next. A find of four wheels gets its
// order from the phone's gyro (`CanWheelOrder`), used from the drive after. Reported once, anonymously.
import { discoveredProfile, fieldKey, foundKey, SpeedFieldFinder, tidy, type DiscoveredSpeed } from "@/nav/odometry/can/discovery";
import { FrameRetimer } from "@/nav/odometry/can/frame-timing";
import { makeForVin, type Profile } from "@/nav/odometry/can/profile";
import type { WheelOrderVerdict } from "@/nav/odometry/can/wheel-order";
import { inSlice, type CanFrame, type CanSurvey, type IdSlice } from "@/obd/can-monitor";
import type { SpeedSample } from "@/obd/types";
import type { KeyValueStore } from "@/obd/vehicle-link-core";
import type { CanAutoStatus } from "./can-auto-ids";
import { LatePollGuard } from "./can-probation";

/** VIN → the search: candidate ids (the survey's, ranked), those tried, the find, or done with none. */
export const CAN_DISCOVERY_KEY = "vehicleLink.canDiscovery";
/** Reports already sent (`report key` → true). */
export const CAN_DISCOVERY_REPORTED_KEY = "vehicleLink.canDiscoveryReported";

interface SearchRecord {
  /** Slices of the id space still to survey; none left: `candidates` is the survey's outcome. */
  slices: IdSlice[];
  /** Frames per second of each id the slices heard that may be a speed (hex id → Hz). */
  hz: Record<string, number>;
  /** Ids the survey's slices heard at all, at any rate, but diagnostic answers. Absent: before it was counted. */
  heard?: number;
  /** Surveys that heard no id at all. */
  emptySurveys?: number;
  candidates: number[];
  tried: number[];
  found: DiscoveredSpeed | null;
  done: boolean;
}

/** The survey's first slices: the id space in eighths (11-bit: 0x000–0x0FF, …), each split while too busy. */
const FIRST_SLICES: IdSlice[] = Array.from({ length: 8 }, (_, prefix) => ({ prefix, bits: 3 }));
/** One slice listened to this long, at a stop, the polls waiting (a poll between two slices). */
const SLICE_MS = 1000;
/** A slice that sent this share of what the link carries (or `BUFFER FULL`): its rates are the link's, split it. */
const SATURATED = 0.8;
/**
 * Frames per second the link carries out of the monitor, by transport: over BLE the vLinker carried ~150 of five
 * ids' 370; the MX+ (MFi, classic Bluetooth) carried those five in the polls' breaks (VEHICLE-LINK-SPEC §5).
 */
export function linkCapacity(transport: string | null | undefined): number {
  return transport === "ble" ? 150 : 400;
}
/** Ids listened to at once at most (the adapter's pass filters, as the ids' picking). */
const MAX_BATCH = 8;
/** Ids sent at least this often are candidates (wheel and speed messages come at 20–100 Hz), at most `MAX_IDS`. */
const MIN_HZ = 10;
const MAX_IDS = 45;
/**
 * A batch none of whose ids is heard in this much listening in a row (from its start, or since one was last heard),
 * with the engine running or the car moving, is passed over: a speed is sent all the time then, and the survey heard
 * them standing. Under the monitor's own 5 s backstop (`DEAF_US` in can-shadow.ts), as the ids' picking (§16.4).
 * With the engine off at a stop some cars' ABS is quiet: that silence isn't counted, the wheels would be lost for good.
 */
const SILENT_LISTEN_US = 3_000_000;
/** The last poll tells the car stands or moves while it is at most this old. */
const FRESH_US = 2_000_000;
/** A survey that failed is tried again no sooner than this. */
const SURVEY_RETRY_US = 60_000_000;
/**
 * Surveys that heard no id at all before the port is taken for silent (a gateway): one alone is a quiet bus (the engine
 * off with the ECU awake, a frozen RPM reading it running), which nothing can be told from.
 */
const EMPTY_SURVEYS = 2;

export type CanDiscoveryStatus =
  | { state: "idle" }
  /** The survey waits for the car to stand. */
  | { state: "waiting" }
  | { state: "surveying" }
  | { state: "searching"; tried: number; of: number }
  | { state: "found"; profile: string }
  | { state: "none" }
  /** The link couldn't carry the search (polls held up): OBD for this drive, on again next drive. */
  | { state: "aborted" };

export interface CanDiscoveryReport {
  /** `wheels`: the gyro's verdict on a find of four wheels, its order or not four wheels. */
  outcome: "found" | "none" | "aborted" | "wheels";
  make: string;
  candidates: number;
  tried: number;
  found: DiscoveredSpeed | null;
  /** Seconds of the drive this batch's search took (the last batch's); for `wheels`, of driving the gyro learned from. */
  durationS: number;
  latePolls: number;
  wheels?: WheelOrderVerdict;
}

export interface CanDiscoveryDeps {
  vin(): string | null;
  nowUs(): number;
  canAuto(): CanAutoStatus;
  /** The adapter can monitor on this car (an STN on CAN), and the link polls. */
  canMonitor(): boolean;
  /**
   * The engine runs, not only the ECU awake: with the engine off some cars' ABS is quiet. A survey slice only then
   * (with the car standing by the last poll), and a silent batch's listening counted then (or moving).
   */
  engineRunning(): boolean;
  survey(slice: IdSlice, durationMs: number): Promise<CanSurvey>;
  /** Frames per second the link carries out of the monitor (`linkCapacity`). */
  capacity(): number;
  listen(ids: number[] | null): void;
  onFrames(listener: (frames: CanFrame[]) => void): () => void;
  /** Each listening window, at its end: a break in the frames (frame-timing.ts), and how long the batch was listened to. */
  onWindow(listener: (w: { startUs: number; endUs: number }) => void): () => void;
  onSpeed(listener: (s: SpeedSample) => void): () => void;
  setTrusted(on: boolean): void;
  /** The find, as the car's profile: the monitor on its id, the feed to match it. Null: none any more. */
  found(profile: Profile | null): void;
  reportScope(): string;
  /** The driver's setting: false, nothing is reported, nor taken for reported. Absent: on. */
  reportsOn?(): boolean;
  report(r: CanDiscoveryReport): void;
  store: KeyValueStore;
  note(text: string): void;
  onStatus?(status: CanDiscoveryStatus): void;
}

export class CanDiscovery {
  private status_: CanDiscoveryStatus = { state: "idle" };
  private off: (() => void) | null = null;
  private vin: string | null = null;
  private finder: SpeedFieldFinder | null = null;
  private batch: number[] = [];
  private batchStartUs = 0;
  private heardInBatch = false;
  private heardInWindow = false;
  /** Listening to the batch in a row with none of its ids heard (counted with the engine running or moving). */
  private silentUs = 0;
  /** A survey slice running; a poll since the last one ended (a poll comes between two slices). */
  private sliceRunning = false;
  private polledSinceSlice = true;
  /** The last OBD poll, when it came (the link's snapshot may not have it yet when its listeners run). */
  private lastObd: { us: number; kph: number } | null = null;
  private late = new LatePollGuard();
  /** The link delivers frames in bursts: each id laid on its period, as the feed and replay do. */
  private retimer = new FrameRetimer();
  private profile_: Profile | null = null;
  private surveyFailedUs = -Infinity;
  /** The car moved this drive (a poll over 0): its engine runs and its bus is awake, whatever the RPM read. */
  private moved = false;

  constructor(private readonly deps: CanDiscoveryDeps) {}

  get status(): CanDiscoveryStatus {
    return this.status_;
  }

  /** The car's profile from a find, for the feed's matching. */
  get profile(): Profile | null {
    return this.profile_;
  }

  /** The car's find as kept (with its wheels' order once learned), while one is in use. */
  get find(): DiscoveredSpeed | null {
    if (this.status_.state !== "found" || !this.vin) return null;
    return this.records()[this.vin]?.found ?? null;
  }

  /**
   * The gyro's verdict on the find's four wheels (`CanWheelOrder`). An order is kept with the find and used from the
   * next drive (`nextDrive`): a drive replays on the one profile its notes name.
   */
  setOrder(find: DiscoveredSpeed, verdict: WheelOrderVerdict, learnedS: number): void {
    const record = this.vin ? this.records()[this.vin] : undefined;
    if (!record?.found || foundKey(record.found) !== foundKey(find)) return;
    const next = verdict.order ? { ...record, found: { ...record.found, order: verdict.order } } : record;
    this.save(next);
    this.send({ outcome: "wheels", record: next, durationS: Math.round(learnedS), wheels: verdict });
  }

  /**
   * Between drives (ignition off): the next survey waits for the car to move again; a find whose order was learned
   * meanwhile takes the place of the one in use.
   */
  nextDrive(): void {
    this.moved = false;
    const found = this.find;
    if (found && this.profile_?.key !== foundKey(found)) this.useFound(found);
  }

  /** The monitor's ids are the search's: the feed must not take its frames for a profile. */
  get searching(): boolean {
    return this.status_.state === "searching" || this.status_.state === "surveying";
  }

  start(): void {
    if (this.off) return;
    const offs = [
      this.deps.onFrames((f) => this.onFrames(f)),
      this.deps.onWindow((w) => this.onWindow(w)),
      this.deps.onSpeed((s) => this.onObd(s)),
    ];
    this.off = () => offs.forEach((o) => o());
    this.refresh();
  }

  stop(): void {
    this.off?.();
    this.off = null;
    this.endBatch();
    this.vin = null;
    this.setProfile(null);
    this.set({ state: "idle" });
  }

  /** Searches that found nothing get another (the driver turned the wheels' speed on again). */
  forgetNone(): void {
    const kept = Object.fromEntries(Object.entries(this.records()).filter(([, r]) => r.found));
    this.deps.store.setJson(CAN_DISCOVERY_KEY, kept);
  }

  /** The find failed probation (§16.5): not the car's speed after all. The search goes on with the ids left. */
  rejectFound(): void {
    const record = this.vin ? this.records()[this.vin] : undefined;
    if (!record?.found) return;
    this.deps.note(`can discovery: ${record.found.id.toString(16).toUpperCase()} failed probation, searching on`);
    this.save({ ...record, found: null });
    this.setProfile(null);
    this.set({ state: "idle" });
    this.refresh();
  }

  /** On every change of the link or of the ids' picking: whether a search is due, and its next step. */
  refresh(): void {
    if (!this.off) return;
    const vin = this.deps.vin();
    if (vin !== this.vin) {
      this.endBatch();
      this.vin = vin;
      this.moved = false;
      this.setProfile(null);
      this.set({ state: "idle" });
    }
    const auto = this.deps.canAuto().state;
    const due = !!vin && (auto === "unknown-make" || auto === "none") && this.deps.canMonitor();
    if (!due) {
      if (this.searching || this.status_.state === "waiting") {
        // The navigator's speed back to what the link has. The monitor's ids are left as they are: the ids' picking,
        // whose change made the search not due, sets its own before it tells (§16.4).
        if (this.finder) this.deps.setTrusted(true);
        this.endBatch();
        this.set({ state: "idle" });
      }
      return;
    }
    const s = this.status_.state;
    if (s === "found" || s === "none" || s === "aborted" || s === "searching" || this.sliceRunning) return;
    let record = this.records()[vin!];
    // Concluded from a survey that may have heard nothing (before `heard` was counted, 2026-10-23): surveyed again.
    if (record?.done && !record.found && !record.candidates.length && record.heard === undefined) {
      record = { slices: FIRST_SLICES, hz: {}, heard: 0, candidates: [], tried: [], found: null, done: false };
      this.save(record);
    }
    if (record?.found) {
      this.useFound(record.found);
      return;
    }
    if (record?.done) {
      this.set({ state: "none" });
      return;
    }
    if (record && !record.slices.length) {
      this.nextBatch();
      return;
    }
    // A poll between two slices: the polls get their turn, and tell whether the car still stands. Until it comes, the
    // poll before the slice is too old to tell: the status stays.
    if (!this.polledSinceSlice) return;
    if (!this.moved || !this.standing() || this.deps.nowUs() - this.surveyFailedUs < SURVEY_RETRY_US) {
      if (s !== "waiting") this.set({ state: "waiting" });
      return;
    }
    void this.surveySlice(record ?? { slices: FIRST_SLICES, hz: {}, heard: 0, candidates: [], tried: [], found: null, done: false });
  }

  /** One slice of the survey: its ids' rates kept, or split in two when it sent more than the link carries. */
  private async surveySlice(record: SearchRecord): Promise<void> {
    const vin = this.vin!;
    const slice = record.slices[0];
    this.sliceRunning = true;
    if (this.status_.state !== "surveying") {
      this.set({ state: "surveying" });
      this.deps.note(`can discovery: surveying the ids at the port while the car stands, ${record.slices.length} slices left`);
    }
    let survey: CanSurvey;
    try {
      survey = await this.deps.survey(slice, SLICE_MS);
    } catch (e) {
      this.surveyFailedUs = this.deps.nowUs();
      this.deps.note(`can discovery: survey failed (${(e as Error).message}), tried again at a stop in a minute`);
      if (this.vin === vin && this.status_.state === "surveying") this.set({ state: "waiting" });
      return;
    } finally {
      this.sliceRunning = false;
      this.polledSinceSlice = false;
    }
    if (this.vin !== vin || this.status_.state !== "surveying") return;
    const width = survey.idDigits === 3 ? 11 : 29;
    const heard = survey.ids.filter((x) => inSlice(x.id, slice, width));
    const total = heard.reduce((sum, x) => sum + x.hz, 0);
    const busy = survey.bufferFull > 0 || total >= SATURATED * this.deps.capacity();
    let next: SearchRecord;
    // One id busier than the link alone: no split shares it out, its rate is a lower bound.
    if (busy && heard.length > 1 && slice.bits < width) {
      const halves = [0, 1].map((half) => ({ prefix: slice.prefix * 2 + half, bits: slice.bits + 1 }));
      next = { ...record, slices: [...halves, ...record.slices.slice(1)] };
    } else {
      const hz = { ...record.hz };
      for (const x of heard) {
        if (x.hz < MIN_HZ || Math.max(...x.lengths) < 2 || isDiagnostic(x.id, survey.idDigits)) continue;
        hz[x.id.toString(16)] = Math.round(x.hz * 10) / 10;
      }
      const broadcast = heard.filter((x) => !isDiagnostic(x.id, survey.idDigits)).length;
      next = { ...record, hz, heard: (record.heard ?? 0) + broadcast, slices: record.slices.slice(1) };
    }
    if (next.slices.length) {
      this.save(next);
      return;
    }
    if (!next.heard) {
      const empty = (record.emptySurveys ?? 0) + 1;
      if (empty < EMPTY_SURVEYS) {
        // Nothing heard is a quiet bus, not a car without a speed: again once the car has driven.
        this.save({ ...next, slices: FIRST_SLICES, hz: {}, heard: 0, emptySurveys: empty });
        this.moved = false;
        this.set({ state: "waiting" });
        this.deps.note("can discovery: the survey heard no id at the port (a quiet bus), surveyed again once the car has driven");
        return;
      }
      this.deps.note(`can discovery: no id heard at the port in ${empty} surveys (a gateway)`);
      next = { ...next, emptySurveys: empty };
    }
    const candidates = Object.entries(next.hz)
      .sort(([a, x], [b, y]) => y - x || parseInt(a, 16) - parseInt(b, 16))
      .slice(0, MAX_IDS)
      .map(([id]) => parseInt(id, 16));
    this.save({ ...next, candidates });
    this.deps.note(`can discovery: ${candidates.length} candidates at the port: ${hexIds(candidates)}`);
    this.nextBatch();
  }

  private nextBatch(): void {
    const record = this.records()[this.vin!]!;
    const left = record.candidates.filter((id) => !record.tried.includes(id));
    if (!left.length) {
      this.save({ ...record, done: true });
      this.deps.listen(null);
      this.deps.setTrusted(true);
      this.set({ state: "none" });
      this.deps.note(`can discovery: no speed among ${record.candidates.length} ids, OBD speed stays`);
      this.send({ outcome: "none", record, durationS: 0 });
      return;
    }
    // As many as the link carries by the survey's rates, busiest first: at least one.
    const capacity = this.deps.capacity();
    let sum = 0;
    this.batch = [];
    for (const id of left) {
      const hz = record.hz[id.toString(16)] ?? capacity;
      if (this.batch.length && sum + hz > capacity) continue;
      this.batch.push(id);
      sum += hz;
      if (this.batch.length >= MAX_BATCH) break;
    }
    this.finder = new SpeedFieldFinder(this.batch);
    this.retimer = new FrameRetimer();
    this.batchStartUs = this.deps.nowUs();
    this.heardInBatch = false;
    this.heardInWindow = false;
    this.silentUs = 0;
    this.late.reset();
    // The polls keep their rate while the monitor listens in their breaks: the navigator stays on OBD.
    this.deps.setTrusted(false);
    this.deps.listen(this.batch);
    this.set({ state: "searching", tried: record.tried.length, of: record.candidates.length });
    // Replay's marker too: the frames from here on are the search's, the navigator on OBD (`canPrimaryFromUs`).
    this.deps.note(`can discovery: listening to ${hexIds(this.batch)} for a speed, ${record.tried.length} of ${record.candidates.length} ids tried`);
  }

  /** The car stands with its engine running, by the last poll. */
  private standing(): boolean {
    const o = this.lastObd;
    return this.deps.engineRunning() && o !== null && o.kph === 0 && this.deps.nowUs() - o.us <= FRESH_US;
  }

  private moving(): boolean {
    const o = this.lastObd;
    return o !== null && o.kph > 0 && this.deps.nowUs() - o.us <= FRESH_US;
  }

  private onFrames(frames: CanFrame[]): void {
    if (!this.finder) return;
    for (const f of frames) {
      if (!this.batch.includes(f.id)) continue;
      this.heardInBatch = true;
      this.heardInWindow = true;
      this.finder.addFrame(f.id, this.retimer.retime(f.id, f.rxUs), f.data);
    }
  }

  private onObd(s: SpeedSample): void {
    if (s.source === "can") return;
    this.lastObd = { us: this.deps.nowUs(), kph: s.raw };
    if (s.raw > 0) this.moved = true;
    this.polledSinceSlice = true;
    if (!this.finder) {
      // The survey's next slice, once this poll is in.
      if (this.status_.state === "surveying" || this.status_.state === "waiting") this.refresh();
      return;
    }
    if (this.late.add(s)) {
      this.abort();
      return;
    }
    this.finder.addObd(s.tUs, s.raw);
    const v = this.finder.judge();
    if (v) this.batchDone(v.found);
  }

  /** A window's frames come before its end (can-shadow.ts): whether it heard the batch is known here. */
  private onWindow(w: { startUs: number; endUs: number }): void {
    this.retimer.break();
    if (!this.finder) return;
    const heard = this.heardInWindow;
    this.heardInWindow = false;
    if (heard) {
      this.silentUs = 0;
      return;
    }
    if (!this.deps.engineRunning() && !this.moving()) return;
    this.silentUs += w.endUs - w.startUs;
    if (this.silentUs < SILENT_LISTEN_US) return;
    const s = (this.silentUs / 1e6).toFixed(1);
    this.deps.note(
      this.heardInBatch
        ? `can discovery: ${hexIds(this.batch)} silent for ${s} s of listening after being heard, passed over`
        : `can discovery: ${hexIds(this.batch)} not heard in ${s} s of listening, passed over`,
    );
    this.batchDone(null);
  }

  private batchDone(found: DiscoveredSpeed | null): void {
    const record = this.records()[this.vin!]!;
    const durationS = Math.round((this.deps.nowUs() - this.batchStartUs) / 1e6);
    const next = { ...record, tried: [...record.tried, ...this.batch], found };
    this.save(next);
    const batch = this.batch;
    this.endBatch();
    if (!found) {
      this.deps.note(`can discovery: no speed in ${hexIds(batch)}`);
      this.nextBatch();
      return;
    }
    const fields = tidy(found.fields);
    this.deps.note(`can discovery: speed in ${found.id.toString(16).toUpperCase()}: ${fields.map(fieldKey).join(" ")} (${found.pairs} pairs)`);
    this.send({ outcome: "found", record: next, durationS });
    this.useFound(found);
  }

  private useFound(found: DiscoveredSpeed): void {
    const profile = discoveredProfile(makeForVin(this.vin) ?? "unknown", found);
    this.setProfile(profile);
    this.set({ state: "found", profile: profile.key });
  }

  private abort(): void {
    const record = this.records()[this.vin!]!;
    const late = this.late.late;
    this.endBatch();
    this.deps.listen(null);
    this.deps.setTrusted(true);
    this.set({ state: "aborted" });
    this.deps.note(`can discovery: stopped, ${late} polls late while moving; OBD speed stays this drive`);
    this.send({ outcome: "aborted", record, durationS: 0, latePolls: late });
  }

  private endBatch(): void {
    this.finder = null;
    this.batch = [];
    this.late.reset();
  }

  private setProfile(p: Profile | null): void {
    const changed = this.profile_?.key !== p?.key;
    this.profile_ = p;
    if (changed) this.deps.found(p);
  }

  private send(o: {
    outcome: CanDiscoveryReport["outcome"];
    record: SearchRecord;
    durationS: number;
    latePolls?: number;
    wheels?: WheelOrderVerdict;
  }): void {
    const make = makeForVin(this.vin) ?? "unknown";
    const r: CanDiscoveryReport = {
      outcome: o.outcome,
      make,
      candidates: o.record.candidates.length,
      tried: o.record.tried.length,
      found: o.record.found,
      durationS: o.durationS,
      latePolls: o.latePolls ?? 0,
      ...(o.wheels ? { wheels: o.wheels } : {}),
    };
    const w = o.wheels;
    const wheels = w ? `/${w.order ? w.order.join("") : w.reason}` : "";
    const what = r.found ? `${r.found.id}:${tidy(r.found.fields).map(fieldKey).join("+")}${wheels}` : "";
    if (this.deps.reportsOn && !this.deps.reportsOn()) return;
    const key = [make, r.outcome, what, this.deps.reportScope()].join("|");
    const reported = this.deps.store.getJson<Record<string, true>>(CAN_DISCOVERY_REPORTED_KEY) ?? {};
    if (reported[key]) return;
    this.deps.store.setJson(CAN_DISCOVERY_REPORTED_KEY, { ...reported, [key]: true });
    this.deps.report(r);
  }

  private records(): Record<string, SearchRecord> {
    return this.deps.store.getJson<Record<string, SearchRecord>>(CAN_DISCOVERY_KEY) ?? {};
  }

  private save(record: SearchRecord): void {
    this.deps.store.setJson(CAN_DISCOVERY_KEY, { ...this.records(), [this.vin!]: record });
  }

  private set(status: CanDiscoveryStatus): void {
    this.status_ = status;
    this.deps.onStatus?.(status);
  }
}

/** Diagnostic requests and answers (11-bit 0x7DF–0x7EF; 29-bit 0x18DA/0x18DB…): never a broadcast speed. */
function isDiagnostic(id: number, idDigits: 3 | 8): boolean {
  if (idDigits === 3) return id >= 0x700;
  const pf = (id >>> 16) & 0xff;
  return pf === 0xda || pf === 0xdb;
}

const hexIds = (ids: number[]) => ids.map((id) => id.toString(16).toUpperCase()).join(" ");

/**
 * The report as Sentry log attributes (flat; shares in per cent with at most 2 decimals, which the scrubber keeps).
 * The layout found is the point: a car the app had no profile for, read.
 */
export function discoveryReportAttributes(r: CanDiscoveryReport, protocol: string, adapter: string): Record<string, string | number> {
  const f = r.found;
  const w = r.wheels;
  const fields = f ? tidy(f.fields) : [];
  return {
    feature: "can-discovery",
    outcome: r.outcome,
    make: r.make,
    protocol,
    adapter_model: adapter,
    candidates: r.candidates,
    tried: r.tried,
    id: f ? f.id.toString(16).toUpperCase() : "",
    len: f?.len ?? -1,
    fields: fields.map(fieldKey).join(" "),
    r_min_pct: f ? Math.round(Math.min(...f.fields.map((x) => x.r)) * 10_000) / 100 : -1,
    pairs: f?.pairs ?? -1,
    range_kph: f ? Math.round(f.rangeKph) : -1,
    duration_s: r.durationS,
    late_polls: r.latePolls,
    // The gyro's verdict: each wheel's field (its index in `fields`), or why they aren't four wheels.
    wheels: w?.order ? ["fl", "fr", "rl", "rr"].map((name, i) => `${name}:${w.order![i]}`).join(" ") : "",
    wheels_reason: w && !w.order ? w.reason : "",
    track_cm: w?.order ? Math.round(w.trackM * 100) : -1,
    wheelbase_cm: w?.order ? Math.round(w.wheelbaseM * 100) : -1,
  };
}
