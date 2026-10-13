import { FrameRetimer, retimeFrames } from "../frame-timing";

/** A 100 Hz id the link delivers in bursts: every 0.15 s, 15 frames within a millisecond. */
function bursty(fromUs: number, seconds: number, id = 0x215) {
  const out: { tUs: number; id: number }[] = [];
  for (let k = 0; k < seconds * 100; k++) out.push({ id, tUs: fromUs + (Math.floor(k / 15) + 1) * 150_000 + (k % 15) * 50 });
  return out;
}

describe("CAN frames at bus time (NAVIGATOR-SPEC §5.4)", () => {
  // 2026-10-13: over the MX+'s MFi link half the frames came within 1 ms of the one before.
  test("a bursty link: the frames laid back on their 10 ms period", () => {
    const frames = retimeFrames(bursty(1_000_000, 5));
    const gaps = frames.slice(60).map((f, i) => f.tUs - frames[59 + i].tUs);
    // After the first spans set the period: evenly 10 ms apart (not 0.05 ms and 150 ms).
    expect(Math.min(...gaps)).toBeGreaterThan(9_000);
    expect(Math.max(...gaps)).toBeLessThan(11_000);
  });

  test("never after a frame arrived, nor further before it than a burst could hold it", () => {
    const arrived = bursty(1_000_000, 5);
    const frames = retimeFrames(arrived);
    frames.forEach((f, i) => {
      expect(f.tUs).toBeLessThanOrEqual(arrived[i].tUs);
      expect(arrived[i].tUs - f.tUs).toBeLessThanOrEqual(300_000);
    });
  });

  test("a long break in listening (a stall): the next frame on its arrival, the period kept", () => {
    const r = new FrameRetimer();
    let t = 0;
    for (let k = 0; k < 50; k++) r.retime(0x215, (t = 1_000_000 + k * 10_000));
    const after = t + 2_000_000;
    expect(r.retime(0x215, after)).toBe(after);
    expect(r.retime(0x215, after + 50)).toBeCloseTo(after + 50, -1);
    // Another id has its own clock.
    expect(r.retime(0x228, after + 100)).toBe(after + 100);
  });

  // 2026-10-12: laid one period after the last frame before it, every frame after a poll's 0.16 s break came that
  // much early, the wheels' turning up to 0.1 s ahead of the gyro.
  test("the polls' short breaks (the windows' ends): each id again on its arrival, the period not stretched by the frames unheard", () => {
    // 0.34 s heard, 0.16 s unheard, ten times; on time (no bursts).
    const arrived: { tUs: number; id: number }[] = [];
    const windows: { endUs: number }[] = [];
    for (let w = 0; w < 10; w++) {
      for (let k = 0; k < 34; k++) arrived.push({ id: 0x215, tUs: w * 500_000 + k * 10_000 });
      windows.push({ endUs: w * 500_000 + 340_000 });
    }
    const frames = retimeFrames(arrived, windows);
    frames.forEach((f, i) => expect(Math.abs(f.tUs - arrived[i].tUs)).toBeLessThan(1_000));
    // Without the windows each run after a break starts one period after the last frame: 0.16 s early.
    const blind = retimeFrames(arrived);
    expect(blind[34].tUs).toBeLessThan(arrived[34].tUs - 100_000);
  });
});
