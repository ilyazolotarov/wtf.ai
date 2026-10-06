import { headingUpRad, holdHeading, mapBearingDeg, travelHeadingRad } from "@/components/map/use-compass-heading";
import type { PositionEstimate } from "@/nav/position/types";

jest.mock("expo-location", () => ({}));

const at = (p: Partial<PositionEstimate>): PositionEstimate => ({
  lat: 50.45,
  lon: 30.52,
  accuracyM: 5,
  source: "gnss",
  trust: "TRUSTED",
  timestamp: 0,
  ...p,
});

describe("heading-up", () => {
  test("navigator heading holds while the car stands", () => {
    expect(travelHeadingRad(at({ source: "dr", headingRad: 1, speedMps: 0 }))).toBe(1);
    expect(travelHeadingRad(at({ source: "fused", headingRad: 1, speedMps: 0 }))).toBe(1);
  });

  test("GNSS course counts only when moving", () => {
    expect(travelHeadingRad(at({ headingRad: 1, speedMps: 1 }))).toBeUndefined();
    expect(travelHeadingRad(at({ headingRad: 1 }))).toBeUndefined();
    expect(travelHeadingRad(at({ headingRad: 1, speedMps: 5 }))).toBe(1);
  });

  test("walking compass first, held heading last", () => {
    const compass = { headingRad: 2, uncertaintyRad: 0.3 };
    expect(headingUpRad(at({ source: "dr", headingRad: 1 }), compass, 3)).toBe(2);
    expect(headingUpRad(at({ headingRad: 1, speedMps: 0 }), null, 3)).toBe(3);
    expect(headingUpRad(null, null)).toBeNull();
  });

  test("held through a stop, dropped when moving without a direction (anchored under jamming)", () => {
    expect(holdHeading(at({ source: "dr", headingRad: 1, speedMps: 10 }), null)).toBe(1);
    expect(holdHeading(at({ speedMps: 0 }), 1)).toBe(1);
    expect(holdHeading(at({ speedMps: 10 }), 1)).toBeNull();
    expect(headingUpRad(at({ speedMps: 10 }), null, holdHeading(at({ speedMps: 10 }), 1))).toBeNull();
  });

  test("map bearing is never negative (iOS ignores a negative one)", () => {
    expect(mapBearingDeg(-Math.PI / 2)).toBeCloseTo(270);
    expect(mapBearingDeg((-170 * Math.PI) / 180)).toBeCloseTo(190);
    expect(mapBearingDeg(Math.PI / 2)).toBeCloseTo(90);
    expect(mapBearingDeg(2 * Math.PI)).toBeCloseTo(0);
    expect(mapBearingDeg(-0.000001)).toBeLessThan(360);
  });
});
