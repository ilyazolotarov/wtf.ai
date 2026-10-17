// The CAN shadow's ids picked for the car (VEHICLE-LINK-SPEC §16.4): the VIN's make gives the candidate platforms,
// listening to their wheel-speed and gear ids tells which one the car is, and the shadow narrows to that one's.
import { allProfiles, makeForVin, matchProfiles, seenIds, type Profile } from "@/nav/odometry/can/profile";
import type { CanFrame } from "@/obd/can-monitor";
import type { KeyValueStore } from "@/obd/vehicle-link-core";

/** Ids listened to at once while probing (the adapter's pass filters; a make has up to 11 candidates). */
const PROBE_BATCH = 8;
/** A batch is judged after this much of its frames' time (wheel speeds come at 50–100 Hz). */
const PROBE_US = 2_000_000;
/**
 * A batch none of whose ids is heard in this much listening is passed over: the port doesn't carry them (a gateway).
 * Under the monitor's own 5 s backstop (`DEAF_US` in can-shadow.ts, less a long window), which would otherwise blame
 * the adapter's filter and turn the monitor off before the next batch is tried.
 */
const PROBE_SILENT_US = 3_000_000;
/**
 * Drives on which none of the make's ids was heard before the car is taken for OBD only. A drive counts only when the
 * car moved during that silence: parked with the ECU awake (the main test car's ECU answers with the engine off), the
 * wheels may not be on the bus yet.
 */
const NONE_DRIVES = 2;
/** VIN → the ids chosen for it, tried first next time. */
export const CAN_AUTO_IDS_KEY = "vehicleLink.canAutoIds";
/** VIN → drives on which none of its make's ids (`candidates`, as they were then) was heard. */
export const CAN_AUTO_NONE_KEY = "vehicleLink.canAutoNone";
type NoneRecord = Record<string, { candidates: string; drives: number }>;

/** The ids a profile needs for navigation: its wheel speeds (and their direction), else its speed; its gear. */
export function navigationIds(p: Profile): number[] {
  const ids = new Set<number>();
  if (p.wheels) {
    for (const w of p.wheels) {
      ids.add(w.id);
      if (w.dir) ids.add(w.dir.id);
    }
  } else for (const id of p.speedIds) ids.add(id);
  for (const g of p.gear) ids.add(g.id);
  return [...ids];
}

/**
 * After BUFFER FULL (the ids send more than the link carries without the polls' breaks, VEHICLE-LINK-SPEC §16.3): the
 * ids navigation needs, when those listened to are more; null: nothing to drop (or the profile not known yet).
 */
export function idsAfterBufferFull(listened: number[] | null, profile: Profile | null): number[] | null {
  if (!listened || !profile) return null;
  const needed = navigationIds(profile);
  return listened.every((id) => needed.includes(id)) ? null : needed;
}

/** Every id any platform of the VIN's make needs for navigation; empty when the make isn't known. */
export function candidateIds(vin: string | null): number[] {
  const make = makeForVin(vin);
  if (!make) return [];
  const ids = new Set<number>();
  for (const p of allProfiles()) if (p.make === make) for (const id of navigationIds(p)) ids.add(id);
  return [...ids];
}

export type CanAutoStatus =
  | { state: "off" }
  | { state: "no-vin" }
  | { state: "unknown-make" }
  | { state: "probing"; ids: number[] }
  | { state: "chosen"; ids: number[]; profile: string }
  | { state: "none"; heard: number };

export interface CanAutoIdsDeps {
  vin(): string | null;
  /** Have the shadow listen to these ids (null: not now). */
  listen(ids: number[] | null): void;
  onFrames(listener: (frames: CanFrame[]) => void): () => void;
  /** The monitor's listening windows: how long a batch was listened to. */
  onWindow(listener: (w: { startUs: number; endUs: number }) => void): () => void;
  /** OBD shows the car moving now (a fresh speed of at least 1 km/h). */
  moving(): boolean;
  store: KeyValueStore;
  note(text: string): void;
  onStatus?(status: CanAutoStatus): void;
}

const hexIds = (ids: number[]) => ids.map((id) => id.toString(16).toUpperCase()).join(" ");

export class CanAutoIds {
  private off: (() => void) | null = null;
  /** The VIN the ids are for; undefined: none looked at yet. */
  private vin: string | null | undefined = undefined;
  /** Batches still to listen to; the current one first. */
  private batches: number[][] = [];
  private heard: CanFrame[] = [];
  /** Listening time of the current batch while none of its ids is heard. */
  private silentUs = 0;
  /** The car moved during some of this probe's silent listening: a drive with none heard counts. */
  private movedSilent = false;
  private status_: CanAutoStatus = { state: "off" };

  constructor(private readonly deps: CanAutoIdsDeps) {}

  get status(): CanAutoStatus {
    return this.status_;
  }

  start(): void {
    if (this.off) return;
    const offFrames = this.deps.onFrames((frames) => this.onFrames(frames));
    const offWindows = this.deps.onWindow((w) => this.onWindow(w));
    this.off = () => {
      offFrames();
      offWindows();
    };
    this.vin = undefined;
    this.refresh();
  }

  stop(): void {
    this.off?.();
    this.off = null;
    this.batches = [];
    this.heard = [];
    this.set({ state: "off" });
  }

  /** Try again on cars taken for OBD only (the driver turned the wheels' speed on again). */
  forgetNone(): void {
    this.deps.store.setJson(CAN_AUTO_NONE_KEY, {});
  }

  /** The vehicle may have changed (a new session, the VIN read late): start over for another car. */
  refresh(): void {
    if (!this.off) return;
    const vin = this.deps.vin();
    if (vin === this.vin) return;
    this.vin = vin;
    this.heard = [];
    this.movedSilent = false;
    if (!vin) {
      this.batches = [];
      this.deps.listen(null);
      this.set({ state: "no-vin" });
      return;
    }
    const all = candidateIds(vin);
    if (!all.length) {
      this.batches = [];
      this.deps.listen(null);
      this.set({ state: "unknown-make" });
      this.deps.note("can auto: the VIN's make has no CAN profile, the shadow stays off");
      return;
    }
    const none = this.noneRecord()[vin];
    if (none && none.candidates === candidatesKey(all) && none.drives >= NONE_DRIVES) {
      this.batches = [];
      this.deps.listen(null);
      this.set({ state: "none", heard: 0 });
      this.deps.note(`can auto: none of the make's ids heard on ${none.drives} drives of this car, OBD only`);
      return;
    }
    const remembered = this.deps.store.getJson<Record<string, number[]>>(CAN_AUTO_IDS_KEY)?.[vin];
    const rest = all.filter((id) => !remembered?.includes(id));
    this.batches = [...(remembered?.length ? [remembered] : []), ...chunk(rest, PROBE_BATCH)];
    this.probeNext();
  }

  private probeNext(): void {
    const ids = this.batches[0];
    this.heard = [];
    this.silentUs = 0;
    if (!ids) {
      this.deps.listen(null);
      this.set({ state: "none", heard: 0 });
      if (!this.movedSilent) {
        this.deps.note("can auto: none of the make's wheel-speed ids heard while the car stood, the monitor stays off (not counted)");
        return;
      }
      const vin = this.vin!;
      const candidates = candidatesKey(candidateIds(vin));
      const before = this.noneRecord()[vin];
      const drives = before?.candidates === candidates ? before.drives + 1 : 1;
      this.deps.store.setJson(CAN_AUTO_NONE_KEY, { ...this.noneRecord(), [vin]: { candidates, drives } });
      this.deps.note(`can auto: none of the make's wheel-speed ids heard (drive ${drives} of ${NONE_DRIVES} before OBD only), the monitor stays off`);
      return;
    }
    this.deps.listen(ids);
    this.set({ state: "probing", ids });
  }

  private onFrames(frames: CanFrame[]): void {
    if (this.status_.state !== "probing") return;
    const ids = new Set(this.status_.ids);
    for (const f of frames) if (ids.has(f.id)) this.heard.push(f);
    if (!this.heard.length || this.heard.at(-1)!.rxUs - this.heard[0].rxUs < PROBE_US) return;
    const match = matchProfiles(seenIds(this.heard), this.vin ?? null, ids).find((m) => m.speed);
    this.batches.shift();
    if (!match) {
      this.probeNext();
      return;
    }
    const chosen = navigationIds(match.profile);
    const vin = this.vin!;
    const none = this.noneRecord();
    if (none[vin]) {
      delete none[vin];
      this.deps.store.setJson(CAN_AUTO_NONE_KEY, none);
    }
    this.deps.store.setJson(CAN_AUTO_IDS_KEY, { ...(this.deps.store.getJson<Record<string, number[]>>(CAN_AUTO_IDS_KEY) ?? {}), [vin]: chosen });
    this.batches = [];
    this.heard = [];
    // Listening to exactly these already: the shadow carries on as it is.
    if (!sameIds(chosen, [...ids])) this.deps.listen(chosen);
    this.set({ state: "chosen", ids: chosen, profile: match.profile.key });
    this.deps.note(`can auto: ${match.profile.key}, ids ${hexIds(chosen)}`);
  }

  /** Nothing of the batch heard in `PROBE_SILENT_US` of listening: the next batch. */
  private onWindow(w: { startUs: number; endUs: number }): void {
    if (this.status_.state !== "probing" || this.heard.length) return;
    this.silentUs += w.endUs - w.startUs;
    if (this.deps.moving()) this.movedSilent = true;
    if (this.silentUs < PROBE_SILENT_US) return;
    this.deps.note(`can auto: nothing of ${hexIds(this.status_.ids)} heard in ${(this.silentUs / 1e6).toFixed(1)} s of listening`);
    this.batches.shift();
    this.probeNext();
  }

  private noneRecord(): NoneRecord {
    return this.deps.store.getJson<NoneRecord>(CAN_AUTO_NONE_KEY) ?? {};
  }

  private set(status: CanAutoStatus): void {
    this.status_ = status;
    this.deps.onStatus?.(status);
  }
}

const candidatesKey = (ids: number[]) => [...ids].sort((a, b) => a - b).join(",");
const chunk = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const sameIds = (a: number[], b: number[]) => a.length === b.length && a.every((id) => b.includes(id));
