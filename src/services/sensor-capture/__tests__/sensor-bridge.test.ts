// JS side of modules/sensor-capture: payload decoding and SensorService lifecycle against a mocked native module.
import { decodeImuBatch, SensorService, toGnssRecord } from "../sensor-service";

type Listener = (e: any) => void;

jest.mock("../../../../modules/sensor-capture/src/SensorCaptureModule", () => {
  const listeners = new Map<string, Set<(e: any) => void>>();
  const native = {
    nowUs: jest.fn(() => 0),
    getPermissions: jest.fn(async () => ({ location: "whenInUse", accuracy: "full" })),
    requestLocationPermission: jest.fn(async () => "whenInUse"),
    startGnss: jest.fn(async () => true),
    stopGnss: jest.fn(async () => undefined),
    startImu: jest.fn(async (_options: any) => true),
    stopImu: jest.fn(async () => undefined),
    addListener: jest.fn((name: string, fn: (e: any) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(fn);
      return { remove: () => listeners.get(name)!.delete(fn) };
    }),
  };
  return {
    __esModule: true,
    default: native,
    MOTION_ROW: 14,
    RAW_ROW: 4,
    __listeners: listeners,
    __emit: (name: string, payload: unknown) => listeners.get(name)?.forEach((fn) => fn(payload)),
  };
});


const mocked = jest.requireMock("../../../../modules/sensor-capture/src/SensorCaptureModule");
const mockNative = mocked.default;
const mockListeners: Map<string, Set<Listener>> = mocked.__listeners;
const mockEmit: (name: string, payload: unknown) => void = mocked.__emit;

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("payload decoding (row layouts shared with SensorLogic.swift)", () => {
  test("GNSS: missing (invalid) fields become NaN; flags packed", () => {
    const r = toGnssRecord({
      tUs: 1_000_000.4,
      utcUs: 1.791e15,
      deliveryDelayUs: 250_000,
      lat: 50.45,
      lon: 30.52,
      hAcc: 4.5,
      speed: 13.9,
      simulated: false,
      fromAccessory: true,
    });
    expect(r).toMatchObject({ timestampUs: 1_000_000, latDeg: 50.45, hAccM: 4.5, speedMps: 13.9, flags: 2 });
    expect(r.vAccM).toBeNaN();
    expect(r.altMslM).toBeNaN();
    expect(r.speedAccMps).toBeNaN();
    expect(r.courseRad).toBeNaN();
  });

  test("IMU: 14-value motion rows, 4-value raw rows, partial rows ignored", () => {
    const motionRow = [12_500_000, 0.1, 0.2, 0.3, 9.8, 0, 0, 0, 0, -9.8, 1, 0, 0, 0];
    const decoded = decodeImuBatch({
      motion: [...motionRow, ...motionRow.map((v, i) => (i === 0 ? v + 10_000 : v)), 1, 2, 3],
      gyro: [1, 0.1, 0.2, 0.3],
      accel: [2, 0, 0, 9.8, 99],
    });
    expect(decoded.motion).toHaveLength(2);
    expect(decoded.motion[0]).toEqual({
      timestampUs: 12_500_000,
      gyro: [0.1, 0.2, 0.3],
      userAccel: [9.8, 0, 0],
      gravity: [0, 0, -9.8],
      attitude: [1, 0, 0, 0],
    });
    expect(decoded.motion[1].timestampUs).toBe(12_510_000);
    expect(decoded.gyro).toEqual([{ timestampUs: 1, v: [0.1, 0.2, 0.3] }]);
    expect(decoded.accel).toEqual([{ timestampUs: 2, v: [0, 0, 9.8] }]);
  });
});

describe("SensorService", () => {
  beforeEach(() => {
    mockListeners.clear();
    jest.clearAllMocks();
  });

  test("want() starts and stops native capture idempotently", async () => {
    const s = new SensorService();
    await flush();
    expect(s.getSnapshot().permission).toBe("whenInUse");

    s.want(true, true);
    s.want(true, true);
    await flush();
    expect(mockNative.startGnss).toHaveBeenCalledTimes(1);
    expect(mockNative.startImu).toHaveBeenCalledWith({ rateHz: 100, raw: false, batchMs: 100 });
    expect(s.getSnapshot()).toMatchObject({ gnssRunning: true, imuRunning: true });

    s.want(true, false);
    await flush();
    expect(mockNative.stopImu).toHaveBeenCalledTimes(1);
    expect(mockNative.stopGnss).not.toHaveBeenCalled();
    expect(s.getSnapshot().imuRunning).toBe(false);
  });

  test("missing location permission is reported, not thrown", async () => {
    mockNative.startGnss.mockResolvedValueOnce(false);
    const s = new SensorService();
    s.want(true, false);
    await flush();
    expect(s.getSnapshot()).toMatchObject({ gnssRunning: false, lastError: "location permission missing" });
  });

  test("native events fan out as records", async () => {
    const s = new SensorService();
    const fixes: unknown[] = [];
    const batches: unknown[] = [];
    s.gnss.on((f) => fixes.push(f));
    s.imu.on((b) => batches.push(b));
    mockEmit("onGnss", { tUs: 5, utcUs: 6, deliveryDelayUs: 0, lat: 1, lon: 2, simulated: true, fromAccessory: false });
    mockEmit("onImuBatch", { motion: [1, 0, 0, 0.1, 0, 0, 0, 0, 0, -9.8, 1, 0, 0, 0], gyro: [], accel: [] });
    mockEmit("onGnssError", { message: "denied", code: 1 });
    expect(fixes).toHaveLength(1);
    expect((fixes[0] as { flags: number }).flags).toBe(1);
    expect(batches).toHaveLength(1);
    expect(s.getSnapshot().lastError).toBe("denied");
  });

  test("changing IMU settings while running restarts capture with the new options", async () => {
    const s = new SensorService();
    s.want(false, true);
    await flush();
    s.setImuSettings({ rateHz: 50, raw: true });
    await flush();
    expect(mockNative.stopImu).toHaveBeenCalledTimes(1);
    expect(mockNative.startImu).toHaveBeenLastCalledWith({ rateHz: 50, raw: true, batchMs: 100 });
  });
});
