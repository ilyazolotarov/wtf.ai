import { signal, writeSignal } from "@/nav/odometry/can/dbc";
import signalsJson from "@/nav/odometry/can/signals.json";
import type { CanFrame } from "@/obd/can-monitor";
import type { SpeedSample } from "@/obd/types";
import { CanSpeedFeed } from "@/services/vehicle-link/can-speed-feed";

const SIGNALS = signalsJson as unknown as { dbcs: Record<string, { msgs: Record<string, { id: number; size: number; sigs: Record<string, never> }> }> };

function frame(msg: string, values: Record<string, number>, rxUs: number, dbc = "mazda_2017"): CanFrame {
  const m = SIGNALS.dbcs[dbc].msgs[msg];
  const data = new Array<number>(m.size).fill(0);
  for (const [sig, v] of Object.entries(values)) writeSignal(signal(m.sigs[sig]), data, v);
  return { id: m.id, data, rxUs };
}

/** 100 Hz wheels and 50 Hz gear, `seconds` long from `fromUs`. */
function drive(fromUs: number, seconds: number, kph: number, gear: number): CanFrame[] {
  const out: CanFrame[] = [];
  for (let i = 0; i < seconds * 100; i++) {
    const t = fromUs + i * 10_000;
    out.push(frame("WHEEL_SPEEDS", { FL: kph, FR: kph, RL: kph, RR: kph }, t));
    if (i % 2 === 0) out.push(frame("GEAR", { GEAR: gear }, t));
  }
  return out;
}

function feed(vin: string | null, listened = [0x215, 0x228], admit?: () => boolean) {
  let listener: ((frames: CanFrame[]) => void) | null = null;
  let windowEnd: (() => void) | null = null;
  const pushed: SpeedSample[] = [];
  const notes: string[] = [];
  const f = new CanSpeedFeed({
    onFrames: (l) => ((listener = l), () => (listener = null)),
    onWindow: (l) => ((windowEnd = l), () => (windowEnd = null)),
    vin: () => vin,
    listened: () => listened,
    push: (s) => pushed.push(s),
    note: (t) => notes.push(t),
    ...(admit ? { admit } : {}),
  });
  const wheelSamples: unknown[] = [];
  f.onSample((s) => wheelSamples.push(s));
  const decoded: unknown[] = [];
  f.onSpeed((s) => decoded.push(s));
  f.start();
  const send = (frames: CanFrame[]) => {
    for (let i = 0; i < frames.length; i += 25) listener?.(frames.slice(i, i + 25));
  };
  return { f, pushed, notes, wheelSamples, decoded, send, endWindow: () => windowEnd?.(), listening: () => listener !== null || windowEnd !== null };
}

// A VIN with a Mazda WMI, made up.
const VIN = "JM1AAAAAA00000000";

describe("CAN speed feed (VEHICLE-LINK-SPEC §16.3)", () => {
  test("picks the car's profile from the frames heard, then speed every 0.1 s from the start", () => {
    const { pushed, notes, send } = feed(VIN);
    send(drive(0, 3, 36, 4)); // D
    expect(notes).toEqual([expect.stringMatching(/^can primary: speed from the wheels, profile mazda\//)]);
    // The frames before the choice are decoded too: ~30 samples over 3 s.
    expect(pushed.length).toBeGreaterThanOrEqual(28);
    expect(pushed.every((s) => s.source === "can" && Math.abs(s.speedMps - 10) < 1e-6 && s.raw === 36)).toBe(true);
  });

  // The app moves the car backwards in reverse, as replay does (NAVIGATOR-SPEC §5.3).
  test("in reverse gear the speed is negative, the reading stays unsigned", () => {
    const { pushed, send } = feed(VIN);
    send(drive(0, 2, 7.2, 2)); // R
    const last = pushed.at(-1)!;
    expect(last.speedMps).toBeCloseTo(-2, 6);
    expect(last.raw).toBe(7.2);
  });

  test("ids no profile reads: nothing pushed, said once, OBD stays", () => {
    const { pushed, notes, send } = feed(VIN);
    const other: CanFrame[] = Array.from({ length: 3100 }, (_, i) => ({ id: 0x4f0, data: [1, 2, 3], rxUs: i * 10_000 }));
    send(other);
    expect(pushed).toHaveLength(0);
    expect(notes).toEqual(["can primary: no car profile with a wheel or speed message for the ids heard, OBD speed stays"]);
  });

  // VW PQ has no wheel speeds in its profile (Bremse_3 isn't on every car): its ABS speed, Bremse_1, at 0.01 km/h.
  test("a car without wheel speeds: the speed message, and nothing for the turning from the wheels", () => {
    const bremse1 = SIGNALS.dbcs.vw_pq.msgs.Bremse_1.id;
    const { pushed, notes, wheelSamples, send } = feed("WVWAAAAAA00000000", [bremse1]);
    send(Array.from({ length: 300 }, (_, i) => frame("Bremse_1", { BR1_Rad_kmh: 54.32 }, i * 10_000, "vw_pq")));
    expect(notes).toEqual([expect.stringMatching(/^can primary: speed from the wheels, profile volkswagen\/pq\/.*\(its speed message: no wheel speeds\)$/)]);
    expect(pushed.length).toBeGreaterThanOrEqual(28);
    expect(pushed.every((s) => s.source === "can" && s.raw === 54.32)).toBe(true);
    expect(wheelSamples).toHaveLength(0);
  });

  // 2026-10-12: laid one period after the last frame before a poll's break, every frame after it came that much early.
  test("a listening window's end is a break: the frames after it at their own time, not one period after the last", () => {
    const { pushed, send, endWindow } = feed(VIN);
    send(drive(0, 3, 36, 4));
    endWindow();
    // The poll: 0.2 s unheard, then listening again.
    const n = pushed.length;
    send(drive(3_200_000, 1, 36, 4));
    const after = pushed.slice(n + 1);
    expect(after.length).toBeGreaterThanOrEqual(8);
    expect(Math.min(...after.map((s) => s.tUs))).toBeGreaterThanOrEqual(3_200_000);
  });

  test("stopped: no more samples", () => {
    const { f, pushed, send, listening } = feed(VIN);
    send(drive(0, 3, 36, 4));
    f.stop();
    expect(listening()).toBe(false);
    const n = pushed.length;
    send(drive(3_000_000, 1, 36, 4));
    expect(pushed).toHaveLength(n);
  });

  // VEHICLE-LINK-SPEC §16.5: decoded for the check, but nothing to the navigator until it passed.
  test("a profile on probation: decoded for the check only, then from its pass the navigator's", () => {
    const { f, pushed, notes, wheelSamples, decoded, send } = feed(VIN, undefined, () => false);
    send(drive(0, 3, 36, 4));
    expect(f.profile?.key).toMatch(/^mazda\//);
    expect(decoded.length).toBeGreaterThanOrEqual(28);
    expect(pushed).toHaveLength(0);
    expect(wheelSamples).toHaveLength(0);
    expect(notes).toEqual([]);
    f.promote();
    expect(notes).toEqual([expect.stringMatching(/^can primary: speed from the wheels, profile mazda\//)]);
    send(drive(3_000_000, 1, 36, 4));
    expect(pushed.length).toBeGreaterThanOrEqual(8);
    expect(wheelSamples.length).toBeGreaterThanOrEqual(8);
  });
});
