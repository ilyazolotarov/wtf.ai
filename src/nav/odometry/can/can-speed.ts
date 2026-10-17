// Speed from CAN for the navigator (SPEC §2.1 Stage 2): the decoded car state (car-state.ts) averaged into steady
// samples, with the gear for the direction. From the four wheel speeds; where a car's profile has none, from its
// speed message (the ABS module's, mostly). Pure: the app (CAN primary) and replay run the same code.
import type { CarStateSample } from "./car-state";
import type { Gear } from "./mappings";
import type { Profile } from "./profile";

/** A speed sample for the navigator, from the wheels or from the car's speed message. */
export interface CanSpeed {
  /** Mean time of the frames averaged. */
  tUs: number;
  /** Mean of the four wheels (or of the speed message), m/s, unsigned (`reverse` gives the direction). */
  speedMps: number;
  /**
   * Mean per wheel over the sample, m/s, unsigned and not rounded (their differences are the yaw rate): [fl, fr, rl,
   * rr]. Null from a speed message.
   */
  wheelsMps: [number, number, number, number] | null;
  /** The gear last read (within `GEAR_FRESH_US`), null when unknown. */
  gear: Gear | null;
  reverse: boolean;
}

/** From the four wheels: what the turning from the wheels needs (wheel-yaw.ts). */
export interface CanSpeedSample extends CanSpeed {
  wheelsMps: [number, number, number, number];
}

/** What a profile's navigation speed comes from: its wheel speeds, else its speed message. */
export type CanSpeedFrom = "wheels" | "speed";
export const canSpeedFrom = (profile: Profile): CanSpeedFrom => (profile.wheels ? "wheels" : "speed");

/** One sample per this much time with wheel speeds (100 Hz frames averaged: ~10 per sample). */
export const CAN_SPEED_PERIOD_US = 100_000;
/** A gear read longer ago than this is unknown (the monitor listens between polls; GEAR comes at 50 Hz). */
const GEAR_FRESH_US = 2_000_000;
/** Wheel speeds come in 0.01 km/h steps: rounding to them keeps a standing car at exactly 0 (0.01·raw − 100 isn't). */
const STEP_MPS = 0.01 / 3.6;
const round = (v: number) => Math.round(v / STEP_MPS) * STEP_MPS;
/**
 * A wheel sample no car makes: a monitor line that lost characters on the way still parses as 8 bytes (4 in 15 000
 * frames on the vLinker over BLE, 23 in 28 000 on the MX+, 2026-10-12), and one such frame in a sample moved the
 * left/right difference by metres per second. Rejected: one changed by more than `JUMP_MPS` plus `JUMP_MPS2` per
 * second since the last sample kept, within `JUMP_WITHIN_US` (nearly all of them), or the wheels further apart than
 * `SPREAD_MPS` plus `SPREAD_SHARE` of their mean. In a roundabout at 12 km/h the outer front wheel turns 40 % faster
 * than the inner rear one (1.7 m/s apart, 2026-10-14): a tenth of the mean rejected 741 real frames on 19 CAN drives,
 * and the navigator lost its turning in the middle of that roundabout. With half of it the jumps still reject every
 * garbled frame; the 32 more the tenth rejected were turns too.
 */
const SPREAD_MPS = 3 / 3.6;
const SPREAD_SHARE = 0.5;
const JUMP_MPS = 2 / 3.6;
const JUMP_MPS2 = 14;
const JUMP_WITHIN_US = 300_000;
const MAX_MPS = 300 / 3.6;

export function plausibleWheels(v: readonly number[], last: { v: readonly number[]; tUs: number } | null, tUs: number): boolean {
  let lo = Infinity;
  let hi = -Infinity;
  let sum = 0;
  for (const x of v) {
    const a = Math.abs(x);
    if (!Number.isFinite(a) || a > MAX_MPS) return false;
    lo = Math.min(lo, a);
    hi = Math.max(hi, a);
    sum += a;
  }
  if (hi - lo > SPREAD_MPS + (SPREAD_SHARE * sum) / v.length) return false;
  if (!last || tUs - last.tUs > JUMP_WITHIN_US) return true;
  const allowed = JUMP_MPS + (JUMP_MPS2 * Math.max(0, tUs - last.tUs)) / 1e6;
  return v.every((x, i) => Math.abs(Math.abs(x) - Math.abs(last.v[i])) <= allowed);
}

/**
 * Wheel samples (or, `from: "speed"`, speed-message samples) averaged per `periodUs`, each with the gear then, as they
 * come (the app) or all at once (`canSpeedSamples`, `navigatorSpeeds`: replay): one code, so both drive the navigator
 * alike. A sample is out when the next period's first sample arrives, or at `flush`. A speed message passes the same
 * plausibility as one wheel (`plausibleWheels`): the garbled lines are the transport's, whatever the message.
 */
export class CanSpeedAverager {
  private gear: { gear: Gear | null; tUs: number } | null = null;
  private bin: { key: number; n: number; tUs: number; sum: number[] } | null = null;
  private kept: { v: readonly number[]; tUs: number } | null = null;

  constructor(
    private readonly periodUs = CAN_SPEED_PERIOD_US,
    private readonly from: CanSpeedFrom = "wheels",
  ) {}

  push(s: CarStateSample): CanSpeed[] {
    if (s.q === "gear") this.gear = { gear: s.gear, tUs: s.tUs };
    let v: readonly number[];
    if (s.q === "wheels" && this.from === "wheels") v = s.v;
    else if (s.q === "speed" && this.from === "speed") v = [s.v];
    else return [];
    if (!plausibleWheels(v, this.kept, s.tUs)) return [];
    this.kept = { v, tUs: s.tUs };
    const key = Math.floor(s.tUs / this.periodUs);
    const out = this.bin && this.bin.key !== key ? this.flush() : [];
    this.bin ??= { key, n: 0, tUs: 0, sum: v.map(() => 0) };
    this.bin.n++;
    this.bin.tUs += s.tUs;
    for (let i = 0; i < v.length; i++) this.bin.sum[i] += v[i];
    return out;
  }

  flush(): CanSpeed[] {
    const bin = this.bin;
    if (!bin) return [];
    this.bin = null;
    const mean = bin.sum.map((x) => Math.abs(x / bin.n));
    const tUs = bin.tUs / bin.n;
    const g = this.gear && tUs - this.gear.tUs <= GEAR_FRESH_US ? this.gear.gear : null;
    const wheelsMps = this.from === "wheels" ? (mean as [number, number, number, number]) : null;
    const speedMps = round(mean.reduce((a, b) => a + b, 0) / mean.length);
    return [{ tUs, speedMps, wheelsMps, gear: g, reverse: g === "R" }];
  }
}

/** Wheel samples (time-ordered) averaged per `periodUs`, each with the gear then. */
export function canSpeedSamples(samples: CarStateSample[], periodUs = CAN_SPEED_PERIOD_US): CanSpeedSample[] {
  const avg = new CanSpeedAverager(periodUs);
  return [...samples.flatMap((s) => avg.push(s)), ...avg.flush()] as CanSpeedSample[];
}

/** The navigator's speed from a profile's samples (time-ordered): its wheels, else its speed message. */
export function navigatorSpeeds(samples: CarStateSample[], profile: Profile, periodUs = CAN_SPEED_PERIOD_US): CanSpeed[] {
  const avg = new CanSpeedAverager(periodUs, canSpeedFrom(profile));
  return [...samples.flatMap((s) => avg.push(s)), ...avg.flush()];
}

/**
 * As the navigator reads it: negative in reverse (the car and the map matching move backwards), and the unsigned
 * reading in km/h at the wheels' 0.01 km/h steps.
 */
export function canSpeedReading(s: CanSpeed): { speedMps: number; rawKph: number } {
  return { speedMps: s.reverse ? -s.speedMps : s.speedMps, rawKph: Math.round(s.speedMps * 360) / 100 };
}
