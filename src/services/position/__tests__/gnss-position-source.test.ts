import { Emitter } from "@/obd/emitter";
import { GnssPositionSource, mapFixToPosition } from "@/services/position/gnss-position-source";
import type { SensorService } from "@/services/sensor-capture/sensor-service";
import type { GnssRecord } from "@/triplog/schema";

jest.mock("expo-location", () => ({
  getForegroundPermissionsAsync: jest.fn(async () => ({ granted: true, status: "granted" })),
  requestForegroundPermissionsAsync: jest.fn(async () => ({ granted: true, status: "granted" })),
}));

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

function fakeSensors() {
  const gnss = new Emitter<[GnssRecord]>();
  const want = jest.fn();
  return { sensors: { gnss, want } as unknown as SensorService, gnss, want };
}

describe("GNSS position mapping", () => {
  test("maps a native fix, course in radians, time in ms", () => {
    expect(mapFixToPosition(fix())).toMatchObject({
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

  test("invalid (NaN) course, speed, and accuracy", () => {
    const p = mapFixToPosition(fix({ courseRad: NaN, speedMps: NaN, hAccM: NaN }));
    expect(p.headingRad).toBeUndefined();
    expect(p.speedMps).toBeUndefined();
    expect(p.accuracyM).toBe(9999);
  });
});

describe("GnssPositionSource", () => {
  test("asks the shared sensor service for GNSS and releases it on stop", async () => {
    const { sensors, want } = fakeSensors();
    const source = new GnssPositionSource(sensors);
    await source.start();
    expect(want).toHaveBeenLastCalledWith(true, false, "position");
    source.stop();
    expect(want).toHaveBeenLastCalledWith(false, false, "position");
  });

  test("start() again re-requests capture without subscribing twice", async () => {
    const { sensors, gnss, want } = fakeSensors();
    const source = new GnssPositionSource(sensors);
    const seen = jest.fn();
    source.subscribe(seen);
    await source.start();
    await source.start();
    expect(want).toHaveBeenCalledTimes(2);
    gnss.emit(fix());
    expect(seen).toHaveBeenCalledTimes(1);
    source.stop();
  });

  test("a Wi-Fi fix (no speed) moves the position but isn't trusted GNSS", async () => {
    const { sensors, gnss } = fakeSensors();
    const source = new GnssPositionSource(sensors);
    await source.start();
    gnss.emit(fix({ speedMps: NaN, courseRad: NaN, hAccM: 12 }));
    expect(source.getSnapshot()).toMatchObject({ lat: 50.45, accuracyM: 12, trust: "NO_FIX" });
    gnss.emit(fix({ utcUs: 1_800_000_001_000_000 }));
    expect(source.getSnapshot()?.trust).toBe("TRUSTED");
    source.stop();
  });
});
