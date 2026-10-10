import { isLost } from "@/components/map/use-placing";
import type { PositionEstimate } from "@/nav/position/types";

const at = (p: Partial<PositionEstimate>): PositionEstimate => ({
  lat: 50.45,
  lon: 30.52,
  accuracyM: 5,
  source: "dr",
  trust: "NO_FIX",
  timestamp: 0,
  headingRad: 0,
  ...p,
});

describe("offering to put the car on the map", () => {
  test("not without a position, nor with trusted GPS however rough", () => {
    expect(isLost(null)).toBe(false);
    expect(isLost(at({ trust: "TRUSTED", accuracyM: 500, headingRad: undefined }))).toBe(false);
  });

  test("a tight dot with a heading on a road is not lost", () => {
    expect(isLost(at({}))).toBe(false);
  });

  test("rough, no direction or off any road", () => {
    expect(isLost(at({ accuracyM: 80 }))).toBe(true);
    expect(isLost(at({ headingRad: undefined }))).toBe(true);
    expect(isLost(at({ mapMatch: "offroad" }))).toBe(true);
  });

  test("a confident dot a long way on dead reckoning", () => {
    expect(isLost(at({ distanceSinceTrustedM: 4000 }))).toBe(false);
    expect(isLost(at({ distanceSinceTrustedM: 6000 }))).toBe(true);
  });
});
