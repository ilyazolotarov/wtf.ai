// CAN primary (VEHICLE-LINK-SPEC §16.3): the CAN shadow's wheel frames decoded into speed for the navigator, as
// replay decodes a log's (`withCanSpeed`): the profile from the VIN and the ids heard, wheel samples averaged per
// 0.1 s, negative in reverse gear.
import { CanSpeedAverager, canSpeedReading, type CanSpeedSample } from "@/nav/odometry/can/can-speed";
import { CarStateDecoder } from "@/nav/odometry/can/car-state";
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
  /** Frames kept until the profile is chosen, then decoded. */
  private early: CanFrame[] = [];
  private gaveUp = false;
  private vin: string | null = null;
  private off: (() => void) | null = null;

  constructor(private readonly deps: CanSpeedFeedDeps) {}

  /** The car's profile the speed comes from, once chosen. */
  get profile(): Profile | null {
    return this.decoder?.profile ?? null;
  }

  start(): void {
    this.off ??= this.deps.onFrames((frames) => this.onFrames(frames));
  }

  stop(): void {
    this.off?.();
    this.off = null;
    this.reset();
  }

  private reset(): void {
    this.decoder = null;
    this.averager = new CanSpeedAverager();
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
    if (!this.decoder) {
      this.early.push(...frames);
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
      frames = this.early;
      this.early = [];
    }
    for (const f of frames) {
      for (const s of this.decoder.push(f.rxUs, f.id, f.data)) for (const c of this.averager.push(s)) this.deps.push(toSpeedSample(c));
    }
  }
}

export function toSpeedSample(c: CanSpeedSample): SpeedSample {
  const { speedMps, rawKph } = canSpeedReading(c);
  return { txUs: c.tUs, rxUs: c.tUs, tUs: c.tUs, speedMps, raw: rawKph, source: "can" };
}
