// CAN primary (VEHICLE-LINK-SPEC §16.3): the CAN shadow's wheel frames decoded into speed for the navigator, as
// replay decodes a log's (`withCanSpeed`): the profile from the VIN and the ids heard, wheel samples averaged per
// 0.1 s, negative in reverse gear.
import { CanSpeedAverager, canSpeedReading, type CanSpeedSample } from "@/nav/odometry/can/can-speed";
import { CarStateDecoder } from "@/nav/odometry/can/car-state";
import { FrameRetimer } from "@/nav/odometry/can/frame-timing";
import { matchProfiles, seenIds, type Profile } from "@/nav/odometry/can/profile";
import type { CanFrame } from "@/obd/can-monitor";
import type { SpeedSample } from "@/obd/types";

/** Frames heard before the profile is chosen (1–2 s of listening). */
const PROFILE_AFTER_FRAMES = 200;
/** Still no profile with wheel speeds after this many: the ids or the car aren't known, OBD stays. */
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
}

export class CanSpeedFeed {
  private decoder: CarStateDecoder | null = null;
  private averager = new CanSpeedAverager();
  /** The link delivers frames in bursts: each id laid on its period, as replay does (frame-timing.ts). */
  private retimer = new FrameRetimer();
  /** Frames (at the bus's time) kept until the profile is chosen, then decoded. */
  private early: TimedFrame[] = [];
  private gaveUp = false;
  private vin: string | null = null;
  private off: (() => void) | null = null;

  constructor(private readonly deps: CanSpeedFeedDeps) {}

  /** The car's profile the speed comes from, once chosen. */
  get profile(): Profile | null {
    return this.decoder?.profile ?? null;
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
  }

  private onFrames(frames: CanFrame[]): void {
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
      const match = matchProfiles(seenIds(this.early), vin, listened ? new Set(listened) : undefined).find((m) => m.speed && m.profile.wheels);
      if (!match) {
        if (this.early.length >= GIVE_UP_AFTER_FRAMES) {
          this.gaveUp = true;
          this.early = [];
          this.deps.note("can primary: no car profile with wheel speeds for the ids heard, OBD speed stays");
        }
        return;
      }
      this.decoder = new CarStateDecoder(match.profile);
      this.deps.note(`can primary: speed from the wheels, profile ${match.profile.key}`);
      timed = this.early;
      this.early = [];
    }
    for (const f of timed) {
      for (const s of this.decoder.push(f.tUs, f.id, f.data)) {
        for (const c of this.averager.push(s)) {
          this.deps.push(toSpeedSample(c));
        }
      }
    }
  }
}

type TimedFrame = { id: number; data: number[]; tUs: number };

export function toSpeedSample(c: CanSpeedSample): SpeedSample {
  const { speedMps, rawKph } = canSpeedReading(c);
  return { txUs: c.tUs, rxUs: c.tUs, tUs: c.tUs, speedMps, raw: rawKph, source: "can" };
}
