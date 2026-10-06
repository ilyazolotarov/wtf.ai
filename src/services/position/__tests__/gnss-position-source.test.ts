import { mapFixToPosition } from "@/services/position/gnss-position-source";
import type { GnssRecord } from "@/triplog/schema";

function fix(overrides: Partial<GnssRecord> = {}): GnssRecord {
  return {
    timestampUs: 5_000_000,
    utcUs: 1_800_000_000_000_000,
    latDeg: 50.45,
    lonDeg: 30.52,
    altMslM: 180,
    altEllipsoidM: 210,
    hAccM: 4.5,
    vAccM: 3,
    speedMps: 12,
    speedAccMps: 0.3,
    courseRad: Math.PI / 2,
    courseAccRad: 0.05,
    deliveryDelayUs: 10_000,
    flags: 0,
    ...overrides,
  };
}

describe("GNSS position mapping", () => {
  test("maps a native fix, course in radians, time in ms", () => {
    expect(mapFixToPosition(fix(), "TRUSTED", 1_799_999_999_000)).toMatchObject({
      lat: 50.45,
      lon: 30.52,
      headingRad: Math.PI / 2,
      speedMps: 12,
      accuracyM: 4.5,
      source: "gnss",
      trust: "TRUSTED",
      timestamp: 1_800_000_000_000,
      lastTrustedFixAt: 1_799_999_999_000,
    });
  });

  test("no trusted fix yet: no time since trusted, not this fix's time", () => {
    // A jammed start: integrity has trusted nothing, so the "Trusted GPS …" chip must not say "just now".
    expect(mapFixToPosition(fix({ hAccM: 2000 }), "NO_FIX", undefined).lastTrustedFixAt).toBeUndefined();
  });

  test("invalid (NaN) course, speed, and accuracy", () => {
    const p = mapFixToPosition(fix({ courseRad: NaN, speedMps: NaN, hAccM: NaN }));
    expect(p.headingRad).toBeUndefined();
    expect(p.speedMps).toBeUndefined();
    expect(p.accuracyM).toBe(9999);
  });
});
