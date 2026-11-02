import { signal, writeSignal, type Signal, type SignalsFile } from "@/nav/odometry/can/dbc";
import signalsJson from "@/nav/odometry/can/signals.json";
import { DEFAULT_TRACK_M } from "@/nav/odometry/can/wheel-yaw";
import type { Clock } from "@/obd/clock";
import { CLONE_PROFILE, Elm327Emulator, GENUINE_PROFILE, STN_PROFILE, VLINKER_PROFILE, type EmulatorProfile } from "@/obd/emulator";
import type { ConnectedInfo } from "@/obd/types";

/**
 * The car's CAN broadcast on the adapters that can monitor it (VEHICLE-LINK-SPEC §16): the emulators' VIN is a Mazda's,
 * and these are its profile's messages (opendbc's mazda_2017): the four wheels at 50 Hz, the engine's speed and the
 * gear. The app picks the profile, checks it against the OBD speed (probation, §16.5) and then drives on the wheels,
 * turning by their difference (NAVIGATOR-SPEC §5.4): with no gyro too, as in the iOS Simulator.
 */
const MAZDA = (signalsJson as unknown as SignalsFile).dbcs.mazda_2017;
const msg = (name: string) => MAZDA.msgs[name];
const sig = (name: string, s: string): Signal => signal(msg(name).sigs[s]);
const WHEELS = { id: msg("WHEEL_SPEEDS").id, size: msg("WHEEL_SPEEDS").size, sigs: ["FL", "FR", "RL", "RR"].map((s) => sig("WHEEL_SPEEDS", s)) };
const ENGINE = { id: msg("ENGINE_DATA").id, size: msg("ENGINE_DATA").size, speed: sig("ENGINE_DATA", "SPEED") };
const GEAR = { id: msg("GEAR").id, size: msg("GEAR").size, gear: sig("GEAR", "GEAR") };
/** The value table's D (`GEAR.GEAR`: 1 P, 2 R, 3 N, 4 D). */
const GEAR_D = 4;
const BROADCAST: NonNullable<EmulatorProfile["broadcast"]> = [
  { id: WHEELS.id, periodMs: 20, data: new Array<number>(WHEELS.size).fill(0) },
  { id: ENGINE.id, periodMs: 20, data: new Array<number>(ENGINE.size).fill(0) },
  { id: GEAR.id, periodMs: 40, data: new Array<number>(GEAR.size).fill(0) },
];
/** Front axle to rear, m: the front wheels' wider arcs in a turn. */
const WHEELBASE_M = 2.7;

const PROFILES: Record<string, Partial<EmulatorProfile>> = {
  "emulator:genuine": GENUINE_PROFILE,
  "emulator:clone": CLONE_PROFILE,
  "emulator:stn": { ...STN_PROFILE, broadcast: BROADCAST },
  "emulator:vlinker": { ...VLINKER_PROFILE, broadcast: BROADCAST },
};

/** A profile in time: seconds since connecting → a value, straight between the points, the last one held. */
export type DriveProfile = readonly (readonly [number, number])[];
/** Seconds → km/h. */
export type SpeedProfile = DriveProfile;
/** Seconds → the car's heading, degrees clockwise (a right turn adds), unwrapped: only its changes count. */
export type HeadingProfile = DriveProfile;

function parseProfile(spec: string | null | undefined, signed: boolean): DriveProfile | null {
  if (!spec) return null;
  const points = spec.split(",").map((p) => p.split(":").map(Number));
  if (points.length < 2 || points.some((p) => p.length !== 2 || !p.every(Number.isFinite))) return null;
  if (points.some(([t, v], i) => (!signed && v < 0) || (i > 0 && t <= points[i - 1][0]))) return null;
  return points.map(([t, v]) => [t, v] as const);
}

/**
 * `"0:0,10:0,22:50"` (seconds:km/h, in time order) → the profile; null when it isn't one. The store-video script
 * (scripts/store-screenshots.py) drives the car along its demo route with it, from the same points it moves GPS by.
 */
export function parseSpeedProfile(spec: string | null | undefined): SpeedProfile | null {
  return parseProfile(spec, false);
}

/** `"0:270,12:270,15:360"` (seconds:degrees) → the car's heading in time, for its wheels to turn by; null: not one. */
export function parseHeadingProfile(spec: string | null | undefined): HeadingProfile | null {
  return parseProfile(spec, true);
}

/** The profile's value `t` s in. */
export function profileAt(profile: DriveProfile, t: number): number {
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

/** The profile's rate of change `t` s in, per second (0 outside it). */
export function profileRate(profile: DriveProfile, t: number): number {
  for (let i = 1; i < profile.length; i++) {
    const [t1, v1] = profile[i];
    if (t < t1) {
      const [t0, v0] = profile[i - 1];
      return t < t0 ? 0 : (v1 - v0) / (t1 - t0);
    }
  }
  return 0;
}

/**
 * The four wheels' speeds, km/h [fl, fr, rl, rr], of a car going `speedKph` (its rear axle's middle) and turning at
 * `yawRad` rad/s (left positive, as the phone's `yawRate`): the rear wheels ± half the track's turning, the front ones
 * on their arcs a wheelbase ahead. The navigator turns by the rear ones' difference over its track.
 */
export function wheelSpeeds(speedKph: number, yawRad: number): [number, number, number, number] {
  const v = speedKph / 3.6;
  const w = v > 0.1 ? yawRad : 0;
  const left = v - (w * DEFAULT_TRACK_M) / 2;
  const right = v + (w * DEFAULT_TRACK_M) / 2;
  const front = (rear: number) => Math.hypot(rear, w * WHEELBASE_M);
  return [front(left), front(right), left, right].map((mps) => mps * 3.6) as [number, number, number, number];
}

/** The cruise's spurt, km/h over its 60: up over 4 s from 30 s in, held 10 s, down over 4 s. */
function spurt(t: number): number {
  return 10 * Math.min(1, Math.max(0, (t - 30) / 4), Math.max(0, (48 - t) / 4));
}

/** The next emulator connected drives these profiles instead of the cycle (`wtfai://vehicle?emulators=1&cycle=…&turn=…`). */
let nextProfile: SpeedProfile | null = null;
let nextHeading: HeadingProfile | null = null;
export function driveProfileNext(profile: SpeedProfile | null, heading: HeadingProfile | null = null): void {
  nextProfile = profile;
  nextHeading = heading;
}

/**
 * Dev-only fake adapter with a repeating drive cycle: idle → accelerate → cruise → brake → stop-start → key off. Every
 * second cycle the cruise speeds up to 70 for about 10 s and back: past a 50 limit's margin, so the speed warning
 * (UI-SPEC §6.4) turns on, chimes and ends again. The STN and vLinker ones broadcast the car's wheels too, turning as
 * the heading profile does (straight without one).
 */
export class DrivingEmulator extends Elm327Emulator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private t0 = 0;
  private drive: SpeedProfile | null = null;
  private heading: HeadingProfile | null = null;

  constructor(id: string, clock: Clock) {
    super(clock, PROFILES[id] ?? GENUINE_PROFILE);
    if (this.profile.broadcast) this.setBroadcastSource((id) => this.carFrame(id));
  }

  override async connect(): Promise<ConnectedInfo> {
    this.t0 = Date.now();
    this.drive = nextProfile;
    this.heading = nextHeading;
    if (!this.timer) this.timer = setInterval(() => this.step(), 200);
    return super.connect();
  }

  override async disconnect(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return super.disconnect();
  }

  /** A broadcast frame as the car is now: the drive's speed and turning at this moment, not the last step's. */
  private carFrame(id: number): number[] | null {
    const t = (Date.now() - this.t0) / 1000;
    const speedKph = this.drive ? profileAt(this.drive, t) : this.vehicle.speedKph;
    if (id === WHEELS.id) {
      // Degrees clockwise per second → rad/s left positive.
      const yawRad = this.heading ? (-profileRate(this.heading, t) * Math.PI) / 180 : 0;
      const data = new Array<number>(WHEELS.size).fill(0);
      wheelSpeeds(speedKph, yawRad).forEach((kph, i) => writeSignal(WHEELS.sigs[i], data, kph));
      return data;
    }
    if (id === ENGINE.id) {
      const data = new Array<number>(ENGINE.size).fill(0);
      writeSignal(ENGINE.speed, data, speedKph);
      return data;
    }
    if (id === GEAR.id) {
      const data = new Array<number>(GEAR.size).fill(0);
      writeSignal(GEAR.gear, data, GEAR_D);
      return data;
    }
    return null;
  }

  private step(): void {
    if (this.drive) {
      const speedKph = profileAt(this.drive, (Date.now() - this.t0) / 1000);
      this.setVehicle({ ignition: true, rpm: speedKph > 0 ? 800 + speedKph * 25 : 800, speedKph });
      return;
    }
    const elapsed = (Date.now() - this.t0) / 1000;
    const t = elapsed % 120;
    const speeding = Math.floor(elapsed / 120) % 2 === 1;
    if (t < 10) this.setVehicle({ ignition: true, rpm: 800, speedKph: 0 });
    else if (t < 25) this.setVehicle({ ignition: true, rpm: 2500, speedKph: ((t - 10) / 15) * 60 });
    else if (t < 50) this.setVehicle({ ignition: true, rpm: 1800, speedKph: 60 + (speeding ? spurt(t) : 0) + 3 * Math.sin(t) });
    else if (t < 60) this.setVehicle({ ignition: true, rpm: 1000, speedKph: 60 * (1 - (t - 50) / 10) });
    else if (t < 75) this.setVehicle({ ignition: true, rpm: 0, speedKph: 0 }); // auto stop-start
    else if (t < 95) this.setVehicle({ ignition: true, rpm: 2000, speedKph: ((t - 75) / 20) * 40 });
    else if (t < 100) this.setVehicle({ ignition: true, rpm: 800, speedKph: 0 });
    else this.setVehicle({ ignition: false, rpm: 0, speedKph: 0 }); // key off for 20 s
  }
}
