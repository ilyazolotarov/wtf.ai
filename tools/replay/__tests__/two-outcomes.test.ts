import { moreBadByChance, twoOutcomes } from "../two-outcomes";

describe("twoOutcomes", () => {
  test("fwx8ms parked, off the drawn road (2026-10-28): two outcomes, 4 of 8 bad → 5 of 8, within chance", () => {
    const before = [30, 8, 216, 12, 205, 119, 40, 186];
    const now = [13, 189, 41, 203, 142, 201, 202, 33];
    const line = twoOutcomes(before, now, 10)!;
    expect(line).toBeGreaterThan(41);
    expect(line).toBeLessThan(119);
    expect(before.filter((x) => x > line)).toHaveLength(4);
    expect(now.filter((x) => x > line)).toHaveLength(5);
    expect(moreBadByChance(4, 8, 5, 8)).toBeGreaterThan(0.05);
  });

  test("off the roads at speed, ~5 s or ~60–100 s: two outcomes", () => {
    expect(twoOutcomes([3, 101, 64, 62, 0, 1, 7, 2], [51, 101, 64, 62, 0, 1, 7, 2], 10)).not.toBeNull();
  });

  test("a bad outcome new in this run is no coin flip: the usual rule judges it", () => {
    expect(twoOutcomes([0, 1, 0, 2, 0, 3, 1, 0], [0, 1, 500, 2, 480, 3, 1, 0], 10)).toBeNull();
  });

  test("one far seed is no second outcome", () => {
    expect(twoOutcomes([0, 0, 0, 5, 0, 0, 0, 0], [35, 3, 0, 9, 0, 0, 0, 0], 10)).toBeNull();
  });

  test("seeds spread evenly have no two outcomes", () => {
    expect(twoOutcomes([10, 20, 30, 40, 50, 60, 70, 80], [15, 25, 35, 45, 55, 65, 75, 85], 10)).toBeNull();
  });
});

describe("moreBadByChance", () => {
  test("none bad before, half bad now: beyond chance", () => {
    expect(moreBadByChance(0, 8, 4, 8)).toBeCloseTo(70 / 1820, 6);
  });

  test("as many bad: about even", () => {
    expect(moreBadByChance(4, 8, 4, 8)).toBeGreaterThan(0.5);
  });

  test("fewer bad now: no sign of worse", () => {
    expect(moreBadByChance(6, 8, 1, 8)).toBeGreaterThan(0.99);
  });
});
