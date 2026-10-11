import { CAN_SPEED_PERIOD_US, canSpeedSamples } from "../can-speed";
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
});
