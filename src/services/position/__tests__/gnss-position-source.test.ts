import type { LocationObject } from "expo-location";

import { mapLocationToPosition } from "@/services/position/gnss-position-source";

function makeLocation(
  overrides: Partial<LocationObject["coords"]> = {},
): LocationObject {
  return {
    coords: {
      latitude: 50.45,
      longitude: 30.52,
      altitude: 180,
      accuracy: 4.5,
      altitudeAccuracy: 3,
      heading: 90,
      speed: 12,
      ...overrides,
    },
    timestamp: 1_800_000_000_000,
  };
}

describe("GNSS position mapping", () => {
  test("maps degrees to radians and preserves valid speed and accuracy", () => {
    const estimate = mapLocationToPosition(makeLocation());
    expect(estimate).toMatchObject({
      lat: 50.45,
      lon: 30.52,
      headingRad: Math.PI / 2,
      speedMps: 12,
      accuracyM: 4.5,
      source: "gnss",
      trust: "TRUSTED",
      timestamp: 1_800_000_000_000,
      lastTrustedFixAt: 1_800_000_000_000,
    });
  });

  test("omits unavailable heading and negative speed", () => {
    const estimate = mapLocationToPosition(
      makeLocation({ heading: -1, speed: -1 }),
    );
    expect(estimate.headingRad).toBeUndefined();
    expect(estimate.speedMps).toBeUndefined();
  });

  test("uses a conservative accuracy when the provider omits it", () => {
    expect(
      mapLocationToPosition(makeLocation({ accuracy: null })).accuracyM,
    ).toBe(9999);
  });
});
