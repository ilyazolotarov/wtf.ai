// CAN primary (VEHICLE-LINK-SPEC §16.3): the CAN shadow's frames decoded into speed for the navigator, as replay
// decodes a log's (`withCanSpeed`): the profile from the VIN and the ids heard, its wheel samples (a profile without
// wheel speeds: its speed message) averaged per 0.1 s, negative in reverse gear. A profile on probation (§16.5) is
// decoded the same, but its speed reaches only the check until it passes (`promote`).
import { CAN_SPEED_PERIOD_US, CanSpeedAverager, canSpeedFrom, canSpeedReading, type CanSpeed, type CanSpeedSample } from "@/nav/odometry/can/can-speed";
import { CarStateDecoder } from "@/nav/odometry/can/car-state";
import { FrameRetimer } from "@/nav/odometry/can/frame-timing";
import { matchProfiles, seenIds, type Profile } from "@/nav/odometry/can/profile";
import type { CanFrame } from "@/obd/can-monitor";
import type { SpeedSample } from "@/obd/types";

/** Frames heard before the profile is chosen (1–2 s of listening). */
const PROFILE_AFTER_FRAMES = 200;
/** Still no profile with a wheel or speed message after this many: the ids or the car aren't known, OBD stays. */
const GIVE_UP_AFTER_FRAMES = 3000;

export interface CanSpeedFeedDeps {
  /** The CAN shadow's frames, in arrival batches. */
  onFrames(listener: (frames: CanFrame[]) => void): () => void;
  /** Each listening window's end, after its frames: a break, the frames until the next went unheard. */
  onWindow(listener: () => void): () => void;
  /** The car's VIN (the make narrows the profiles), null unknown. */
  vin(): string | null;
  /** The ids the shadow listens for. */
  listened(): number[] | null;
  /** A CAN speed sample for the link (`VehicleLinkCore.pushCanSpeed`). */
  push(s: SpeedSample): void;
  note(text: string): void;
  /**
   * The profile chosen for the car: true, its speed goes to the navigator now; false, it is on probation and goes
   * there only after `promote`. Absent: always now.
   */
  admit?(profile: Profile): boolean;
  /** The car's own profiles beside opendbc's (a discovery's, §16.6). */
  extraProfiles?(): Profile[];
  /** False while something else owns the monitor's ids (discovery searching, §16.6): its frames are no car's profile. */
  active?(): boolean;
}

/** The note that the navigator's speed now comes from the profile; replay starts the wheels' speed at it. */
export const canPrimaryNote = (profile: Profile) =>
  `can primary: speed from the wheels, profile ${profile.key}${profile.wheels ? "" : " (its speed message: no wheel speeds)"}`;

export class CanSpeedFeed {
  private decoder: CarStateDecoder | null = null;
  private averager = new CanSpeedAverager();
  /** The link delivers frames in bursts: each id laid on its period, as replay does (frame-timing.ts). */
  private retimer = new FrameRetimer();
  /** Frames (at the bus's time) kept until the profile is chosen, then decoded. */
  private early: TimedFrame[] = [];
  private gaveUp = false;
  /** The chosen profile's speed goes to the navigator (not on probation, or passed it). */
  private admitted = false;
  private vin: string | null = null;
  private off: (() => void) | null = null;
  private readonly samples = new Set<(s: CanSpeedSample) => void>();
  private readonly speeds = new Set<(s: CanSpeed) => void>();

  constructor(private readonly deps: CanSpeedFeedDeps) {}

  /**
   * Each wheel sample (0.1 s of frames, at the bus's time), for the navigator's turning (NAVIGATOR-SPEC §5.4). None
   * from a car whose speed comes from its speed message: the phone's gyro keeps the turning.
   */
  onSample(listener: (s: CanSpeedSample) => void): () => void {
    this.samples.add(listener);
    return () => this.samples.delete(listener);
  }

  /** Every speed sample decoded (unsigned, with the gear), admitted or not: what probation checks (§16.5). */
  onSpeed(listener: (s: CanSpeed) => void): () => void {
    this.speeds.add(listener);
    return () => this.speeds.delete(listener);
  }

  /** The car's profile the speed comes from, once chosen. */
  get profile(): Profile | null {
    return this.decoder?.profile ?? null;
  }

  /** The profile on probation passed: its speed goes to the navigator from now on. */
  promote(): void {
    if (!this.decoder || this.admitted) return;
    this.admitted = true;
    this.deps.note(canPrimaryNote(this.decoder.profile));
  }

  start(): void {
    if (this.off) return;
    const offFrames = this.deps.onFrames((frames) => this.onFrames(frames));
    const offWindows = this.deps.onWindow(() => this.retimer.break());
    this.off = () => {
      offFrames();
      offWindows();
    };
  }

  stop(): void {
    this.off?.();
    this.off = null;
    this.reset();
  }

  private reset(): void {
    this.decoder = null;
    this.averager = new CanSpeedAverager();
    this.retimer = new FrameRetimer();
    this.early = [];
    this.gaveUp = false;
    this.admitted = false;
  }

  private onFrames(frames: CanFrame[]): void {
    if (this.deps.active && !this.deps.active()) return;
    const vin = this.deps.vin();
    if (vin !== this.vin) {
      this.vin = vin;
      this.reset();
    }
    if (this.gaveUp) return;
    // Retimed as they come, in order with the windows' breaks.
    let timed = frames.map((f) => ({ id: f.id, data: f.data, tUs: this.retimer.retime(f.id, f.rxUs) }));
    if (!this.decoder) {
      this.early.push(...timed);
      if (this.early.length < PROFILE_AFTER_FRAMES) return;
      const listened = this.deps.listened();
      const extra = this.deps.extraProfiles?.() ?? [];
      const match = matchProfiles(seenIds(this.early), vin, listened ? new Set(listened) : undefined, extra).find((m) => m.speed);
      if (!match) {
        if (this.early.length >= GIVE_UP_AFTER_FRAMES) {
          this.gaveUp = true;
          this.early = [];
          this.deps.note("can primary: no car profile with a wheel or speed message for the ids heard, OBD speed stays");
        }
        return;
      }
      this.decoder = new CarStateDecoder(match.profile);
      this.averager = new CanSpeedAverager(CAN_SPEED_PERIOD_US, canSpeedFrom(match.profile));
      this.admitted = this.deps.admit?.(match.profile) ?? true;
      // Replay looks for this note's start (`canPrimaryInput`): the same for the speed message.
      if (this.admitted) this.deps.note(canPrimaryNote(match.profile));
      timed = this.early;
      this.early = [];
    }
    for (const f of timed) {
      for (const s of this.decoder.push(f.tUs, f.id, f.data)) {
        for (const c of this.averager.push(s)) {
          this.speeds.forEach((l) => l(c));
          if (!this.admitted) continue;
          this.deps.push(toSpeedSample(c));
          if (c.wheelsMps) this.samples.forEach((l) => l(c as CanSpeedSample));
        }
      }
    }
  }
}

type TimedFrame = { id: number; data: number[]; tUs: number };

export function toSpeedSample(c: CanSpeed): SpeedSample {
  const { speedMps, rawKph } = canSpeedReading(c);
  return { txUs: c.tUs, rxUs: c.tUs, tUs: c.tUs, speedMps, raw: rawKph, source: "can" };
}
