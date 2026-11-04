// JS side of modules/sensor-capture: payload decoding and SensorService lifecycle against a mocked native module.
import { decodeImuBatch, SensorService, toGnssRecord } from "../sensor-service";

type Listener = (e: any) => void;

// A phone unless a test says otherwise (a getter: the namespace import copies plain values once).
jest.mock("expo-device", () => {
  const state = { isDevice: true };
  return { __state: state, get isDevice() { return state.isDevice; } };
});
const mockDevice: { isDevice: boolean } = jest.requireMock("expo-device").__state;

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

  test("GNSS: a simulator's fixes are all simulated, and its only GPS: not flagged there, only on a phone", () => {
    const fix = { tUs: 1, utcUs: 1, deliveryDelayUs: 0, lat: 50.45, lon: 30.52, simulated: true, fromAccessory: false };
    expect(toGnssRecord(fix).flags).toBe(1);
    mockDevice.isDevice = false;
    try {
      expect(toGnssRecord(fix).flags).toBe(0);
    } finally {
      mockDevice.isDevice = true;
    }
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

  test("IMU: the magnetometer rows an older native build sends are ignored", () => {
    const motionRow = [12_500_000, 0.1, 0.2, 0.3, 9.8, 0, 0, 0, 0, -9.8, 1, 0, 0, 0];
    const batch = { motion: motionRow, gyro: [], accel: [], mag: [3, 20, -5, -45] };
    const decoded = decodeImuBatch(batch);
    expect(Object.keys(decoded).sort()).toEqual(["accel", "gyro", "motion"]);
    expect(decoded.motion).toHaveLength(1);
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
    expect(mockNative.startImu).toHaveBeenCalledWith({ rateHz: 100, raw: false, batchMs: 100, magRateHz: 0 });
    expect(s.getSnapshot()).toMatchObject({ gnssRunning: true, imuRunning: true });

    s.want(true, false);
    await flush();
    expect(mockNative.stopImu).toHaveBeenCalledTimes(1);
    expect(mockNative.stopGnss).not.toHaveBeenCalled();
    expect(s.getSnapshot().imuRunning).toBe(false);
  });

  test("capture runs for the union of owners", async () => {
    const s = new SensorService();
    s.want(true, true, "recorder");
    s.want(true, false, "position");
    await flush();
    s.want(false, false, "recorder");
    await flush();
    expect(mockNative.stopImu).toHaveBeenCalledTimes(1);
    expect(mockNative.stopGnss).not.toHaveBeenCalled();
    s.want(false, false, "position");
    await flush();
    expect(mockNative.stopGnss).toHaveBeenCalledTimes(1);
  });

  test("a start that failed (no permission yet) is retried on the next want()", async () => {
    mockNative.startGnss.mockResolvedValueOnce(false);
    const s = new SensorService();
    s.want(true, false, "position");
    await flush();
    expect(s.getSnapshot().gnssRunning).toBe(false);
    s.want(true, false, "position");
    await flush();
    expect(mockNative.startGnss).toHaveBeenCalledTimes(2);
    expect(s.getSnapshot().gnssRunning).toBe(true);
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
    mockEmit("onImuBatch", { motion: [1, 0, 0, 0.1, 0, 0, 0, 0, 0, -9.8, 1, 0, 0, 0], gyro: [], accel: [], mag: [] });
    mockEmit("onGnssError", { message: "denied", code: 1 });
    expect(fixes).toHaveLength(1);
    expect((fixes[0] as { flags: number }).flags).toBe(1);
    expect(batches).toHaveLength(1);
    expect(s.getSnapshot().lastError).toBe("denied");
  });

  test("a simulator without device motion is a still, upright phone at 100 Hz; a phone without it gets none", async () => {
    jest.useFakeTimers();
    let nowUs = 1_000_000;
    mockNative.nowUs.mockImplementation(() => nowUs);
    mockNative.startImu.mockResolvedValue(false);
    try {
      const phone = new SensorService();
      phone.want(false, true);
      await flush();
      expect(phone.getSnapshot().imuRunning).toBe(false);

      mockDevice.isDevice = false;
      const sim = new SensorService();
      const batches: ReturnType<typeof decodeImuBatch>[] = [];
      sim.imu.on((b) => batches.push(b));
      sim.want(false, true);
      await flush();
      expect(sim.getSnapshot().imuRunning).toBe(true);
      for (let i = 0; i < 3; i++) {
        nowUs += 100_000;
        jest.advanceTimersByTime(100);
      }
      const samples = batches.flatMap((b) => b.motion);
      expect(samples).toHaveLength(30);
      expect(samples[1].timestampUs - samples[0].timestampUs).toBe(10_000);
      expect(samples[0].gyro).toEqual([0, 0, 0]);
      expect(samples[0].gravity[1]).toBeCloseTo(-9.81, 2);

      sim.want(false, false);
      await flush();
      nowUs += 100_000;
      jest.advanceTimersByTime(100);
      expect(batches.flatMap((b) => b.motion)).toHaveLength(30);
      expect(mockNative.stopImu).not.toHaveBeenCalled();
    } finally {
      mockDevice.isDevice = true;
      mockNative.nowUs.mockImplementation(() => 0);
      mockNative.startImu.mockImplementation(async () => true);
      jest.useRealTimers();
    }
  });

  test("the IMU starts at 100 Hz without the raw streams; an older native build's magnetometer stays off", async () => {
    const s = new SensorService();
    s.want(false, true);
    await flush();
    expect(mockNative.startImu).toHaveBeenLastCalledWith({ rateHz: 100, raw: false, batchMs: 100, magRateHz: 0 });
  });
});
