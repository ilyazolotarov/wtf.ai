import { CAN_SPEED_PERIOD_US, canSpeedSamples } from "../can-speed";
import { wheelYawSamples } from "../wheel-yaw";
import type { CarStateSample } from "../car-state";

const wheels = (tUs: number, kph: number): CarStateSample => ({ q: "wheels", tUs, v: [kph / 3.6, kph / 3.6, kph / 3.6, kph / 3.6] });

describe("CAN speed samples", () => {
  test("wheel samples averaged per period, at their mean time", () => {
    const s = canSpeedSamples([wheels(0, 36), wheels(10_000, 36.2), wheels(20_000, 36.4), wheels(CAN_SPEED_PERIOD_US, 40)]);
    expect(s).toHaveLength(2);
    expect(s[0].tUs).toBe(10_000);
    expect(s[0].speedMps * 3.6).toBeCloseTo(36.2, 6);
    expect(s[1].speedMps * 3.6).toBeCloseTo(40, 6);
  });

  test("a standing car is exactly 0 (0.01·raw − 100 in floating point isn't)", () => {
    const raw = 10_000 * 0.01 - 100;
    const s = canSpeedSamples([{ q: "wheels", tUs: 0, v: [raw, raw, raw, raw] }]);
    expect(s[0].speedMps).toBe(0);
  });

  test("the gear gives the direction while it is fresh", () => {
    const s = canSpeedSamples([
      { q: "gear", tUs: 0, gear: "R", raw: 2 },
      wheels(50_000, 5),
      wheels(5_000_000, 5),
    ]);
    expect(s.map((x) => [x.gear, x.reverse])).toEqual([
      ["R", true],
      [null, false],
    ]);
  });

  // 2026-10-12: a monitor line that lost characters still parses as 8 bytes.
  test("a garbled frame (wheels no car turns at, or a jump no car makes) is left out", () => {
    const s = canSpeedSamples([
      wheels(0, 50),
      { q: "wheels", tUs: 10_000, v: [195, 36, 210, 187].map((k) => k / 3.6) as [number, number, number, number] },
      wheels(20_000, 50.1),
      wheels(30_000, 70),
      wheels(40_000, 50.2),
    ]);
    expect(s).toHaveLength(1);
    expect(s[0].speedMps * 3.6).toBeCloseTo(50.1, 6);
  });

  // 2026-10-14: dropped there, the navigator lost the turning in the middle of the roundabout.
  test("a tight roundabout at walking pace, the outer front wheel 50 % faster than the inner rear, is kept", () => {
    const turn = (tUs: number): CarStateSample => ({ q: "wheels", tUs, v: [4.69, 3.73, 4.28, 3.03] });
    expect(canSpeedSamples([turn(0), turn(10_000)])).toHaveLength(1);
  });

  test("the wheels keep their exact mean: the yaw rate is in their differences", () => {
    const k = (kph: number) => kph / 3.6;
    const s = canSpeedSamples([
      { q: "wheels", tUs: 0, v: [k(36), k(36), k(36), k(36.01)] },
      { q: "wheels", tUs: 10_000, v: [k(36), k(36), k(36), k(36)] },
    ]);
    expect((s[0].wheelsMps[3] - s[0].wheelsMps[2]) * 3.6).toBeCloseTo(0.005, 9);
  });
});

describe("wheel yaw", () => {
  const sample = (rl: number, rr: number, reverse = false) => ({ tUs: 0, speedMps: 0, wheelsMps: [0, 0, rl, rr] as [number, number, number, number], gear: null, reverse });

  test("the right rear wheel faster turns the car left (positive), by the difference over the track", () => {
    expect(wheelYawSamples([sample(5, 5.16)], 1.6)[0].radps).toBeCloseTo(0.1, 9);
  });

  test("in reverse the same difference turns it the other way", () => {
    expect(wheelYawSamples([sample(2, 2.16, true)], 1.6)[0].radps).toBeCloseTo(-0.1, 9);
  });
});
