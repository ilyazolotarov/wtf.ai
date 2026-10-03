import { headingUpRad, travelHeadingRad } from "@/components/map/use-compass-heading";
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
    expect(headingUpRad(null, null)).toBe(0);
  });
});
