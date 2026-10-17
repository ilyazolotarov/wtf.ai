import type { Clock } from "@/obd/clock";
import { CLONE_PROFILE, Elm327Emulator, GENUINE_PROFILE, STN_PROFILE } from "@/obd/emulator";
import type { ConnectedInfo } from "@/obd/types";

const PROFILES = {
  "emulator:genuine": GENUINE_PROFILE,
  "emulator:clone": CLONE_PROFILE,
  "emulator:stn": STN_PROFILE,
} as const;

/** A speed profile: seconds since connecting → km/h, straight between the points, the last one held. */
export type SpeedProfile = readonly (readonly [number, number])[];

/**
 * `"0:0,10:0,22:50"` (seconds:km/h, in time order) → the profile; null when it isn't one. The store-video script
 * (scripts/store-screenshots.py) drives the car along its demo route with it, from the same points it moves GPS by.
 */
export function parseSpeedProfile(spec: string | null | undefined): SpeedProfile | null {
  if (!spec) return null;
  const points = spec.split(",").map((p) => p.split(":").map(Number));
  if (points.length < 2 || points.some((p) => p.length !== 2 || !p.every(Number.isFinite))) return null;
  if (points.some(([t, kmh], i) => kmh < 0 || (i > 0 && t <= points[i - 1][0]))) return null;
  return points.map(([t, kmh]) => [t, kmh] as const);
}

/** The profile's speed `t` s in. */
export function speedAt(profile: SpeedProfile, t: number): number {
  if (t <= profile[0][0]) return profile[0][1];
  for (let i = 1; i < profile.length; i++) {
    const [t1, v1] = profile[i];
    if (t <= t1) {
      const [t0, v0] = profile[i - 1];
      return v0 + ((t - t0) / (t1 - t0)) * (v1 - v0);
    }
  }
  return profile[profile.length - 1][1];
}

/** The next emulator connected drives this profile instead of the cycle (`wtfai://vehicle?emulators=1&cycle=…`). */
let nextProfile: SpeedProfile | null = null;
export function driveProfileNext(profile: SpeedProfile | null): void {
  nextProfile = profile;
}

/** Dev-only fake adapter with a repeating drive cycle: idle → accelerate → cruise → brake → stop-start → key off. */
export class DrivingEmulator extends Elm327Emulator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private t0 = 0;
  private drive: SpeedProfile | null = null;

  constructor(id: string, clock: Clock) {
    super(clock, PROFILES[id as keyof typeof PROFILES] ?? GENUINE_PROFILE);
  }

  override async connect(): Promise<ConnectedInfo> {
    this.t0 = Date.now();
    this.drive = nextProfile;
    if (!this.timer) this.timer = setInterval(() => this.step(), 200);
    return super.connect();
  }

  override async disconnect(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return super.disconnect();
  }

  private step(): void {
    if (this.drive) {
      const speedKph = speedAt(this.drive, (Date.now() - this.t0) / 1000);
      this.setVehicle({ ignition: true, rpm: speedKph > 0 ? 800 + speedKph * 25 : 800, speedKph });
      return;
    }
    const t = ((Date.now() - this.t0) / 1000) % 120;
    if (t < 10) this.setVehicle({ ignition: true, rpm: 800, speedKph: 0 });
    else if (t < 25) this.setVehicle({ ignition: true, rpm: 2500, speedKph: ((t - 10) / 15) * 60 });
    else if (t < 50) this.setVehicle({ ignition: true, rpm: 1800, speedKph: 60 + 3 * Math.sin(t) });
    else if (t < 60) this.setVehicle({ ignition: true, rpm: 1000, speedKph: 60 * (1 - (t - 50) / 10) });
    else if (t < 75) this.setVehicle({ ignition: true, rpm: 0, speedKph: 0 }); // auto stop-start
    else if (t < 95) this.setVehicle({ ignition: true, rpm: 2000, speedKph: ((t - 75) / 20) * 40 });
    else if (t < 100) this.setVehicle({ ignition: true, rpm: 800, speedKph: 0 });
    else this.setVehicle({ ignition: false, rpm: 0, speedKph: 0 }); // key off for 20 s
  }
}
