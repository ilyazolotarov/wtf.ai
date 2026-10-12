// Speed from CAN wheel speeds for the navigator (SPEC §2.1 Stage 2): the decoded car state (car-state.ts) averaged into
// steady samples, with the gear for the direction. Pure: replay uses it now (level "CAN shadow"); the app will at
// level "CAN primary".
import type { CarStateSample } from "./car-state";
import type { Gear } from "./mappings";

export interface CanSpeedSample {
  /** Mean time of the frames averaged. */
  tUs: number;
  /** Mean of the four wheels, m/s, unsigned (wheel speeds are; `reverse` gives the direction). */
  speedMps: number;
  /** Mean per wheel over the sample, m/s, unsigned and not rounded (their differences are the yaw rate): [fl, fr, rl, rr]. */
  wheelsMps: [number, number, number, number];
  /** The gear last read (within `GEAR_FRESH_US`), null when unknown. */
  gear: Gear | null;
  reverse: boolean;
}

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
 * left/right difference by metres per second. Rejected: the wheels further apart than `SPREAD_MPS` plus
 * `SPREAD_SHARE` of their mean (a tight turn at walking pace spreads them by under 1 m/s), or one changed by more
 * than `JUMP_MPS` plus `JUMP_MPS2` per second since the last sample kept, within `JUMP_WITHIN_US`.
 */
const SPREAD_MPS = 3 / 3.6;
const SPREAD_SHARE = 0.1;
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

/** Wheel samples (time-ordered) averaged per `periodUs`, each with the gear then. */
export function canSpeedSamples(samples: CarStateSample[], periodUs = CAN_SPEED_PERIOD_US): CanSpeedSample[] {
  const out: CanSpeedSample[] = [];
  let gear: { gear: Gear | null; tUs: number } | null = null;
  let bin: { key: number; n: number; tUs: number; w: [number, number, number, number] } | null = null;
  let kept: { v: readonly number[]; tUs: number } | null = null;
  const close = () => {
    if (!bin) return;
    const w = bin.w.map((x) => Math.abs(x / bin!.n)) as [number, number, number, number];
    const tUs = bin.tUs / bin.n;
    const g = gear && tUs - gear.tUs <= GEAR_FRESH_US ? gear.gear : null;
    out.push({ tUs, speedMps: round((w[0] + w[1] + w[2] + w[3]) / 4), wheelsMps: w, gear: g, reverse: g === "R" });
    bin = null;
  };
  for (const s of samples) {
    if (s.q === "gear") gear = { gear: s.gear, tUs: s.tUs };
    if (s.q !== "wheels") continue;
    if (!plausibleWheels(s.v, kept, s.tUs)) continue;
    kept = { v: s.v, tUs: s.tUs };
    const key = Math.floor(s.tUs / periodUs);
    if (bin && bin.key !== key) close();
    bin ??= { key, n: 0, tUs: 0, w: [0, 0, 0, 0] };
    bin.n++;
    bin.tUs += s.tUs;
    for (let i = 0; i < 4; i++) bin.w[i] += s.v[i];
  }
  close();
  return out;
}
