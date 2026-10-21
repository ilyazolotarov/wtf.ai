import { busTimedFrames, canPrimaryInput, obdFromCan } from "@/nav/replay/can";
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
