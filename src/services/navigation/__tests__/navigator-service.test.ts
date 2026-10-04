import { syntheticDrive, type DriveSegment, type SyntheticDrive } from "@/nav/__fixtures__/synthetic-drive";
import { haversineM } from "@/nav/geo";
import type { GnssFix } from "@/nav/types";
import { Emitter } from "@/obd/emitter";
import type { EngineState, SpeedSample } from "@/obd/types";
import type { KeyValueStore } from "@/obd/vehicle-link-core";
import { CALIBRATION_KEY, CalibrationStore, PARKED_POSE_KEY, type StoredPose } from "@/services/navigation/calibration-store";
import { NavigatorService } from "@/services/navigation/navigator-service";
import type { decodeImuBatch } from "@/services/sensor-capture/sensor-service";
import type { GnssRecord, NavEstimateRecord } from "@/triplog/schema";

jest.mock("expo-location", () => ({
  getForegroundPermissionsAsync: jest.fn(async () => ({ granted: true, status: "granted" })),
  requestForegroundPermissionsAsync: jest.fn(async () => ({ granted: true, status: "granted" })),
}));

const PHONE = { model: "iPhone14,5", os: "ios 26.0" };
const VIN = "JMZKF0000TEST0001";
/** Wall clock = uptime + this (µs). */
const UTC_OFFSET_US = 1_800_000_000_000_000;

// Straights and 90° turns, alternating left and right: enough turns to measure the GNSS lag.
function cityDrive(turns: number): DriveSegment[] {
  const segments: DriveSegment[] = [
    { durationS: 5, speedMps: 0, yawRateDegS: 0 },
    { durationS: 10, speedMps: 12, yawRateDegS: 0 },
  ];
  for (let i = 0; i < turns; i++) {
    segments.push({ durationS: 15, speedMps: 12, yawRateDegS: 0 });
    segments.push({ durationS: 6, speedMps: 8, yawRateDegS: i % 2 ? -15 : 15 });
    segments.push({ durationS: 4, speedMps: 12, yawRateDegS: 0 });
  }
  segments.push({ durationS: 20, speedMps: 12, yawRateDegS: 0 });
  return segments;
}

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getJson: <T,>(key: string) => (data.has(key) ? (JSON.parse(data.get(key)!) as T) : null),
    setJson: (key, value) => void data.set(key, JSON.stringify(value)),
  };
}

function record(f: Partial<GnssFix> & Pick<GnssFix, "tUs" | "lat" | "lon">, overrides: Partial<GnssRecord> = {}): GnssRecord {
  return {
    timestampUs: f.tUs,
    utcUs: f.tUs + UTC_OFFSET_US,
    latDeg: f.lat,
    lonDeg: f.lon,
    altMslM: 180,
    altEllipsoidM: 210,
    hAccM: f.hAccM ?? 5,
    vAccM: 3,
    speedMps: f.speedMps ?? NaN,
    speedAccMps: f.speedAccMps ?? NaN,
    courseRad: f.courseRad ?? NaN,
    courseAccRad: f.courseAccRad ?? NaN,
    deliveryDelayUs: 50_000,
    flags: 0,
    ...overrides,
  };
}

/** The app around the service: fake sensors, vehicle link and clocks, driven by a synthetic trip. */
function harness(options: { vin?: string | null; store?: ReturnType<typeof memoryStore> } = {}) {
  const gnss = new Emitter<[GnssRecord]>();
  const imu = new Emitter<[ReturnType<typeof decodeImuBatch>]>();
  const speed = new Emitter<[SpeedSample]>();
  const engine = new Emitter<[EngineState, number]>();
  const want = jest.fn();
  const notes: string[] = [];
  const logged: NavEstimateRecord[] = [];
  const store = options.store ?? memoryStore();
  let nowUs = 1_000_000_000;
  jest.setSystemTime((nowUs + UTC_OFFSET_US) / 1000);
  const service = new NavigatorService({
    sensors: { gnss, imu, want } as never,
    link: {
      onSpeed: (l) => speed.on(l),
      onEngineState: (l) => engine.on(l),
      getSnapshot: () => ({ vehicle: options.vin === null ? null : ({ vin: options.vin ?? VIN } as never) }),
      expectedVin: () => (options.vin === undefined ? VIN : options.vin),
    },
    calibration: new CalibrationStore(store, PHONE),
    nowUs: () => nowUs,
    note: (text) => notes.push(text),
    log: (r) => logged.push(r),
  });

  /** Deliver a trip the way the phone does: IMU in 100 ms batches, OBD live, fixes 50 ms late. */
  function play(drive: SyntheticDrive, opts: { untilS?: number; withoutGnssFromS?: number; withoutObd?: boolean; onStep?: (tUs: number) => void } = {}) {
    const { trip } = drive;
    const endUs = trip.startUs + (opts.untilS ?? Infinity) * 1e6;
    const lastUs = Math.min(endUs, trip.imu.at(-1)!.tUs);
    // Resume where the clock is.
    let i = trip.imu.findIndex((s) => s.tUs > nowUs);
    let o = trip.obdSpeed.findIndex((s) => s.tUs > nowUs);
    let g = trip.gnss.findIndex((f) => f.tUs + 50_000 > nowUs);
    if (i < 0) i = trip.imu.length;
    if (o < 0) o = trip.obdSpeed.length;
    if (g < 0) g = trip.gnss.length;
    while (nowUs < lastUs) {
      nowUs += 100_000;
      const batch = [];
      while (i < trip.imu.length && trip.imu[i].tUs <= nowUs) {
        const s = trip.imu[i++];
        batch.push({ timestampUs: s.tUs, gyro: s.gyro, gravity: s.gravity, userAccel: s.userAccel, attitude: [1, 0, 0, 0] as [number, number, number, number] });
      }
      while (o < trip.obdSpeed.length && trip.obdSpeed[o].tUs <= nowUs) {
        const s = trip.obdSpeed[o++];
        if (!opts.withoutObd) speed.emit({ txUs: s.tUs - 10_000, rxUs: s.tUs + 10_000, tUs: s.tUs, speedMps: s.speedMps, raw: s.rawKph });
      }
      while (g < trip.gnss.length && trip.gnss[g].tUs + 50_000 <= nowUs) {
        const f = trip.gnss[g++];
        if (opts.withoutGnssFromS === undefined || f.tUs < trip.startUs + opts.withoutGnssFromS * 1e6) gnss.emit(record(f));
      }
      imu.emit({ motion: batch, gyro: [], accel: [], mag: [] });
      jest.advanceTimersByTime(100);
      opts.onStep?.(nowUs);
    }
  }

  return { service, gnss, engine, want, notes, logged, store, play, now: () => nowUs };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("NavigatorService", () => {
  test("asks for GNSS and IMU while running and releases them on stop", async () => {
    const { service, want } = harness();
    await service.start();
    expect(want).toHaveBeenLastCalledWith(true, true, "navigator");
    service.stop();
    expect(want).toHaveBeenLastCalledWith(false, false, "navigator");
  });

  test("start() again re-requests capture without subscribing twice", async () => {
    const { service, gnss, want, now } = harness({ vin: null });
    const seen = jest.fn();
    service.subscribe(seen);
    await service.start();
    await service.start();
    expect(want).toHaveBeenCalledTimes(2);
    gnss.emit(record({ tUs: now(), lat: 50.45, lon: 30.52, speedMps: 0 }));
    expect(seen).toHaveBeenCalledTimes(1);
    service.stop();
  });

  test("keeps running off screen during a trip", async () => {
    const { service, want } = harness();
    await service.start();
    service.setKeepAlive(true);
    service.stop();
    expect(want).toHaveBeenLastCalledWith(true, true, "navigator");
    service.setKeepAlive(false);
    expect(want).toHaveBeenLastCalledWith(false, false, "navigator");
  });

  test("without an OBD adapter it shows phone GNSS; a Wi-Fi fix isn't trusted", async () => {
    const { service, gnss, now } = harness({ vin: null });
    await service.start();
    gnss.emit(record({ tUs: now(), lat: 50.45, lon: 30.52, hAccM: 12 }));
    expect(service.getSnapshot()).toMatchObject({ lat: 50.45, accuracyM: 12, source: "gnss", trust: "NO_FIX" });
    gnss.emit(record({ tUs: now() + 1_000_000, lat: 50.45, lon: 30.52, hAccM: 5, speedMps: 0 }));
    expect(service.getSnapshot()?.trust).toBe("TRUSTED");
    service.stop();
  });

  test("fuses GNSS with OBD and IMU, then dead-reckons through a GNSS outage", async () => {
    const drive = syntheticDrive({ segments: cityDrive(4), gnss: "clean", obdScale: 0.985, startHeadingRad: 1 });
    const { service, play, notes, logged } = harness();
    await service.start();
    const durationS = (drive.trip.imu.at(-1)!.tUs - drive.trip.startUs) / 1e6;
    const outageS = durationS - 40;
    let fused = 0;
    play(drive, {
      withoutGnssFromS: outageS,
      onStep: (tUs) => {
        const p = service.getSnapshot();
        if (tUs < drive.trip.startUs + (outageS - 1) * 1e6 && p?.source === "fused") fused++;
      },
    });
    expect(notes).toContain("nav mode dr (course)");
    expect(fused).toBeGreaterThan(500);

    const p = service.getSnapshot()!;
    expect(p).toMatchObject({ source: "dr", trust: "NO_FIX" });
    expect(p.rawGnss).toBeDefined();
    // 40 s and ~450 m without GNSS. The marker is drawn at "now", ahead of the reorder window.
    const truth = drive.truthAt(drive.trip.imu.at(-1)!.tUs);
    expect(haversineM(p, truth)).toBeLessThan(10);
    expect(p.accuracyM).toBeGreaterThan(2);
    expect(p.distanceSinceTrustedM).toBeGreaterThan(400);
    // The trip log gets what the map showed, including how far the navigator ran behind.
    const last = logged.at(-1)!;
    expect(last).toMatchObject({ latDeg: p.lat, lonDeg: p.lon, accuracyM: p.accuracyM, mode: "dr", source: "dr", trust: "NO_FIX" });
    expect(last.behindUs).toBeGreaterThanOrEqual(200_000);
    expect(last.behindUs).toBeLessThanOrEqual(500_000);
    expect(logged.some((r) => r.source === "fused")).toBe(true);
    service.stop();
  });

  test("falls back to phone GNSS when OBD speed stops", async () => {
    const drive = syntheticDrive({ segments: cityDrive(1), gnss: "clean" });
    const { service, play } = harness();
    await service.start();
    play(drive, { untilS: 30 });
    expect(service.getSnapshot()?.source).toBe("fused");
    play(drive, { untilS: 45, withoutObd: true });
    expect(service.getSnapshot()?.source).toBe("gnss");
    service.stop();
  });

  test("stores the GNSS lag per phone and the speed scale per car, and starts from them next time", async () => {
    const store = memoryStore();
    const drive = syntheticDrive({ segments: cityDrive(6), gnss: "clean", gnssLagS: 0.3, obdScale: 0.98, seed: 3 });
    const first = harness({ store });
    await first.service.start();
    first.play(drive);
    first.service.stop();
    const saved = store.getJson<{ gnssLag: { lagS: number; model: string; os: string }; speedScaleByVin: Record<string, { ks: number }> }>(CALIBRATION_KEY)!;
    expect(saved.gnssLag).toMatchObject(PHONE);
    expect(Math.abs(saved.gnssLag.lagS - 0.3)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(saved.speedScaleByVin[VIN].ks - 1 / 0.98)).toBeLessThan(0.01);
    expect(first.notes.some((n) => n.startsWith("nav gnss lag saved"))).toBe(true);

    const second = harness({ store });
    await second.service.start();
    second.play(drive, { untilS: 1 });
    expect(second.notes).toContain(`nav gnss lag ${saved.gnssLag.lagS} s from storage (${(saved.gnssLag as never as { windows: number }).windows} turn windows)`);
    expect(second.notes.some((n) => n.startsWith("nav speed scale") && n.endsWith("from storage"))).toBe(true);
    second.service.stop();
  });
});

describe("parked pose", () => {
  // Drive with clean GNSS, then stop and stand.
  const PARK: DriveSegment[] = [...cityDrive(2), { durationS: 8, speedMps: 0, yawRateDegS: 0 }, { durationS: 10, speedMps: 0, yawRateDegS: 0 }];
  const DRIVE_OFF: DriveSegment[] = [
    { durationS: 10, speedMps: 0, yawRateDegS: 0 },
    { durationS: 10, speedMps: 10, yawRateDegS: 0 },
    { durationS: 9, speedMps: 8, yawRateDegS: 10 },
    { durationS: 40, speedMps: 12, yawRateDegS: 0 },
  ];

  async function parkFirst() {
    const store = memoryStore();
    const drive = syntheticDrive({ segments: PARK, gnss: "clean", startHeadingRad: 0.5 });
    const first = harness({ store });
    await first.service.start();
    first.play(drive);
    first.engine.emit("engine-off", first.now());
    const pose = store.getJson<StoredPose>(PARKED_POSE_KEY)!;
    const truth = drive.truthAt(drive.trip.imu.at(-1)!.tUs);
    first.service.stop();
    return { store, pose, truth };
  }

  test("saved when the engine stops, with the heading", async () => {
    const { pose, truth } = await parkFirst();
    expect(pose.vin).toBe(VIN);
    expect(haversineM(pose, truth)).toBeLessThan(5);
    expect(Math.abs(Math.atan2(Math.sin(pose.headingRad - truth.psi), Math.cos(pose.headingRad - truth.psi)))).toBeLessThan(0.05);
  });

  test("under jamming the next session dead-reckons from it right away, and driving clears it", async () => {
    const { store, pose } = await parkFirst();
    const drive = syntheticDrive({ segments: DRIVE_OFF, gnss: "coarse", origin: pose, startHeadingRad: pose.headingRad, seed: 7 });
    const next = harness({ store });
    await next.service.start();
    expect(next.notes.some((n) => n.startsWith("nav mode dr (parked pose"))).toBe(true);
    next.play(drive, { untilS: 5 });
    expect(next.service.getSnapshot()).toMatchObject({ source: "dr" });
    next.play(drive);
    expect(store.getJson(PARKED_POSE_KEY)).toBeNull();
    expect(next.notes).toContain("nav parked pose confirmed");
    // ~600 m on coarse fixes only: without the pose, alignment would still be waiting for spread.
    const p = next.service.getSnapshot()!;
    expect(p.source).toBe("dr");
    expect(haversineM(p, drive.truthAt(drive.trip.imu.at(-1)!.tUs))).toBeLessThan(30);
    next.service.stop();
  });

  test("a fix far from it drops it (the car was moved)", async () => {
    const { store, pose } = await parkFirst();
    const moved = { lat: pose.lat + 0.005, lon: pose.lon };
    const drive = syntheticDrive({ segments: DRIVE_OFF, gnss: "coarse", origin: moved, startHeadingRad: 2, seed: 7 });
    const next = harness({ store });
    await next.service.start();
    next.play(drive, { untilS: 5 });
    expect(next.notes.some((n) => n.startsWith("nav parked pose rejected"))).toBe(true);
    expect(store.getJson(PARKED_POSE_KEY)).toBeNull();
    expect(next.service.getSnapshot()?.source).toBe("gnss");
    next.service.stop();
  });

  test("another car doesn't use it", async () => {
    const { store } = await parkFirst();
    const other = harness({ store, vin: "OTHERVIN000000000" });
    await other.service.start();
    expect(other.notes.some((n) => n.includes("parked pose"))).toBe(false);
    other.service.stop();
  });
});

describe("CalibrationStore", () => {
  test("drops a GNSS lag measured on another phone model or iOS version", () => {
    const store = memoryStore();
    new CalibrationStore(store, PHONE).saveGnssLag({ lagS: -0.1, windows: 8, rmsM: 1.4 });
    expect(new CalibrationStore(store, PHONE).gnssLag()?.lagS).toBe(-0.1);
    expect(new CalibrationStore(store, { ...PHONE, os: "ios 26.1" }).gnssLag()).toBeNull();
    // Dropped for good, not only hidden.
    expect(new CalibrationStore(store, PHONE).gnssLag()).toBeNull();
  });

  test("stores a speed scale only once it is learned, and reloads it with room to move", () => {
    const calibration = new CalibrationStore(memoryStore(), PHONE);
    expect(calibration.saveSpeedScale(VIN, 1.02, 0.02 ** 2)).toBe(false);
    expect(calibration.saveSpeedScale(VIN, 1.4, 0.001 ** 2)).toBe(false);
    expect(calibration.saveSpeedScale(VIN, 1.02, 0.002 ** 2)).toBe(true);
    const prior = calibration.speedScale(VIN)!;
    expect(prior.ks).toBe(1.02);
    expect(Math.sqrt(prior.ksVar)).toBeGreaterThan(0.01);
    expect(calibration.speedScale("OTHERVIN")).toBeNull();
  });
});
