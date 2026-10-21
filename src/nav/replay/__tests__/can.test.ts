import { busTimedFrames } from "@/nav/replay/can";
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
