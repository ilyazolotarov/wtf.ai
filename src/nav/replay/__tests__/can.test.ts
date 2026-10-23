import { busTimedFrames, canPrimaryFromUs, canPrimaryInput, decodeTripCan, obdFromCan, tripWheelSamples } from "@/nav/replay/can";
import type { TripLog } from "@/triplog/trip-log-reader";

const frame = (tS: number) => ({ tUs: tS * 1e6, id: 0x215, data: [0] });
const trip = (frames: number[], windows: [number, number][]) =>
  ({ can: frames.map(frame), canWindows: windows.map(([s, e]) => ({ startUs: s * 1e6, endUs: e * 1e6 })) }) as unknown as TripLog;

test("a frame drained after its window ended is at the window's end", () => {
  const out = busTimedFrames(trip([1, 1.9, 2.4, 3.5, 5], [[1, 2], [5, 6]]));
  expect(out.map((f) => f.tUs / 1e6)).toEqual([1, 1.9, 2, 2, 5]);
});

test("the app died in a window the log has no record of: its frames keep their arrival", () => {
  // The last recorded window ends at 2 s; the one after it never closed.
  const out = busTimedFrames(trip([1.5, 2.5, 10, 400], [[1, 2]]));
  expect(out.map((f) => f.tUs / 1e6)).toEqual([1.5, 2, 10, 400]);
});

describe("obdFromCan", () => {
  const can = (tS: number, kmh: number) => ({ tUs: tS * 1e6, speedMps: kmh / 3.6, rawKph: Math.abs(kmh), source: "can" as const });
  const logged = (speeds: ReturnType<typeof can>[]) =>
    ({ info: { can_primary: "on" }, messages: [{ tUs: 0, tag: "app", text: "can primary: speed from the wheels, profile x" }], obdSpeed: speeds }) as unknown as TripLog;

  test("2 Hz polls in whole km/h, fed as OBD; 0 in reverse; none across a gap with no speed", () => {
    const speeds = [can(0, 10.4), can(0.1, 10.6), can(0.5, 50.5), can(1, -7), can(1.4, -7), can(5, 30)];
    const out = obdFromCan(logged(speeds));
    expect(out.obdSpeed.map((s) => [s.tUs / 1e6, s.rawKph])).toEqual([[0, 10], [0.5, 51], [1, 0], [1.5, 0], [2, 0], [5, 30]]);
    expect(out.obdSpeed.every((s) => s.source === undefined && s.speedMps === s.rawKph / 3.6)).toBe(true);
    // Not CAN primary: the app replay keeps these instead of decoding the wheels again.
    expect(canPrimaryInput(out).obdSpeed).toBe(out.obdSpeed);
  });
});

describe("canPrimaryFromUs", () => {
  const note = (tS: number, text: string) => ({ tUs: tS * 1e6, tag: "app", text });
  const log = (canPrimary: string, messages: ReturnType<typeof note>[]) => ({ info: { can_primary: canPrimary }, messages }) as unknown as TripLog;
  const checking = note(5, "can probation: checking mazda/mazda/mazda_2017 against OBD speed, the navigator stays on OBD");
  const primary = note(200, "can primary: speed from the wheels, profile mazda/mazda/mazda_2017");

  test("recorded with CAN primary, no probation: the whole drive", () => {
    expect(canPrimaryFromUs(log("on", [primary]))).toBe(-Infinity);
    expect(canPrimaryFromUs(log("on", []))).toBe(-Infinity);
  });

  test("turned on mid-drive: the whole drive (no CAN was heard before the note)", () => {
    expect(canPrimaryFromUs(log("off", [primary]))).toBe(-Infinity);
  });

  test("on probation: from the pass; without one, never", () => {
    expect(canPrimaryFromUs(log("on", [checking, primary]))).toBe(200e6);
    expect(canPrimaryFromUs(log("on", [checking]))).toBeNull();
  });

  test("a profile failed on an earlier drive, or a search on the bus: never (the frames were the check's or the search's)", () => {
    const failed = note(3, "can probation: mazda/mazda/mazda_2017 failed on an earlier drive (scale), OBD speed stays");
    expect(canPrimaryFromUs(log("on", [failed]))).toBeNull();
    const searching = note(3, "can discovery: listening to 215 202 for a speed, 0 of 4 ids tried");
    expect(canPrimaryFromUs(log("on", [searching]))).toBeNull();
    expect(canPrimaryFromUs(log("on", [searching, note(9, "can probation: checking found/215/8/b0be16s0x0.01o10000 against OBD speed"), primary]))).toBe(200e6);
  });

  test("CAN primary off: never", () => {
    expect(canPrimaryFromUs(log("off", []))).toBeNull();
  });
});

describe("a speed the app found on the car's bus (VEHICLE-LINK-SPEC §16.6)", () => {
  const KEY = "found/3f1/8/b0be16s0x0.01o10000+b2be16s0x0.01o10000+b4be16s0x0.01o10000+b6be16s0x0.01o10000";
  /** 10 s at 36 km/h, 50 Hz: four big-endian 16-bit wheels at 0.01 km/h from −100 km/h. */
  const frames = Array.from({ length: 500 }, (_, i) => {
    const v = (36 + 100) * 100;
    return { tUs: i * 20_000, id: 0x3f1, data: [0, 2, 4, 6].flatMap(() => [v >> 8, v & 0xff]) };
  });
  const log = (vin: string) =>
    ({
      info: { vehicle_vin: vin, can_shadow: "3F1" },
      can: frames,
      canWindows: [],
      messages: [{ tUs: 0, tag: "app", text: `can probation: checking ${KEY} against OBD speed, the navigator stays on OBD` }],
      obdSpeed: [],
    }) as unknown as TripLog;

  test("two finds on a drive: the one the wheels' speed came from, not the one probation refuted", () => {
    const refuted = "found/3f1/8/b0be16s0x0.02o5000";
    const trip = log("XXXAAAAAA00000000");
    trip.messages.unshift({ tUs: 0, tag: "app", text: `can probation: checking ${refuted} against OBD speed, the navigator stays on OBD` } as never);
    trip.messages.push({ tUs: 9e6, tag: "app", text: `can primary: speed from the wheels, profile ${KEY} (its speed message: no wheel speeds)` } as never);
    expect(decodeTripCan(trip)?.profile?.key).toBe(KEY);
    // Without the wheels' note, the last one checked.
    trip.messages.pop();
    expect(decodeTripCan(trip)?.profile?.key).toBe(KEY);
  });

  test("a find with its wheels' order: the wheels turn the car, below 11 km/h flagged as without a gear", () => {
    const trip = log("XXXAAAAAA00000000");
    trip.messages = [{ tUs: 0, tag: "app", text: `can primary: speed from the wheels, profile ${KEY}/w1032` } as never];
    const can = decodeTripCan(trip);
    expect(can?.profile?.key).toBe(`${KEY}/w1032`);
    const wheels = tripWheelSamples(can);
    expect(wheels.length).toBeGreaterThan(90);
    expect(wheels.every((w) => w.noGear && Math.abs(w.speedMps * 3.6 - 36) < 1e-6)).toBe(true);
    // Without the order: no wheels, the phone's gyro turns it.
    expect(tripWheelSamples(decodeTripCan(log("XXXAAAAAA00000000")))).toEqual([]);
  });

  test("rebuilt from the log's note, for a car of a make with profiles too (none of its ids heard) as for one without", () => {
    // Made-up VINs: a make the app has profiles for, and one it hasn't.
    for (const vin of ["KMHAAAAAA00000000", "XXXAAAAAA00000000"]) {
      const can = decodeTripCan(log(vin));
      expect(can?.profile?.key).toBe(KEY);
      const speeds = can!.samples.filter((s) => s.q === "speed");
      expect(speeds.length).toBeGreaterThan(400);
      expect(speeds.every((s) => s.q === "speed" && Math.abs(s.v * 3.6 - 36) < 1e-6)).toBe(true);
    }
  });
});
