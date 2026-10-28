import { readFileSync } from "node:fs";
import type { PoseAfterWake } from "@/services/on-the-way";
import path from "node:path";

import { syntheticDrive, type DriveSegment, type SyntheticDrive } from "@/nav/__fixtures__/synthetic-drive";
import { destinationAtBearing, haversineM } from "@/nav/geo";
import { LocalFrame } from "@/nav/geo/local-frame";
import { CameraIndex } from "@/nav/speed/cameras";
import { bufferByteSource } from "@/nav/mapmatch/graph/byte-source";
import { TiledRoadGraph } from "@/nav/mapmatch/graph/road-graph";
import type { GnssFix } from "@/nav/types";
import type { CanSpeedSample } from "@/nav/odometry/can/can-speed";
import { Emitter } from "@/obd/emitter";
import { UNKNOWN_CAR, type EngineState, type SpeedSample } from "@/obd/types";
import type { KeyValueStore } from "@/obd/vehicle-link-core";
import { CALIBRATION_KEY, CalibrationStore, PARKED_POSES_KEY, type StoredPose } from "@/services/navigation/calibration-store";
import { seedFromLog } from "@/services/navigation/app-replay";
import { NavigatorService } from "@/services/navigation/navigator-service";
import type { ActiveRoadGraph, RoadGraphSource } from "@/services/offline-map/road-graph-file";
import type { decodeImuBatch } from "@/services/sensor-capture/sensor-service";
import { GNSS_FLAGS, type GnssRecord, type NavEstimateRecord, type NavMapMatchRecord } from "@/triplog/schema";

jest.mock("expo-location", () => ({
  getForegroundPermissionsAsync: jest.fn(async () => ({ granted: true, status: "granted" })),
  requestForegroundPermissionsAsync: jest.fn(async () => ({ granted: true, status: "granted" })),
}));

const PHONE = { model: "iPhone14,5", os: "ios 26.0" };
const VIN = "JMZKF0000TEST0001";
/** Wall clock = uptime + this (µs). */
const UTC_OFFSET_US = 1_800_000_000_000_000;
/** A fix taken this long ago: past the service's reorder window, so the navigator (and integrity) takes it at once. */
const LATE_US = 400_000;

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
function harness(
  options: {
    vin?: string | null;
    store?: ReturnType<typeof memoryStore>;
    roadGraph?: RoadGraphSource;
    phoneGraph?: () => TiledRoadGraph;
    /** The speed limit's own reader on this graph, under the active graph's key (UI-SPEC §6.4). */
    limitGraph?: { key: string; graph: () => TiledRoadGraph };
    /** The installed maps' speed cameras (UI-SPEC §6.5). */
    cameras?: CameraIndex;
    /** The uptime the app starts at (a later session of the same drive). */
    startUs?: number;
    /** iOS started the app on the way (NAVIGATOR-SPEC §6.1). */
    onTheWay?: { poseAfterWake(): PoseAfterWake; poseBehind(): void };
  } = {},
) {
  const gnss = new Emitter<[GnssRecord]>();
  const imu = new Emitter<[ReturnType<typeof decodeImuBatch>]>();
  const speed = new Emitter<[SpeedSample]>();
  const engine = new Emitter<[EngineState, number]>();
  const wheels = new Emitter<[CanSpeedSample]>();
  const want = jest.fn();
  const notes: string[] = [];
  const logged: NavEstimateRecord[] = [];
  const loggedMapMatch: NavMapMatchRecord[] = [];
  const store = options.store ?? memoryStore();
  // The link's car: null before an adapter initialises (then the expected VIN is `options.vin`); a VIN of null is a car it doesn't know.
  let vehicle: { vin: string | null } | null = options.vin === null ? null : { vin: options.vin ?? VIN };
  let nowUs = options.startUs ?? 1_000_000_000;
  jest.setSystemTime((nowUs + UTC_OFFSET_US) / 1000);
  const service = new NavigatorService({
    sensors: { gnss, imu, want } as never,
    link: {
      onSpeed: (l) => speed.on(l),
      onEngineState: (l) => engine.on(l),
      getSnapshot: () => ({ vehicle: vehicle as never }),
      expectedCar: () => (vehicle ? (vehicle.vin ?? UNKNOWN_CAR) : null),
    },
    calibration: new CalibrationStore(store, PHONE),
    nowUs: () => nowUs,
    note: (text) => notes.push(text),
    log: (r) => logged.push(r),
    logMapMatch: (r) => loggedMapMatch.push(r),
    roadGraph: options.roadGraph,
    canSpeed: { onSample: (l) => wheels.on(l) },
    onTheWay: options.onTheWay,
    ...(options.phoneGraph ? { openPhoneGraph: () => ({ key: "fixture", graph: options.phoneGraph!(), close: () => {} }) } : {}),
    ...(options.limitGraph ? { openLimitGraph: () => ({ key: options.limitGraph!.key, graph: options.limitGraph!.graph(), close: () => {} }) } : {}),
    ...(options.cameras ? { cameras: () => ({ key: "cameras:1", index: options.cameras! }) } : {}),
  });

  /** Deliver a trip the way the phone does: IMU in 100 ms batches, OBD live, fixes 50 ms late. */
  /**
   * `pocketFromS`: from then the phone turns on its own, 3 °/s more than the car (its gyro about "up").
   * `wheels`: CAN wheel samples from the true path every 0.1 s (rear track 1.6 m), as CAN primary sends them; `tyre`:
   * the right rear reading that much fast (a fraction of speed: negative, slow).
   */
  function play(
    drive: SyntheticDrive,
    opts: { untilS?: number; withoutGnssFromS?: number; withoutObd?: boolean; onStep?: (tUs: number) => void; pocketFromS?: number; wheels?: boolean; tyre?: number } = {},
  ) {
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
    let k = trip.mag.findIndex((s) => s.tUs > nowUs);
    if (k < 0) k = trip.mag.length;
    while (nowUs < lastUs) {
      nowUs += 100_000;
      const batch = [];
      while (i < trip.imu.length && trip.imu[i].tUs <= nowUs) {
        const s = trip.imu[i++];
        let gyro = s.gyro;
        if (opts.pocketFromS !== undefined && s.tUs >= trip.startUs + opts.pocketFromS * 1e6) {
          const g = Math.hypot(...s.gravity);
          const extra = (3 * Math.PI) / 180;
          gyro = [gyro[0] - (s.gravity[0] / g) * extra, gyro[1] - (s.gravity[1] / g) * extra, gyro[2] - (s.gravity[2] / g) * extra];
        }
        batch.push({ timestampUs: s.tUs, gyro, gravity: s.gravity, userAccel: s.userAccel, attitude: [1, 0, 0, 0] as [number, number, number, number] });
      }
      if (opts.wheels && nowUs - 200_000 > trip.startUs) {
        // The sample for the 0.1 s that ended 0.1 s ago (the link's delay), its yaw from the true heading's change.
        const t = nowUs - 200_000;
        const a = drive.truthAt(t - 50_000);
        const b = drive.truthAt(t + 50_000);
        const yaw = -Math.atan2(Math.sin(b.psi - a.psi), Math.cos(b.psi - a.psi)) / 0.1;
        const v = drive.truthAt(t).speedMps;
        const diff = 1.6 * yaw + (opts.tyre ?? 0) * v;
        wheels.emit({ tUs: t, speedMps: v, wheelsMps: [v, v, v - diff / 2, v + diff / 2], gear: "D", reverse: false });
      }
      const mag = [];
      while (k < trip.mag.length && trip.mag[k].tUs <= nowUs) {
        const s = trip.mag[k++];
        mag.push({ timestampUs: s.tUs, v: s.field });
      }
      while (o < trip.obdSpeed.length && trip.obdSpeed[o].tUs <= nowUs) {
        const s = trip.obdSpeed[o++];
        if (!opts.withoutObd) speed.emit({ txUs: s.tUs - 10_000, rxUs: s.tUs + 10_000, tUs: s.tUs, speedMps: s.speedMps, raw: s.rawKph });
      }
      while (g < trip.gnss.length && trip.gnss[g].tUs + 50_000 <= nowUs) {
        const f = trip.gnss[g++];
        if (opts.withoutGnssFromS === undefined || f.tUs < trip.startUs + opts.withoutGnssFromS * 1e6) gnss.emit(record(f));
      }
      imu.emit({ motion: batch, gyro: [], accel: [], mag });
      jest.advanceTimersByTime(100);
      opts.onStep?.(nowUs);
    }
  }

  const setVehicle = (v: { vin: string | null } | null) => (vehicle = v);
  /** Let time pass with no sensor input (the service's ticks run). */
  const advance = (us: number) => {
    nowUs += us;
    jest.advanceTimersByTime(us / 1000);
  };
  return { service, gnss, engine, want, notes, logged, loggedMapMatch, store, play, setVehicle, advance, now: () => nowUs };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("logStorage notes what is stored for the phone and the car, so a replay can start from it", () => {
  const store = memoryStore();
  const pose = { lat: 50.45, lon: 30.52, headingRad: 2, posSigmaM: 3, headingSigmaRad: 0.05 };
  new CalibrationStore(store, PHONE).saveParkedPose(VIN, pose, 1_790_000_000_000);
  const { service, notes } = harness({ store });
  notes.length = 0;
  service.logStorage();
  expect(notes).toHaveLength(2);
  const seeded = new CalibrationStore(memoryStore(), PHONE);
  const messages = notes.map((text) => ({ tUs: 0, tag: "app", text }));
  expect(seedFromLog({ messages } as never, seeded)).toBe(2);
  expect(seeded.parkedPose(VIN)).toMatchObject(pose);
  expect(seeded.manualPosition()).toBeNull();
});

test("logStorage carries a held manual position: a replay starts from the driver's placing made before its log", () => {
  const store = memoryStore();
  const manual = { lat: 50.45, lon: 30.52, headingRad: 1, placedAt: 1_790_000_000_000, confirmedAt: 1_790_000_600_000 };
  new CalibrationStore(store, PHONE).saveManualPosition(manual);
  const { service, notes } = harness({ store });
  notes.length = 0;
  service.logStorage();
  const seeded = new CalibrationStore(memoryStore(), PHONE);
  seedFromLog({ messages: notes.map((text) => ({ tUs: 0, tag: "app", text })) } as never, seeded);
  expect(seeded.manualPosition()).toEqual(manual);
});

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
    gnss.emit(record({ tUs: now() - LATE_US, lat: 50.45, lon: 30.52, speedMps: 0 }));
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
    const { service, gnss, now, advance } = harness({ vin: null });
    await service.start();
    gnss.emit(record({ tUs: now() - LATE_US, lat: 50.45, lon: 30.52, hAccM: 12 }));
    expect(service.getSnapshot()).toMatchObject({ lat: 50.45, accuracyM: 12, source: "gnss", trust: "NO_FIX" });
    advance(1_000_000);
    gnss.emit(record({ tUs: now() - LATE_US, lat: 50.45, lon: 30.52, hAccM: 5, speedMps: 0 }));
    expect(service.getSnapshot()?.trust).toBe("TRUSTED");
    service.stop();
  });

  test("a fix from CoreLocation's cache is ignored: started mid-drive, it was the last real fix 29 min back", async () => {
    const { service, gnss, now, advance, notes } = harness({ vin: null });
    await service.start();
    const ageUs = 29 * 60 * 1e6;
    gnss.emit(record({ tUs: now() - ageUs, lat: 51.462, lon: 30.739, hAccM: 64 }, { deliveryDelayUs: ageUs }));
    expect(service.getSnapshot()).toBeNull();
    expect(notes.some((n) => n.startsWith("gnss fix 1740 s old ignored"))).toBe(true);
    advance(1_000_000);
    gnss.emit(record({ tUs: now() - LATE_US, lat: 51.467, lon: 31.2, hAccM: 12 }));
    expect(service.getSnapshot()).toMatchObject({ lat: 51.467, lon: 31.2 });
    service.stop();
  });

  test("without an OBD adapter a spoofed fix isn't shown: the map holds the last good one, the spoof is the ghost", async () => {
    const { service, gnss, now, advance, notes } = harness({ vin: null });
    await service.start();
    for (let i = 0; i < 3; i++) {
      advance(1_000_000);
      gnss.emit(record({ tUs: now() - LATE_US, lat: 50.45, lon: 30.52, hAccM: 5, speedMps: 0 }));
    }
    expect(service.getSnapshot()).toMatchObject({ lat: 50.45, trust: "TRUSTED" });
    // Minsk, a second later.
    advance(1_000_000);
    gnss.emit(record({ tUs: now() - LATE_US, lat: 53.9, lon: 27.56, hAccM: 5, speedMps: 0 }));
    advance(2_000_000);
    const p = service.getSnapshot()!;
    expect(p).toMatchObject({ lat: 50.45, lon: 30.52, source: "gnss", trust: "UNTRUSTED", rawGnss: { lat: 53.9 } });
    // Held: its circle grows (15 m/s) while nothing says where the phone went.
    expect(p.accuracyM).toBeGreaterThan(40);
    expect(notes).toContain("gnss integrity outside: outside Ukraine (fix ±5 m)");
    service.stop();
  });

  test("fuses GNSS with OBD and IMU, then dead-reckons through a GNSS outage", async () => {
    const drive = syntheticDrive({ segments: cityDrive(4), gnss: "clean", obdScale: 0.985, startHeadingRad: 1 });
    const { service, play, notes, logged, gnss } = harness();
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
    // What Waze would read in a probe: the phone's last satellite fix. wtf.ai's own (shared, it comes back on the gps
    // provider as a simulated fix) is never it.
    expect(p.satelliteFix).toEqual(p.rawGnss);
    const last = logged.at(-1)!;
    const tUs = drive.trip.imu.at(-1)!.tUs;
    gnss.emit(record({ tUs, lat: p.lat, lon: p.lon, hAccM: 5, speedMps: 10 }, { flags: GNSS_FLAGS.simulated }));
    expect(service.getSnapshot()!.rawGnss?.timestamp).not.toBe(p.rawGnss!.timestamp);
    expect(service.getSnapshot()!.satelliteFix).toEqual(p.satelliteFix);
    // The trip log gets what the map showed, including how far the navigator ran behind.
    expect(last).toMatchObject({ latDeg: p.lat, lonDeg: p.lon, accuracyM: p.accuracyM, mode: "dr", source: "dr", trust: "NO_FIX" });
    expect(last.behindUs).toBeGreaterThanOrEqual(200_000);
    expect(last.behindUs).toBeLessThanOrEqual(500_000);
    expect(logged.some((r) => r.source === "fused")).toBe(true);
    service.stop();
  });

  // NAVIGATOR-SPEC §5.4: a phone in a pocket turns with the driver; the wheels turn with the car.
  test("the phone in a pocket through a GNSS outage: lost on its gyro, on track with the turning from the wheels", async () => {
    const errorAtEnd = async (wheelYaw: boolean) => {
      const drive = syntheticDrive({ segments: cityDrive(4), gnss: "clean", obdScale: 0.985, startHeadingRad: 1 });
      const { service, play, notes } = harness();
      await service.start();
      service.setWheelYaw(wheelYaw);
      const durationS = (drive.trip.imu.at(-1)!.tUs - drive.trip.startUs) / 1e6;
      play(drive, { withoutGnssFromS: durationS - 60, pocketFromS: durationS - 60, wheels: true });
      const err = haversineM(service.getSnapshot()!, drive.truthAt(drive.trip.imu.at(-1)!.tUs));
      service.stop();
      return { err, notes };
    };
    const off = await errorAtEnd(false);
    const on = await errorAtEnd(true);
    // 60 s and ~650 m: 3 °/s of the phone's own turning is 180° of heading.
    expect(off.err).toBeGreaterThan(100);
    expect(on.err).toBeLessThan(15);
    expect(on.notes).toContain("nav wheel yaw on");
  });

  test("the Car page's Turns from says the wheels only while they turn the dot, not for the setting alone", async () => {
    const drive = syntheticDrive({ segments: cityDrive(1), gnss: "clean" });
    const { service, play } = harness();
    await service.start();
    service.setWheelYaw(true);
    play(drive, { untilS: 20 });
    expect(service.turnsFromWheels()).toBe(false);
    play(drive, { untilS: 40, wheels: true });
    expect(service.turnsFromWheels()).toBe(true);
    service.setWheelYaw(false);
    expect(service.turnsFromWheels()).toBe(false);
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

/** The parked pose stored for a car. */
const storedPose = (store: KeyValueStore, vin = VIN) => store.getJson<Record<string, StoredPose>>(PARKED_POSES_KEY)?.[vin] ?? null;
const storedManual = (store: KeyValueStore) => new CalibrationStore(store, PHONE).manualPosition();

describe("pose saved while driving (NAVIGATOR-SPEC §6.1)", () => {
  // Clean GNSS through town, then 2 min on a straight road at 20 m/s.
  const DRIVE: DriveSegment[] = [...cityDrive(2), { durationS: 5, speedMps: 20, yawRateDegS: 0 }, { durationS: 120, speedMps: 20, yawRateDegS: 0 }];
  const KILLED_AT_S = 110;
  const storedDrive = (store: KeyValueStore) => store.getJson<Record<string, StoredPose>>(PARKED_POSES_KEY)?.[VIN] ?? null;

  /** Driven until the app dies (no stop: nothing is saved at the end). */
  async function killedMidDrive() {
    const store = memoryStore();
    const drive = syntheticDrive({ segments: DRIVE, gnss: "clean", startHeadingRad: 1, seed: 5 });
    const first = harness({ store });
    await first.service.start();
    first.play(drive, { untilS: KILLED_AT_S });
    return { store, drive };
  }

  test("saved every few seconds while the car drives, with its speed", async () => {
    const { store, drive } = await killedMidDrive();
    const pose = storedDrive(store)!;
    const truth = drive.truthAt(drive.trip.startUs + KILLED_AT_S * 1e6);
    expect(haversineM(pose, truth)).toBeLessThan(110);
    expect(pose.speedMps!).toBeCloseTo(20, 0);
    expect(Math.abs(Math.atan2(Math.sin(pose.headingRad - truth.psi), Math.cos(pose.headingRad - truth.psi)))).toBeLessThan(0.05);
  });

  test("the app opened again 30 s later, jammed: the dot carries on from it, carried on for the time off", async () => {
    const { store, drive } = await killedMidDrive();
    const next = harness({ store, startUs: drive.trip.startUs + (KILLED_AT_S + 30) * 1e6 });
    await next.service.start();
    const started = next.notes.find((n) => n.startsWith("nav mode dr (pose saved while driving"));
    expect(started).toMatch(/^nav mode dr \(pose saved while driving, 3\d s old, carried \d+ m on at 72 km\/h, ±\d+ m, heading ±\d+°\)$/);
    next.play(drive, { untilS: KILLED_AT_S + 60, withoutGnssFromS: 0 });
    const p = next.service.getSnapshot()!;
    expect(p.source).toBe("dr");
    expect(haversineM(p, drive.truthAt(next.now()))).toBeLessThan(60);
    next.service.stop();
  });

  test("older than 2 min it isn't used", async () => {
    const { store, drive } = await killedMidDrive();
    const next = harness({ store, startUs: drive.trip.startUs + (KILLED_AT_S + 150) * 1e6 });
    await next.service.start();
    expect(next.notes.some((n) => n.startsWith("nav mode dr"))).toBe(false);
    expect(next.notes.some((n) => /^nav pose saved while driving 1[45]\d s ago: not used$/.test(n))).toBe(true);
    next.service.stop();
  });

  test("the car stops and the engine goes off: the pose where it stands replaces it, without a speed", async () => {
    const store = memoryStore();
    const segments: DriveSegment[] = [...DRIVE.slice(0, -1), { durationS: 30, speedMps: 20, yawRateDegS: 0 }, { durationS: 5, speedMps: 0, yawRateDegS: 0 }, { durationS: 10, speedMps: 0, yawRateDegS: 0 }];
    const drive = syntheticDrive({ segments, gnss: "clean", startHeadingRad: 1, seed: 5 });
    const first = harness({ store });
    await first.service.start();
    first.play(drive, { untilS: (segments.reduce((a, s) => a + s.durationS, 0)) - 12 });
    expect(storedDrive(store)?.speedMps).toBeGreaterThan(0);
    first.play(drive);
    first.engine.emit("engine-off", first.now());
    const pose = storedDrive(store)!;
    expect(pose.speedMps).toBeUndefined();
    expect(haversineM(pose, drive.truthAt(drive.trip.imu.at(-1)!.tUs))).toBeLessThan(5);
    first.service.stop();
  });

  test("written to the trip log's storage note, so a replay starts from it", () => {
    const store = memoryStore();
    const pose = { lat: 50.45, lon: 30.52, headingRad: 2, posSigmaM: 30, headingSigmaRad: 0.05, speedMps: 25 };
    new CalibrationStore(store, PHONE).saveParkedPose(VIN, pose, 1_790_000_000_000);
    const { service, notes } = harness({ store });
    notes.length = 0;
    service.logStorage();
    const seeded = new CalibrationStore(memoryStore(), PHONE);
    seedFromLog({ messages: notes.map((text) => ({ tUs: 0, tag: "app", text })) } as never, seeded);
    expect(seeded.parkedPose(VIN)).toEqual({ ...pose, vin: VIN, savedAt: 1_790_000_000_000 });
  });
});

describe("started on the way (NAVIGATOR-SPEC §6.1)", () => {
  const POSE = { lat: 50.45, lon: 30.52, headingRad: 2, posSigmaM: 8, headingSigmaRad: 0.05 };

  function startedOnTheWay(savedAgoS: number, speedMps?: number, wake: PoseAfterWake = "behind") {
    const store = memoryStore();
    const startUs = 1_000_000_000;
    const nowMs = (startUs + UTC_OFFSET_US) / 1000;
    new CalibrationStore(store, PHONE).saveParkedPose(VIN, { ...POSE, ...(speedMps ? { speedMps } : {}) }, nowMs - savedAgoS * 1000);
    const behind = jest.fn();
    return { ...harness({ store, startUs, onTheWay: { poseAfterWake: () => wake, poseBehind: behind } }), behind };
  }

  test("the pose where the car was parked is behind it: not used, and the map is told", async () => {
    const { service, notes, behind } = startedOnTheWay(3600);
    await service.start();
    expect(notes).toContain("nav parked pose not used: the app was started on the way (60 min after it was saved)");
    expect(notes.some((n) => n.startsWith("nav mode dr"))).toBe(false);
    expect(behind).toHaveBeenCalledTimes(1);
    expect(service.getDebug().parkedPose).toBe("behind");
    service.stop();
  });

  test("the relaunch's location is still at the pose: the car stands, the pose is used", async () => {
    const { service, notes, behind } = startedOnTheWay(3600, undefined, "standing");
    await service.start();
    expect(notes).toContain("nav parked pose kept: the app was started on the way, but the phone is still at it");
    expect(notes.some((n) => n.startsWith("nav mode dr (parked pose"))).toBe(true);
    expect(behind).not.toHaveBeenCalled();
    service.stop();
  });

  test("a pose saved within 2 min is the stop the app ended at: used", async () => {
    const { service, notes, behind } = startedOnTheWay(60);
    await service.start();
    expect(notes.some((n) => n.startsWith("nav mode dr (parked pose"))).toBe(true);
    expect(behind).not.toHaveBeenCalled();
    service.stop();
  });

  test("a pose saved while driving is carried on as before", async () => {
    const { service, notes, behind } = startedOnTheWay(30, 15);
    await service.start();
    expect(notes.some((n) => n.startsWith("nav mode dr (pose saved while driving"))).toBe(true);
    expect(behind).not.toHaveBeenCalled();
    service.stop();
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
    const pose = storedPose(store)!;
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

  test("under jamming the next session dead-reckons from it right away; driving replaces it with the pose as it drives", async () => {
    const { store, pose } = await parkFirst();
    const drive = syntheticDrive({ segments: DRIVE_OFF, gnss: "coarse", origin: pose, startHeadingRad: pose.headingRad, seed: 7 });
    const next = harness({ store });
    await next.service.start();
    expect(next.notes.some((n) => n.startsWith("nav mode dr (parked pose"))).toBe(true);
    next.play(drive, { untilS: 5 });
    expect(next.service.getSnapshot()).toMatchObject({ source: "dr" });
    next.play(drive);
    expect(storedPose(store)?.speedMps).toBeGreaterThan(0);
    expect(next.notes).toContain("nav parked pose confirmed");
    // ~600 m on coarse fixes only: without the pose, alignment would still be waiting for spread.
    const p = next.service.getSnapshot()!;
    expect(p.source).toBe("dr");
    expect(haversineM(p, drive.truthAt(drive.trip.imu.at(-1)!.tUs))).toBeLessThan(30);
    next.service.stop();
  });

  test("under jamming the engine off leaves the dot where the car stopped, not on the next Wi-Fi fix", async () => {
    const { store, pose } = await parkFirst();
    // Brake (a segment ramps to its speed), then stand.
    const STOP: DriveSegment[] = [{ durationS: 5, speedMps: 0, yawRateDegS: 0 }, { durationS: 40, speedMps: 0, yawRateDegS: 0 }];
    const drive = syntheticDrive({ segments: [...DRIVE_OFF, ...STOP], gnss: "coarse", origin: pose, startHeadingRad: pose.headingRad, seed: 7 });
    const next = harness({ store });
    await next.service.start();
    const stoppedS = DRIVE_OFF.reduce((t, s) => t + s.durationS, 0) + 10;
    next.play(drive, { untilS: stoppedS });
    const stopped = next.service.getSnapshot()!;
    expect(stopped.source).toBe("dr");
    // The engine off; the car's link goes quiet, and once its speed is stale the navigator's output stops. The
    // phone keeps getting Wi-Fi fixes: none of them is drawn as the car.
    next.engine.emit("engine-off", next.now());
    next.play(drive, { untilS: stoppedS + 15, withoutObd: true });
    const held = next.service.getSnapshot()!;
    next.play(drive, { withoutObd: true });
    const later = next.service.getSnapshot()!;
    expect(later.source).toBe("dr");
    expect(haversineM(later, held)).toBeLessThan(0.1);
    expect(haversineM(later, stopped)).toBeLessThan(20);
    next.service.stop();
  });

  test("a fix far from it drops it (the car was moved)", async () => {
    const { store, pose } = await parkFirst();
    const moved = { lat: pose.lat + 0.005, lon: pose.lon };
    const drive = syntheticDrive({ segments: DRIVE_OFF, gnss: "coarse", origin: moved, startHeadingRad: 2, seed: 7 });
    const next = harness({ store });
    await next.service.start();
    // In the car, the engine running: its fixes are the car's.
    next.engine.emit("engine-running", next.now());
    next.play(drive, { untilS: 5 });
    expect(next.notes.some((n) => n.startsWith("nav parked pose rejected"))).toBe(true);
    expect(storedPose(store)).toBeNull();
    expect(next.service.getSnapshot()?.source).toBe("gnss");
    next.service.stop();
  });

  test("one Wi-Fi fix far off doesn't drop it (jamming), three in a row do", async () => {
    const { store, pose } = await parkFirst();
    // Standing where it parked, no fixes of its own: the bogus ones are added by hand.
    const drive = syntheticDrive({ segments: [{ durationS: 40, speedMps: 0, yawRateDegS: 0 }], gnss: "none", origin: pose, startHeadingRad: pose.headingRad, seed: 7 });
    const next = harness({ store });
    await next.service.start();
    next.engine.emit("engine-running", next.now());
    // Each a little apart: iOS repeats a Wi-Fi fix with tiny jitter, and a repeat counts once.
    let k = 0;
    const far = (tUs: number) => record({ tUs, lat: pose.lat + 0.0027 + 0.0004 * k, lon: pose.lon + 0.011 - 0.0006 * k++, hAccM: 55 });
    next.play(drive, { untilS: 2 });
    next.gnss.emit(far(next.now()));
    next.play(drive, { untilS: 10 });
    expect(next.notes.some((n) => n.startsWith("nav parked pose rejected"))).toBe(false);
    expect(next.service.getSnapshot()?.source).toBe("dr");
    expect(storedPose(store)).not.toBeNull();
    for (const s of [12, 20]) {
      next.gnss.emit(far(next.now()));
      next.play(drive, { untilS: s + 2 });
    }
    expect(next.notes.some((n) => n.startsWith("nav parked pose rejected"))).toBe(true);
    expect(storedPose(store)).toBeNull();
    next.service.stop();
  });

  test("a Wi-Fi fix far off asks the driver; yes keeps the pose through more of them, no drops it", async () => {
    const { store, pose } = await parkFirst();
    const drive = syntheticDrive({ segments: [{ durationS: 40, speedMps: 0, yawRateDegS: 0 }], gnss: "none", origin: pose, startHeadingRad: pose.headingRad, seed: 7 });
    let k = 0;
    const far = (tUs: number) => record({ tUs, lat: pose.lat + 0.0027 + 0.0004 * k, lon: pose.lon + 0.011 - 0.0006 * k++, hAccM: 55 });

    const yes = harness({ store });
    await yes.service.start();
    yes.play(drive, { untilS: 2 });
    expect(yes.service.getSnapshot()?.poseQuestion).toBeUndefined();
    yes.gnss.emit(far(yes.now()));
    yes.play(drive, { untilS: 4 });
    expect(yes.service.getSnapshot()?.poseQuestion?.distanceM).toBeGreaterThan(700);
    expect(yes.notes.some((n) => n.startsWith("nav parked pose doubted: Wi-Fi fix"))).toBe(true);
    yes.service.answerPose(true);
    expect(yes.service.getSnapshot()?.poseQuestion).toBeUndefined();
    for (const s of [6, 10, 14]) {
      yes.gnss.emit(far(yes.now()));
      yes.play(drive, { untilS: s + 2 });
    }
    expect(yes.notes.some((n) => n.startsWith("nav parked pose rejected"))).toBe(false);
    expect(yes.service.getSnapshot()).toMatchObject({ source: "dr" });
    expect(yes.service.getDebug().parkedPose).toBe("confirmed");
    expect(yes.notes.some((n) => n.startsWith("nav parked pose confirmed by the driver"))).toBe(true);
    yes.service.stop();

    const no = harness({ store });
    await no.service.start();
    no.play(drive, { untilS: 2 });
    no.gnss.emit(far(no.now()));
    no.play(drive, { untilS: 4 });
    no.service.answerPose(false);
    no.play(drive, { untilS: 6 });
    expect(no.service.getSnapshot()?.source).toBe("gnss");
    expect(storedPose(store)).toBeNull();
    no.service.stop();
  });

  test("placed in the wrong spot, the placing cancelled, a Wi-Fi fix doubts the parked pose: asked on the car's dot", async () => {
    // The driver's steps (2026-10-15): place the car wrong, cancel the placing, a Wi-Fi fix far off. The map then
    // shows that fix (no adapter), so "is the car where the dot is?" would be about a spot it doesn't show: asked once
    // the dot is the navigator's (the adapter back). Either answer takes the card off at once.
    const { store, pose } = await parkFirst();
    const drive = syntheticDrive({ segments: [{ durationS: 40, speedMps: 0, yawRateDegS: 0 }], gnss: "none", origin: pose, startHeadingRad: pose.headingRad, seed: 7 });
    let k = 0;
    const far = (tUs: number) => record({ tUs, lat: pose.lat + 0.0027 + 0.0004 * k, lon: pose.lon + 0.011 - 0.0006 * k++, hAccM: 55 });
    // Each harness starts its clock at the same time: the parked pose is from before the placing.
    let clockMs = Date.now() + 10 * 60_000;
    for (const here of [true, false]) {
      const h = harness({ store });
      await h.service.start();
      h.play(drive, { untilS: 2, withoutObd: true });
      jest.setSystemTime((clockMs += 10 * 60_000));
      h.service.setUserPosition({ lat: pose.lat + 0.02, lon: pose.lon }, 0);
      h.play(drive, { untilS: 4, withoutObd: true });
      h.service.discardManualPosition();
      h.play(drive, { untilS: 6, withoutObd: true });
      h.gnss.emit(far(h.now()));
      h.play(drive, { untilS: 8, withoutObd: true });
      expect(h.notes.some((n) => n.startsWith("nav parked pose doubted: Wi-Fi fix"))).toBe(true);
      expect(h.service.getSnapshot()).toMatchObject({ source: "gnss" });
      expect(h.service.getSnapshot()?.poseQuestion).toBeUndefined();
      // The adapter answers: the dot is the parked pose, and the question is about it.
      h.play(drive, { untilS: 12 });
      expect(h.service.getSnapshot()?.source).toBe("dr");
      expect(haversineM(h.service.getSnapshot()!, pose)).toBeLessThan(50);
      expect(h.service.getSnapshot()?.poseQuestion).toBeDefined();
      h.service.answerPose(here);
      expect(h.service.getSnapshot()?.poseQuestion).toBeUndefined();
      expect(h.notes.some((n) => n.startsWith(`nav parked pose ${here ? "confirmed" : "rejected"} by the driver`))).toBe(true);
      h.service.stop();
    }
  });

  test("another car doesn't use it", async () => {
    const { store } = await parkFirst();
    const other = harness({ store, vin: "OTHERVIN000000000" });
    await other.service.start();
    expect(other.notes.some((n) => n.includes("parked pose"))).toBe(false);
    other.service.stop();
  });

  test("a VIN known only after the start (read on a retry) still starts from it", async () => {
    const { store, pose } = await parkFirst();
    const drive = syntheticDrive({ segments: DRIVE_OFF, gnss: "coarse", origin: pose, startHeadingRad: pose.headingRad, seed: 7 });
    const next = harness({ store, vin: null });
    await next.service.start();
    next.play(drive, { untilS: 3 });
    expect(next.notes.some((n) => n.includes("parked pose"))).toBe(false);
    next.setVehicle({ vin: VIN });
    next.play(drive, { untilS: 5 });
    expect(next.notes.some((n) => n.startsWith("nav mode dr (parked pose") && n.endsWith(", VIN known late)"))).toBe(true);
    expect(next.notes.some((n) => n.startsWith("nav speed scale") && n.endsWith("from storage"))).toBe(true);
    next.play(drive);
    expect(next.notes).toContain("nav parked pose confirmed");
    expect(haversineM(next.service.getSnapshot()!, drive.truthAt(drive.trip.imu.at(-1)!.tUs))).toBeLessThan(30);
    next.service.stop();
  });

  test("a car the link doesn't know (another protocol) drops the expected car's pose", async () => {
    const { store } = await parkFirst();
    const next = harness({ store });
    await next.service.start();
    expect(next.notes.some((n) => n.startsWith("nav mode dr (parked pose"))).toBe(true);
    next.setVehicle({ vin: null });
    jest.advanceTimersByTime(2000);
    expect(next.notes.filter((n) => n.startsWith("nav vehicle"))).toEqual(["nav vehicle unknown, not the one expected: restart"]);
    expect(next.service.getDebug().parkedPose).toBe("none");
    // The stored pose stays for the car it belongs to.
    expect(storedPose(store)).not.toBeNull();
    next.service.stop();
  });

  test("a car whose VIN never came keeps its pose as the unknown car's, and its VIN takes it over mid-drive", async () => {
    const store = memoryStore();
    const drive = syntheticDrive({ segments: PARK, gnss: "clean", startHeadingRad: 0.5 });
    const first = harness({ store, vin: null });
    first.setVehicle({ vin: null });
    await first.service.start();
    first.play(drive);
    first.engine.emit("engine-off", first.now());
    first.service.stop();
    const pose = storedPose(store, UNKNOWN_CAR)!;
    expect(pose).not.toBeNull();

    const next = harness({ store, vin: null });
    next.setVehicle({ vin: null });
    await next.service.start();
    expect(next.notes.some((n) => n.startsWith("nav mode dr (parked pose"))).toBe(true);
    // A retry reads the VIN: no restart, and the pose is the VIN's now.
    next.setVehicle({ vin: VIN });
    jest.advanceTimersByTime(2000);
    expect(next.notes.filter((n) => n.startsWith("nav vehicle"))).toEqual(["nav vehicle's VIN came: what was kept for the unknown car is its now"]);
    expect(storedPose(store, UNKNOWN_CAR)).toBeNull();
    expect(storedPose(store)).toMatchObject({ vin: VIN, lat: pose.lat, lon: pose.lon });
    next.service.stop();
  });
});

describe("the car left parked, the phone elsewhere (NAVIGATOR-SPEC §6.1, UI-SPEC §6.1)", () => {
  // Opened away from the car (no trip, so no trip log and no replay ever saw it): the phone's fixes are no evidence
  // about the car. Before 2026-10-24 the first one dropped the stored pose, and the next drive started cold.
  const PARK: DriveSegment[] = [...cityDrive(2), { durationS: 8, speedMps: 0, yawRateDegS: 0 }, { durationS: 10, speedMps: 0, yawRateDegS: 0 }];
  const standing = (origin: { lat: number; lon: number }, gnss: "clean" | "coarse" | "none", durationS = 30) =>
    syntheticDrive({ segments: [{ durationS, speedMps: 0, yawRateDegS: 0 }], gnss, origin, startHeadingRad: 0, seed: 7 });

  async function park() {
    const store = memoryStore();
    const drive = syntheticDrive({ segments: PARK, gnss: "clean", startHeadingRad: 0.5 });
    const h = harness({ store });
    await h.service.start();
    h.play(drive);
    h.engine.emit("engine-off", h.now());
    return { h, store, pose: storedPose(store)!, truth: drive.truthAt(drive.trip.imu.at(-1)!.tUs) };
  }

  /** An hour later, the app opened 550 m from the car (the drives below start at the same uptime). */
  async function atHome() {
    const parked = await park();
    parked.h.service.stop();
    const home = { lat: parked.truth.lat + 0.005, lon: parked.truth.lon };
    const h = harness({ store: parked.store });
    jest.setSystemTime(Date.now() + 3_600_000);
    await h.service.start();
    return { ...parked, h, home, pose: storedPose(parked.store)! };
  }

  test("drawn on the map once the car stops answering, where it stands and the way it faces", async () => {
    const { h, truth } = await park();
    // Still answering: the dot is the car.
    expect(h.service.getParkedCar()).toBeNull();
    h.advance(11_000_000);
    const car = h.service.getParkedCar()!;
    expect(haversineM(car, truth)).toBeLessThan(5);
    expect(Math.abs(Math.atan2(Math.sin(car.headingRad - truth.psi), Math.cos(car.headingRad - truth.psi)))).toBeLessThan(0.05);
    h.service.stop();
  });

  test("opened at home with GPS: the dot is the phone, the car's pose stays stored and drawn", async () => {
    const { h, store, pose, home } = await atHome();
    h.play(standing(home, "clean"), { withoutObd: true });
    expect(h.notes).toContain("nav parked pose kept in storage: the car isn't answering, so the fix is the phone's");
    expect(h.service.getDebug().parkedPose).toBe("kept");
    expect(storedPose(store)).toEqual(pose);
    expect(haversineM(h.service.getSnapshot()!, home)).toBeLessThan(20);
    expect(haversineM(h.service.getParkedCar()!, pose)).toBeLessThan(1);
    h.service.stop();
  });

  test("opened at home under jamming: three Wi-Fi fixes far off don't drop it either", async () => {
    const { h, store, pose, home } = await atHome();
    h.play(standing(home, "coarse", 60), { withoutObd: true });
    expect(h.notes.some((n) => n.startsWith("nav parked pose rejected"))).toBe(true);
    expect(storedPose(store)).toEqual(pose);
    h.service.stop();
  });

  test("the key turned right after stopping: ignition-off comes 2 min later and still saves the pose", async () => {
    const store = memoryStore();
    const drive = syntheticDrive({ segments: PARK, gnss: "clean", startHeadingRad: 0.5 });
    const h = harness({ store });
    await h.service.start();
    h.play(drive);
    h.advance(120_000_000);
    h.engine.emit("ignition-off", h.now());
    expect(storedPose(store)?.savedAt).toBe(Date.now());
    h.service.stop();
  });

  test("the map left open at home: the 30 s saves never store the phone's spot as the car's", async () => {
    const { h, store, pose, home } = await atHome();
    h.play(standing(home, "clean", 150), { withoutObd: true });
    h.service.stop();
    expect(storedPose(store)).toEqual(pose);
  });

  test("engine off, the ECU still answering 0 km/h, the driver walks off without the phone's handling showing: the car stays", async () => {
    // The phone off its mount all drive (in a pocket): no handling when the walk starts. The adapter keeps answering
    // within its radio's reach while the phone's satellite fixes walk away east, slowly enough to pass integrity.
    const store = memoryStore();
    const parkS = PARK.reduce((t, s) => t + s.durationS, 0);
    const drive = syntheticDrive({ segments: [...PARK, { durationS: 60, speedMps: 0, yawRateDegS: 0 }], gnss: "clean", startHeadingRad: 0.5 });
    const h = harness({ store });
    await h.service.start();
    h.play(drive, { untilS: parkS });
    const car = drive.truthAt(drive.trip.startUs + parkS * 1e6);
    h.engine.emit("engine-off", h.now());
    let lastFixUs = 0;
    h.play(drive, {
      withoutGnssFromS: parkS,
      onStep: (tUs) => {
        if (tUs - lastFixUs < 1_000_000) return;
        lastFixUs = tUs;
        const walked = destinationAtBearing(car, Math.PI / 2, 0.5 * ((tUs - drive.trip.startUs) / 1e6 - parkS));
        h.gnss.emit(record({ tUs: tUs - LATE_US, ...walked, hAccM: 5, speedMps: 0.5, courseRad: Math.PI / 2 }));
      },
    });
    h.service.saveCalibration();
    expect(haversineM(storedPose(store)!, car)).toBeLessThan(3);
    h.service.stop();
  });

  test("started from the stored pose, engine off, the ECU answering: the phone's walking fixes don't drop it, nor are saved as the car", async () => {
    const { store, pose, truth } = await atHome().then(async (a) => (a.h.service.stop(), a));
    const h = harness({ store });
    await h.service.start();
    h.engine.emit("engine-off", h.now());
    // The phone 40 m off (walked away within the adapter's reach), its GPS good; the ECU answers 0 km/h.
    h.play(standing(destinationAtBearing(truth, Math.PI / 2, 40), "clean", 40));
    expect(h.notes.some((n) => n.startsWith("nav parked pose rejected"))).toBe(true);
    expect(h.notes.some((n) => n.startsWith("nav parked pose kept in storage"))).toBe(true);
    h.service.saveCalibration();
    expect(storedPose(store)).toMatchObject({ lat: pose.lat, lon: pose.lon });
    // Back at the car, the engine starts: the navigator starts again from where the car was left.
    h.engine.emit("engine-running", h.now());
    expect(h.notes).toContain("nav restart: the engine starts, from the parked pose kept for it");
    h.service.stop();
  });

  test("back at the car with the map open: it answers, and the navigator starts again from where it was left", async () => {
    const { h, store, pose, home, truth } = await atHome();
    h.play(standing(home, "coarse", 60), { withoutObd: true });
    // Walked back; the car answers, standing where it was left, jammed. Its first minute is the walk, already played.
    const drive = syntheticDrive({
      segments: [{ durationS: 70, speedMps: 0, yawRateDegS: 0 }, { durationS: 20, speedMps: 10, yawRateDegS: 0 }],
      gnss: "none",
      origin: truth,
      startHeadingRad: truth.psi,
      seed: 7,
    });
    h.play(drive, { untilS: 65 });
    expect(h.notes).toContain("nav restart: the car answers again, from the parked pose kept for it");
    expect(h.notes.some((n) => n.startsWith("nav mode dr (parked pose"))).toBe(true);
    expect(h.service.getParkedCar()).toBeNull();
    expect(h.service.getSnapshot()?.source).toBe("dr");
    expect(haversineM(h.service.getSnapshot()!, pose)).toBeLessThan(10);
    h.play(drive);
    // Driving: no longer parked there.
    expect(storedPose(store)?.speedMps ?? 0).toBeGreaterThan(0);
    expect(h.service.getParkedCar()).toBeNull();
    h.service.stop();
  });

  /**
   * The app opened at home with the car in its bay and the phone in the house: Wi-Fi fixes ±11 m from 20 m off, the
   * link connecting 15 s in, then the ECU answering 0 km/h with the engine off. `fixes` emits the house's fixes.
   */
  function openedInTheHouse(store: ReturnType<typeof memoryStore>, truth: { lat: number; lon: number; psi: number }, minutesLater: number, engine: EngineState = "engine-off") {
    const house = destinationAtBearing(truth, Math.PI / 2, 20);
    const h = harness({ store });
    jest.setSystemTime(Date.now() + minutesLater * 60_000);
    let lastFixUs = 0;
    const fixes = (tUs: number) => {
      if (tUs - lastFixUs < 3_000_000) return;
      lastFixUs = tUs;
      const jitter = destinationAtBearing(house, (tUs / 1e6) % (2 * Math.PI), 3);
      h.gnss.emit(record({ tUs: tUs - LATE_US, ...jitter, hAccM: 11 }));
    };
    const drive = syntheticDrive({ segments: [{ durationS: 200, speedMps: 0, yawRateDegS: 0 }], gnss: "none", origin: truth, startHeadingRad: truth.psi, seed: 7 });
    /** The app open `untilS` seconds: before the link connects, then the ECU answering. */
    const open = async (untilS = 75) => {
      await h.service.start();
      h.play(drive, { untilS: 15, withoutObd: true, onStep: fixes });
      h.engine.emit(engine, h.now());
      h.play(drive, { untilS, onStep: fixes });
    };
    return { h, open, fixes, drive };
  }

  test("in the car with the engine running, jammed: the Wi-Fi fixes, the same from the car as from the house, don't move the stored pose either", async () => {
    // Wi-Fi places the phone ±10–30 m from the networks it hears, which are the same from the bay and from the house;
    // the stored pose is the car's own track, a metre or two. Blending them in only pulls the car to where Wi-Fi lands.
    const { store, pose, truth } = await atHome().then(async (a) => (a.h.service.stop(), a));
    const { h, open } = openedInTheHouse(store, truth, 10, "engine-running");
    await open();
    expect(haversineM(h.service.getSnapshot()!, pose)).toBeLessThan(3);
    h.service.stop();
    expect(haversineM(storedPose(store)!, pose)).toBeLessThan(3);
  });

  test("opened at the parked car with the phone in the house, the ECU answering 0 km/h: the house's Wi-Fi fixes move neither the car nor the dot, however often", async () => {
    // Within the gate of a pose the fixes haven't confirmed, they pulled the dead reckoning towards the phone before
    // the first 0 km/h froze it, and the 30 s save stored the phone's spot as the car's; every opening started from
    // that, 5 m wider, and pulled further (2026-10-26: the car "parked in the backyard").
    const { store, pose, truth } = await atHome().then(async (a) => (a.h.service.stop(), a));
    for (let i = 1; i <= 4; i++) {
      const { h, open } = openedInTheHouse(store, truth, 10 * i);
      await open();
      expect(haversineM(h.service.getSnapshot()!, pose)).toBeLessThan(3);
      h.service.stop();
      const stored = storedPose(store)!;
      expect(haversineM(stored, pose)).toBeLessThan(3);
      expect(stored.posSigmaM).toBeLessThan(pose.posSigmaM + 1);
    }
  });

  test("placed by the driver while the ECU answers, then opened again in the house: the placing stays the car's pose", async () => {
    const { store, pose, truth } = await atHome().then(async (a) => (a.h.service.stop(), a));
    const placed = destinationAtBearing(truth, -Math.PI / 2, 12);
    {
      const { h, open, drive, fixes } = openedInTheHouse(store, truth, 10);
      await open(40);
      expect(h.service.setUserPosition(placed, truth.psi)).toBe(true);
      h.play(drive, { untilS: 100, onStep: fixes });
      expect(haversineM(h.service.getSnapshot()!, placed)).toBeLessThan(3);
      h.service.stop();
      expect(haversineM(storedPose(store)!, placed)).toBeLessThan(3);
    }
    // 20 min later: the placing is being asked about, so the navigator starts from the stored pose (the placing).
    const { h, open } = openedInTheHouse(store, truth, 30);
    await open();
    expect(haversineM(h.service.getSnapshot()!, placed)).toBeLessThan(3);
    h.service.stop();
    expect(haversineM(storedPose(store)!, placed)).toBeLessThan(3);
    expect(haversineM(storedPose(store)!, pose)).toBeGreaterThan(9);
  });
});

describe("the driver puts the car on the map", () => {
  // Standing 10 s, then driving off north-east under jamming (coarse fixes only).
  const SEGMENTS: DriveSegment[] = [
    { durationS: 10, speedMps: 0, yawRateDegS: 0 },
    { durationS: 30, speedMps: 10, yawRateDegS: 0 },
  ];
  const origin = { lat: 51.5184, lon: 30.7465 };

  test("with a heading: dead reckoning from there at once, a far Wi-Fi fix doesn't move it", async () => {
    const drive = syntheticDrive({ segments: SEGMENTS, gnss: "none", origin, startHeadingRad: 0.8, seed: 3 });
    const h = harness({ vin: null });
    await h.service.start();
    h.play(drive, { untilS: 3 });
    expect(h.service.setUserPosition(origin, 0.8)).toBe(true);
    expect(h.notes.some((n) => n.startsWith("nav position set by the driver: 51.518400,30.746500") && n.endsWith("heading 46°"))).toBe(true);
    h.play(drive, { untilS: 8 });
    h.gnss.emit(record({ tUs: h.now(), lat: origin.lat + 0.008, lon: origin.lon, hAccM: 55 }));
    h.play(drive);
    const p = h.service.getSnapshot()!;
    expect(p.source).toBe("dr");
    expect(haversineM(p, drive.truthAt(drive.trip.imu.at(-1)!.tUs))).toBeLessThan(25);
    h.service.stop();
  });

  test("not saved as the car's parked pose: it is held as the manual position", async () => {
    const store = memoryStore();
    const drive = syntheticDrive({ segments: SEGMENTS, gnss: "none", origin, startHeadingRad: 0.8, seed: 3 });
    const h = harness({ store });
    await h.service.start();
    h.play(drive, { untilS: 3 });
    h.service.setUserPosition(origin, 0.8);
    expect(storedPose(store)).toBeNull();
    expect(storedManual(store)).toMatchObject({ lat: origin.lat, lon: origin.lon, headingRad: 0.8 });
    h.service.stop();
  });
});

describe("the manual position (NAVIGATOR-SPEC §6.3)", () => {
  const origin = { lat: 51.5184, lon: 30.7465 };
  /** A Wi-Fi fix (no speed) 890 m north. */
  const wifi = { lat: origin.lat + 0.008, lon: origin.lon };
  const STAND: DriveSegment[] = [{ durationS: 10, speedMps: 0, yawRateDegS: 0 }];
  const DRIVE_OFF: DriveSegment[] = [...STAND, { durationS: 30, speedMps: 10, yawRateDegS: 0 }];

  /** Placed with no car connected, at home with only Wi-Fi. */
  async function placedWithoutCar(store = memoryStore()) {
    const h = harness({ vin: null, store });
    await h.service.start();
    h.gnss.emit(record({ tUs: h.now() - LATE_US, ...wifi, hAccM: 65 }));
    expect(h.service.getSnapshot()).toMatchObject({ source: "gnss", lat: wifi.lat });
    expect(h.service.setUserPosition(origin, 0.8)).toBe(true);
    return h;
  }

  const minutesLater = (min: number) => {
    jest.setSystemTime(Date.now() + min * 60_000);
    jest.advanceTimersByTime(500);
  };

  test("without a car the map shows it instead of the Wi-Fi fix, which doesn't move it", async () => {
    const h = await placedWithoutCar();
    h.advance(1_000_000);
    h.gnss.emit(record({ tUs: h.now() - LATE_US, lat: wifi.lat + 0.001, lon: wifi.lon, hAccM: 65 }));
    const p = h.service.getSnapshot()!;
    expect(p).toMatchObject({ source: "manual", lat: origin.lat, lon: origin.lon, headingRad: 0.8, accuracyM: 10 });
    expect(p.rawGnss?.lat).toBeCloseTo(wifi.lat + 0.001, 6);
    expect(p.manual).toMatchObject({ asking: false });
    h.service.stop();
  });

  test("15 min on it asks: yes holds it 15 min more, no goes back to the fixes", async () => {
    const h = await placedWithoutCar();
    minutesLater(14);
    expect(h.service.getSnapshot()?.manual?.asking).toBe(false);
    minutesLater(1);
    expect(h.service.getSnapshot()?.manual?.asking).toBe(true);
    expect(h.notes).toContain("nav manual position 15 min old: asking the driver if they are still there");
    h.service.answerManual(true);
    expect(h.service.getSnapshot()).toMatchObject({ source: "manual", manual: { asking: false, confirmedAt: Date.now() } });
    minutesLater(15);
    expect(h.service.getSnapshot()?.manual?.asking).toBe(true);
    h.service.answerManual(false);
    const p = h.service.getSnapshot()!;
    expect(p).toMatchObject({ source: "gnss", lat: wifi.lat });
    expect(p.manual).toBeUndefined();
    expect(storedManual(h.store)).toBeNull();
    h.service.stop();
  });

  test("the chip's ✕ forgets it; with no fix yet there is no position", async () => {
    const h = harness({ vin: null });
    await h.service.start();
    h.service.setUserPosition(origin, 0.8);
    expect(h.service.getSnapshot()?.source).toBe("manual");
    h.service.discardManualPosition();
    expect(h.service.getSnapshot()).toBeNull();
    expect(h.notes).toContain("nav manual position discarded by the driver");
    h.service.stop();
  });

  test("a trusted satellite fix that agrees releases it to GPS", async () => {
    const h = await placedWithoutCar();
    h.advance(1_000_000);
    h.gnss.emit(record({ tUs: h.now() - LATE_US, lat: origin.lat + 0.0001, lon: origin.lon, hAccM: 5, speedMps: 0 }));
    expect(h.service.getSnapshot()).toMatchObject({ source: "gnss", trust: "TRUSTED" });
    expect(h.notes.some((n) => n.startsWith("nav manual position released: GPS trusted, fix 11 m away"))).toBe(true);
    h.service.stop();
  });

  test("trusted satellite fixes elsewhere release it only 5 in a row", async () => {
    const h = await placedWithoutCar();
    for (let i = 1; i <= 5; i++) {
      expect(h.service.getSnapshot()?.source).toBe("manual");
      h.advance(1_000_000);
      h.gnss.emit(record({ tUs: h.now() - LATE_US, lat: origin.lat + 0.005, lon: origin.lon, hAccM: 5, speedMps: 0 }));
    }
    expect(h.service.getSnapshot()).toMatchObject({ source: "gnss", lat: origin.lat + 0.005 });
    h.service.stop();
  });

  /** Placed with the phone's car known but not answering (the adapter not connected, the driver away from it). */
  async function placedCarSilent(store = memoryStore()) {
    const h = harness({ store });
    await h.service.start();
    h.gnss.emit(record({ tUs: h.now() - LATE_US, ...wifi, hAccM: 65 }));
    h.service.setUserPosition(origin, 0.8);
    return h;
  }

  test("placed with the car silent, it is where the car is: GPS elsewhere takes the dot back, the car stays", async () => {
    const h = await placedCarSilent();
    expect(h.notes).toContain("nav parked pose set from the placing: the car isn't answering");
    expect(storedPose(h.store)).toMatchObject({ lat: origin.lat, lon: origin.lon, headingRad: 0.8 });
    // The phone's GPS, trusted, 550 m away: the dot is the phone again.
    for (let i = 1; i <= 5; i++) {
      h.advance(1_000_000);
      h.gnss.emit(record({ tUs: h.now() - LATE_US, lat: origin.lat + 0.005, lon: origin.lon, hAccM: 5, speedMps: 0 }));
    }
    expect(h.service.getSnapshot()).toMatchObject({ source: "gnss", lat: origin.lat + 0.005 });
    expect(storedPose(h.store)).toMatchObject({ lat: origin.lat, lon: origin.lon, headingRad: 0.8 });
    expect(h.service.getParkedCar()).toMatchObject({ lat: origin.lat, lon: origin.lon, headingRad: 0.8 });
    h.service.stop();
  });

  test("placed with the car silent, GPS at home releases it; back in the car, the navigator starts from the placing", async () => {
    const h = await placedCarSilent();
    for (let i = 1; i <= 5; i++) {
      h.advance(1_000_000);
      h.gnss.emit(record({ tUs: h.now() - LATE_US, lat: origin.lat + 0.005, lon: origin.lon, hAccM: 5, speedMps: 0 }));
    }
    h.advance(1_000_000);
    expect(h.service.getSnapshot()?.source).toBe("gnss");
    expect(h.service.getDebug().parkedPose).toBe("kept");
    // In the car, standing, jammed: it answers.
    const drive = syntheticDrive({ segments: [{ durationS: 40, speedMps: 0, yawRateDegS: 0 }], gnss: "none", origin, startHeadingRad: 0.8, seed: 3 });
    h.play(drive, { untilS: 15 });
    expect(h.notes).toContain("nav restart: the car answers again, from the parked pose kept for it");
    expect(h.service.getSnapshot()).toMatchObject({ source: "dr" });
    expect(haversineM(h.service.getSnapshot()!, origin)).toBeLessThan(10);
    h.service.stop();
  });

  test("\"no, I'm not here any more\" leaves the car where it was put; the chip's ✕ forgets that too", async () => {
    const left = await placedCarSilent();
    minutesLater(15);
    left.service.answerManual(false);
    expect(storedPose(left.store)).toMatchObject({ lat: origin.lat, lon: origin.lon });
    left.service.stop();

    // Answered with the car answering (the phone in it): it is the car that moved.
    const inCar = harness({});
    await inCar.service.start();
    inCar.engine.emit("engine-running", inCar.now());
    const standing = syntheticDrive({ segments: [{ durationS: 40, speedMps: 0, yawRateDegS: 0 }], gnss: "none", origin, startHeadingRad: 0.8, seed: 3 });
    inCar.play(standing, { untilS: 2 });
    inCar.service.setUserPosition(origin, 0.8);
    inCar.play(standing, { untilS: 35 });
    expect(storedPose(inCar.store)).not.toBeNull();
    minutesLater(15);
    inCar.service.answerManual(false);
    expect(storedPose(inCar.store)).toBeNull();
    inCar.service.stop();

    const wrong = await placedCarSilent();
    wrong.service.discardManualPosition();
    expect(storedPose(wrong.store)).toBeNull();
    wrong.service.stop();

    // Where the car was stored before the wrong placing comes back.
    const store = memoryStore();
    const before = { lat: origin.lat - 0.003, lon: origin.lon, headingRad: 2, posSigmaM: 5, headingSigmaRad: 0.05 };
    new CalibrationStore(store, PHONE).saveParkedPose(VIN, before, Date.now() - 3_600_000);
    const again = await placedCarSilent(store);
    expect(storedPose(store)).toMatchObject({ lat: origin.lat });
    // Placed once more (corrected), then ✕: back to the pose from before both placings.
    minutesLater(1);
    again.service.setUserPosition({ lat: origin.lat + 0.0005, lon: origin.lon }, 1.0);
    expect(storedPose(store)).toMatchObject({ lat: origin.lat + 0.0005 });
    again.service.discardManualPosition();
    expect(storedPose(store)).toMatchObject(before);
    again.service.stop();
  });

  test("a later start within 15 min starts from it, over an older parked pose; driving releases it", async () => {
    const store = memoryStore();
    const placed = await placedWithoutCar(store);
    placed.service.stop();
    // The car's pose from an hour ago, elsewhere.
    new CalibrationStore(store, PHONE).saveParkedPose(VIN, { ...wifi, headingRad: 2, posSigmaM: 3, headingSigmaRad: 0.05 }, Date.now() - 3_600_000);
    const drive = syntheticDrive({ segments: DRIVE_OFF, gnss: "none", origin, startHeadingRad: 0.8, seed: 3 });
    const next = harness({ store });
    jest.setSystemTime(Date.now() + 5 * 60_000);
    await next.service.start();
    expect(next.notes).toContain("nav mode dr (manual position, 5 min old)");
    next.play(drive);
    const p = next.service.getSnapshot()!;
    expect(p.source).toBe("dr");
    expect(haversineM(p, drive.truthAt(drive.trip.imu.at(-1)!.tUs))).toBeLessThan(25);
    expect(next.notes).toContain("nav manual position released: the car drives");
    expect(storedManual(store)).toBeNull();
    next.service.stop();
  });

  test("a newer parked pose elsewhere wins at the start", async () => {
    const store = memoryStore();
    (await placedWithoutCar(store)).service.stop();
    new CalibrationStore(store, PHONE).saveParkedPose(VIN, { ...wifi, headingRad: 2, posSigmaM: 3, headingSigmaRad: 0.05 }, Date.now() + 60_000);
    const next = harness({ store });
    jest.setSystemTime(Date.now() + 2 * 60_000);
    await next.service.start();
    expect(next.notes).toContain("nav manual position older than the parked pose (890 m apart): parked pose");
    expect(next.notes.some((n) => n.startsWith("nav mode dr (parked pose"))).toBe(true);
    next.service.stop();
  });

  test("an older one isn't started from: the driver is asked first, and yes starts from it", async () => {
    const store = memoryStore();
    (await placedWithoutCar(store)).service.stop();
    const next = harness({ vin: null, store });
    jest.setSystemTime(Date.now() + 20 * 60_000);
    await next.service.start();
    expect(next.notes.some((n) => n.startsWith("nav mode dr (manual position"))).toBe(false);
    expect(next.service.getDebug().mode).toBe("none");
    jest.advanceTimersByTime(500);
    expect(next.service.getSnapshot()).toMatchObject({ source: "manual", manual: { asking: true } });
    next.service.answerManual(true);
    expect(next.service.getDebug().mode).toBe("dr");
    next.service.stop();
  });

  test("forgotten while the car stands: the navigator starts over, without the parked pose saved from it", async () => {
    const store = memoryStore();
    const drive = syntheticDrive({ segments: STAND, gnss: "none", origin, startHeadingRad: 0.8, seed: 3 });
    const h = harness({ store });
    await h.service.start();
    h.play(drive, { untilS: 2 });
    h.service.setUserPosition(origin, 0.8);
    h.play(drive);
    h.service.saveCalibration();
    expect(storedPose(store) && haversineM(storedPose(store)!, origin)).toBeLessThan(2);
    h.service.discardManualPosition();
    expect(storedPose(store)).toBeNull();
    expect(h.service.getDebug().mode).toBe("none");
    h.service.stop();
  });
});

describe("compass in shadow", () => {
  // Turning right 45° at a time: every heading sector, enough for a drive to learn the compass alone.
  const ROUND: DriveSegment[] = [{ durationS: 5, speedMps: 0, yawRateDegS: 0 }];
  for (let i = 0; i < 9; i++) ROUND.push({ durationS: 15, speedMps: 12, yawRateDegS: 0 }, { durationS: 3, speedMps: 8, yawRateDegS: 15 });
  ROUND.push({ durationS: 10, speedMps: 12, yawRateDegS: 0 });

  test("learns the compass per car, keeps it, and logs how far off it was at the next start", async () => {
    const store = memoryStore();
    const drive = syntheticDrive({ segments: ROUND, gnss: "clean", magnetometer: {}, seed: 5 });
    const first = harness({ store });
    await first.service.start();
    first.play(drive);
    first.engine.emit("engine-off", first.now());
    expect(first.notes).toContain("nav compass at start: none (none)");
    expect(first.notes.some((n) => n.startsWith("nav compass none → confirmed"))).toBe(true);
    expect(first.notes.some((n) => n.startsWith("nav compass drive: confirmed"))).toBe(true);
    first.service.stop();
    const kept = new CalibrationStore(store, PHONE).compassCalibrations(VIN);
    expect(kept).toHaveLength(1);
    expect(kept[0].confirmed).toBe(true);

    const second = harness({ store });
    await second.service.start();
    second.play(drive, { untilS: 40 });
    expect(second.notes).toContain(`nav compass from storage: 1 mounting(s) (${kept[0].samples} samples)`);
    const atStart = second.notes.find((n) => n.startsWith("nav compass at start:"))!;
    expect(atStart).toMatch(/° off \(unverified\)$/);
    expect(Math.abs(parseFloat(atStart.slice("nav compass at start: ".length)))).toBeLessThan(10);
    expect(second.service.getDebug().compassOffDeg).not.toBeNull();
    second.service.stop();
  });

  test("the rear tyres apart: learned from the gyro and applied, kept for the car, the next drive starts from it", async () => {
    const store = memoryStore();
    const drive = syntheticDrive({ segments: cityDrive(6), gnss: "clean", seed: 6 });
    const first = harness({ store });
    await first.service.start();
    first.service.setWheelYaw(true);
    first.play(drive, { wheels: true, tyre: -0.0008 });
    first.service.stop();
    const saved = new CalibrationStore(store, PHONE).wheelYaw(VIN)!;
    expect(Math.abs(saved.tyre + 0.0008)).toBeLessThan(0.0002);
    expect(first.notes.some((n) => n.startsWith("nav wheel yaw: tyres") && n.endsWith("saved"))).toBe(true);

    const second = harness({ store });
    await second.service.start();
    second.service.setWheelYaw(true);
    second.play(drive, { untilS: 2, wheels: true, tyre: -0.0008 });
    expect(second.notes.some((n) => n.startsWith("nav wheel yaw: tyres") && n.endsWith("from storage"))).toBe(true);
    second.service.stop();
  });

  test("stores a tyre term only once a drive learned it for a minute, and reloads it with room to move", () => {
    const calibration = new CalibrationStore(memoryStore(), PHONE);
    expect(calibration.saveWheelYaw(VIN, -0.0007, 0.0002, 30)).toBe(false);
    expect(calibration.saveWheelYaw(VIN, -0.02, 0.0002, 300)).toBe(false);
    expect(calibration.saveWheelYaw(VIN, -0.0007, 0.0002, 300)).toBe(true);
    const prior = calibration.wheelYaw(VIN)!;
    expect(prior.tyre).toBe(-0.0007);
    expect(prior.tyreSigma).toBeGreaterThan(0.0005);
    expect(calibration.wheelYaw("OTHERVIN")).toBeNull();
  });

  // The compass reads the phone's field against the IMU's "up"; with the turning from the wheels the IMU is the car's.
  test("with the turning from the wheels it learns nothing, and keeps nothing", async () => {
    const store = memoryStore();
    const drive = syntheticDrive({ segments: ROUND, gnss: "clean", magnetometer: {}, seed: 5 });
    const h = harness({ store });
    await h.service.start();
    h.service.setWheelYaw(true);
    h.play(drive, { wheels: true });
    h.engine.emit("engine-off", h.now());
    h.service.stop();
    expect(h.notes.some((n) => n.startsWith("nav compass none → confirmed"))).toBe(false);
    expect(new CalibrationStore(store, PHONE).compassCalibrations(VIN)).toHaveLength(0);
  });

  test("another car doesn't get it", async () => {
    const calibration = new CalibrationStore(memoryStore(), PHONE);
    calibration.saveCompassCalibrations(VIN, [{ refAxis: 0, up: [0, 0, 1], xtx: new Array(16).fill(1), xty: [1, 1, 1, 1], yty: 1, samples: 80, sectors: 255, confirmed: true }]);
    expect(calibration.compassCalibrations(VIN)).toHaveLength(1);
    expect(calibration.compassCalibrations("OTHERVIN")).toEqual([]);
  });
});

// The fixture graph's long road (src/nav/mapmatch/__tests__/particle-filter.test.ts): due east from a
// dead end, with a one-way branching north 1.73 km along it.
const GRAPH_ORIGIN = { lat: 51.53, lon: 30.75 };
const GRAPH_FILE = readFileSync(path.join(__dirname, "../../../nav/mapmatch/__fixtures__/net.graph.bin"));

function fixtureGraphSource(): RoadGraphSource & { set(on: boolean): void } {
  const listeners = new Set<() => void>();
  const active: ActiveRoadGraph = {
    key: "net:1",
    region: "net",
    graph: new TiledRoadGraph(bufferByteSource(new Uint8Array(GRAPH_FILE)), new LocalFrame(GRAPH_ORIGIN)),
  };
  let on = true;
  return {
    current: () => (on ? active : null),
    subscribe: (l) => (listeners.add(l), () => listeners.delete(l)),
    set: (value) => {
      on = value;
      listeners.forEach((l) => l());
    },
  };
}

// East along the road, then a 90° left onto the branch at the junction (as in particle-filter.test.ts).
const JUNCTION_DRIVE: DriveSegment[] = [
  { durationS: 3, speedMps: 0, yawRateDegS: 0 },
  { durationS: 10, speedMps: 12, yawRateDegS: 0 },
  { durationS: 133.9, speedMps: 12, yawRateDegS: 0 },
  { durationS: 6, speedMps: 5, yawRateDegS: 0 },
  { durationS: 4.5, speedMps: 5, yawRateDegS: 20 },
  { durationS: 20, speedMps: 10, yawRateDegS: 0 },
];

describe("map matching", () => {
  test("in a GNSS outage the dot follows the road the car turned onto, and the trip log has it", async () => {
    const drive = syntheticDrive({ segments: JUNCTION_DRIVE, origin: GRAPH_ORIGIN, startHeadingRad: Math.PI / 2, gnss: "clean", obdScale: 0.99 });
    const { service, play, notes, loggedMapMatch, engine, now } = harness({ roadGraph: fixtureGraphSource() });
    await service.start();
    play(drive, { withoutGnssFromS: 100 });

    expect(notes.find((n) => n.startsWith("mm graph"))).toMatch(/^mm graph net \(OSM /);
    expect(notes.some((n) => n.startsWith("mm tracking"))).toBe(true);
    const p = service.getSnapshot()!;
    expect(p).toMatchObject({ source: "dr", mapMatch: "tracking" });
    // On the branch, ~70 s and ~0.9 km after GNSS was cut, including the turn.
    const truth = drive.truthAt(drive.trip.imu.at(-1)!.tUs);
    expect(haversineM(p, truth)).toBeLessThan(25);
    expect(p.alternatives).toBeUndefined();

    expect(loggedMapMatch.length).toBeGreaterThan(100);
    const last = loggedMapMatch.at(-1)!;
    expect(last).toMatchObject({ state: "tracking", particles: expect.any(Number) });
    expect(last.top[0].weight).toBeGreaterThan(0.8);
    expect(service.getDebug()).toMatchObject({ mapMatchRegion: "net", mapMatch: expect.objectContaining({ state: "tracking" }) });

    // Speed: every filter update is counted, between records and over the drive.
    const logged = loggedMapMatch.reduce((n, r) => n + r.updates.count, 0);
    expect(logged).toBeGreaterThan(500);
    expect(loggedMapMatch.every((r) => r.updates.maxUs * r.updates.count >= r.updates.totalUs - 1)).toBe(true);
    const timing = service.getDebug().mapMatchTiming!;
    expect(timing.count).toBeGreaterThanOrEqual(logged);
    expect(timing.p99Ms).toBeLessThanOrEqual(timing.maxMs);
    expect(timing.share).toBeGreaterThanOrEqual(0); // fake timers stop performance.now: updates take 0 ms here
    // The filter's starts are counted apart from its updates.
    expect(service.getDebug().mapMatchStarts).toEqual({ count: expect.any(Number), maxMs: expect.any(Number) });
    expect(service.getDebug().mapMatchStarts!.count).toBeGreaterThanOrEqual(1);
    engine.emit("engine-off", now());
    // The drive's road corrections are noted after it (the test below).
    expect(notes.findLast((n) => n.startsWith("mm timing"))).toMatch(
      /^mm timing: \d+ updates, p50 [\d.]+ ms, p99 [\d.]+ ms, max [\d.]+ ms, [\d.]+ % of the time, \d+ over 5 ms; \d+ starts?, slowest [\d.]+ ms$/,
    );
    expect(service.getDebug()).toMatchObject({ mapMatchTiming: null, mapMatchStarts: null }); // counting afresh for the next drive
    service.stop();
  });

  test("with GNSS the dot stays the EKF's; removing the region's graph switches map matching off", async () => {
    const drive = syntheticDrive({ segments: JUNCTION_DRIVE, origin: GRAPH_ORIGIN, startHeadingRad: Math.PI / 2, gnss: "clean", obdScale: 0.99 });
    const source = fixtureGraphSource();
    const { service, play, notes } = harness({ roadGraph: source });
    await service.start();
    play(drive, { untilS: 60 });
    expect(service.getSnapshot()).toMatchObject({ source: "fused", mapMatch: "tracking" });

    source.set(false);
    expect(notes.at(-1)).toBe("mm graph none");
    play(drive, { untilS: 62 });
    expect(service.getSnapshot()?.mapMatch).toBeUndefined();
    expect(service.getDebug().mapMatchRegion).toBeNull();
    service.stop();
  });

  test("a simulated outage withholds GNSS from the navigator and scores the dot against it", async () => {
    const drive = syntheticDrive({ segments: JUNCTION_DRIVE, origin: GRAPH_ORIGIN, startHeadingRad: Math.PI / 2, gnss: "clean", obdScale: 0.99 });
    const { service, play, notes, logged } = harness({ roadGraph: fixtureGraphSource() });
    await service.start();
    play(drive, { untilS: 100 });
    service.setSimulatedOutage(true);
    expect(notes.at(-1)).toBe("sim gnss outage on");
    play(drive);

    const p = service.getSnapshot()!;
    // As in a real outage: dead-reckoning on the map, GNSS no longer trusted.
    expect(p).toMatchObject({ source: "dr", mapMatch: "tracking" });
    expect(p.trust).not.toBe("TRUSTED");
    const o = p.simulatedOutage!;
    expect(o.gnss).toBeDefined();
    expect(o.distanceM).toBeGreaterThan(700); // ~800 m driven after the cut
    expect(o.errorM).toBeLessThan(25);
    expect(o.maxErrorM).toBeGreaterThanOrEqual(o.errorM!);
    // The trip log still sees what the map showed.
    expect(logged.at(-1)?.source).toBe("dr");

    service.setSimulatedOutage(false);
    expect(notes.at(-1)).toMatch(/^sim gnss outage off: \d+ s, \d+\.\d\d km, dot \d+ m from GPS \(max \d+ m\)$/);
    expect(service.getSnapshot()?.simulatedOutage).toBeUndefined();
    service.stop();
  });

  test("the debug overlay has the heaviest particles and the hypotheses", async () => {
    const drive = syntheticDrive({ segments: JUNCTION_DRIVE, origin: GRAPH_ORIGIN, startHeadingRad: Math.PI / 2, gnss: "clean", obdScale: 0.99 });
    const { service, play } = harness({ roadGraph: fixtureGraphSource() });
    await service.start();
    play(drive, { untilS: 60 });
    const overlay = service.getMapMatchOverlay()!;
    expect(overlay.particles.length).toBeGreaterThan(0);
    expect(overlay.particles.length).toBeLessThanOrEqual(200);
    expect(overlay.particles[0][2]).toBe(1);
    expect(overlay.clusters[0].weight).toBeGreaterThan(0.9);
    // The same object until the next published position.
    expect(service.getMapMatchOverlay()).toBe(overlay);
    service.stop();
  });

  test("map matching corrects the navigator, and the drive's road corrections are noted", async () => {
    const drive = syntheticDrive({ segments: JUNCTION_DRIVE, origin: GRAPH_ORIGIN, startHeadingRad: Math.PI / 2, gnss: "clean", obdScale: 0.99 });
    const { service, play, notes, engine, now } = harness({ roadGraph: fixtureGraphSource() });
    await service.start();
    play(drive, { withoutGnssFromS: 100 });
    const debug = service.getDebug();
    expect(debug.roadHeading!.accepted).toBeGreaterThan(10);
    expect(debug.roadPosition!.accepted).toBeGreaterThanOrEqual(1);
    engine.emit("engine-off", now());
    expect(notes.find((n) => n.startsWith("mm loop closed:"))).toMatch(/^mm loop closed: road heading \d+ \(0 refused\), road position \d+ \(0 refused\)$/);
    service.stop();
  });

  test("the speed limit comes from the roads map matching believes in; a re-publish of the dot keeps it", async () => {
    const drive = syntheticDrive({ segments: JUNCTION_DRIVE, origin: GRAPH_ORIGIN, startHeadingRad: Math.PI / 2, gnss: "clean", obdScale: 0.99 });
    const limitGraph = { key: "net:1", graph: () => new TiledRoadGraph(bufferByteSource(new Uint8Array(GRAPH_FILE)), new LocalFrame(GRAPH_ORIGIN)) };
    const { service, play, notes } = harness({ roadGraph: fixtureGraphSource(), limitGraph });
    await service.start();
    play(drive, { withoutGnssFromS: 100 });
    const p = service.getSnapshot()!;
    expect(p).toMatchObject({ source: "dr", mapMatch: "tracking" });
    expect(p.speedLimit?.kph).toBeGreaterThan(0);
    expect(notes).toContainEqual(expect.stringMatching(/^speed limit \d+ \((OSM|default)\)$/));

    // The same dot published again with no navigator update between (the outage card on, and off 3 s later): read as
    // a dot without map matching, the sign would go once its 2 s had passed.
    service.setSimulatedOutage(true);
    jest.setSystemTime(Date.now() + 3000);
    service.setSimulatedOutage(false);
    expect(service.getSnapshot()?.speedLimit).toEqual(p.speedLimit);
    service.stop();
  });

  test("a camera on the road ahead of where map matching puts the car, through an outage, until passed", async () => {
    const drive = syntheticDrive({ segments: JUNCTION_DRIVE, origin: GRAPH_ORIGIN, startHeadingRad: Math.PI / 2, gnss: "clean", obdScale: 0.99 });
    const limitGraph = { key: "net:1", graph: () => new TiledRoadGraph(bufferByteSource(new Uint8Array(GRAPH_FILE)), new LocalFrame(GRAPH_ORIGIN)) };
    // 1.4 km east along the drive's road, on a pole beside it, the east-bound traffic.
    const camera = { id: 0, ...new LocalFrame(GRAPH_ORIGIN).toCoordinate(1400, 4), bearingRad: Math.PI / 2, listed: true };
    const { service, play, notes } = harness({ roadGraph: fixtureGraphSource(), limitGraph, cameras: new CameraIndex([camera]) });
    await service.start();
    play(drive, { withoutGnssFromS: 60, untilS: 100 });
    const p = service.getSnapshot()!;
    expect(p).toMatchObject({ source: "dr", mapMatch: "tracking" });
    // 97 s at 12 m/s from a standing start: ~1130 m driven.
    expect(p.cameraAhead?.distanceM).toBeGreaterThan(200);
    expect(p.cameraAhead?.distanceM).toBeLessThan(330);
    expect(notes).toContainEqual(expect.stringMatching(/^camera ahead #0 in \d+ m, limit \d+$/));
    play(drive, { withoutGnssFromS: 60 });
    expect(service.getSnapshot()?.cameraAhead).toBeUndefined();
    expect(notes).toContain("camera passed #0");
    service.stop();
  });

  test("a sign comes to the driver's placing, though no new position follows it while the car stands", async () => {
    const limitGraph = { key: "net:1", graph: () => new TiledRoadGraph(bufferByteSource(new Uint8Array(GRAPH_FILE)), new LocalFrame(GRAPH_ORIGIN)) };
    const h = harness({ vin: null, roadGraph: fixtureGraphSource(), limitGraph });
    await h.service.start();
    expect(h.service.setUserPosition(GRAPH_ORIGIN, Math.PI / 2)).toBe(true);
    // A sign waits its moment before it shows (UI-SPEC §6.4): placed, nothing else publishes the dot again.
    expect(h.service.getSnapshot()).toMatchObject({ source: "manual" });
    expect(h.service.getSnapshot()?.speedLimit).toBeUndefined();
    jest.advanceTimersByTime(1500);
    expect(h.service.getSnapshot()?.speedLimit?.kph).toBeGreaterThan(0);
    h.service.stop();
  });

  test("without a graph nothing changes", async () => {
    const drive = syntheticDrive({ segments: JUNCTION_DRIVE, origin: GRAPH_ORIGIN, startHeadingRad: Math.PI / 2, gnss: "clean", obdScale: 0.99 });
    const { service, play, notes, loggedMapMatch } = harness();
    await service.start();
    play(drive, { untilS: 30 });
    expect(service.getSnapshot()?.mapMatch).toBeUndefined();
    expect(loggedMapMatch).toEqual([]);
    expect(notes.some((n) => n.startsWith("mm "))).toBe(false);
    expect(service.getMapMatchOverlay()).toBeNull();
    service.stop();
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

  test("a parked pose per car; the single pose of older versions still loads", () => {
    const store = memoryStore();
    const calibration = new CalibrationStore(store, PHONE);
    const pose = { lat: 51.5, lon: 30.7, headingRad: 1, posSigmaM: 5, headingSigmaRad: 0.05 };
    store.setJson("nav.parkedPose", { ...pose, vin: VIN, savedAt: 1 });
    expect(calibration.parkedPose(VIN)?.lat).toBe(51.5);
    calibration.saveParkedPose("LOGAN", { ...pose, lat: 51.6 });
    expect(calibration.parkedPose(VIN)?.lat).toBe(51.5);
    expect(calibration.parkedPose("LOGAN")?.lat).toBe(51.6);
    calibration.clearParkedPose("LOGAN");
    expect(calibration.parkedPose("LOGAN")).toBeNull();
    expect(calibration.parkedPose(VIN)?.lat).toBe(51.5);
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

  test("the unknown car's items go to its VIN, unless the VIN has newer ones of its own", () => {
    const store = memoryStore();
    const calibration = new CalibrationStore(store, PHONE);
    const pose = { lat: 51.5, lon: 30.7, headingRad: 1, posSigmaM: 5, headingSigmaRad: 0.05 };
    calibration.saveParkedPose(UNKNOWN_CAR, pose, 20);
    calibration.saveSpeedScale(UNKNOWN_CAR, 1.02, 0.002 ** 2, 20);
    calibration.saveSpeedScale(VIN, 1.01, 0.002 ** 2, 30);
    calibration.moveCar(UNKNOWN_CAR, VIN);
    expect(calibration.parkedPose(VIN)).toMatchObject({ lat: 51.5, vin: VIN, savedAt: 20 });
    expect(calibration.speedScale(VIN)?.ks).toBe(1.01);
    expect(calibration.snapshot(UNKNOWN_CAR)).toEqual({ vin: UNKNOWN_CAR, parkedPose: null, speedScale: null, compass: null, wheelYaw: null });
  });
});

describe("phone-only mode (NAVIGATOR-SPEC §9.6)", () => {
  // The fixture's long road: 60 —160— 61 east, the one-way 162 north from 61 (1.73 km east of 60).
  const FIXTURE = readFileSync(path.join(__dirname, "../../../nav/mapmatch/__fixtures__/net.graph.bin"));
  const ORIGIN = { lat: 51.53, lon: 30.75 };
  const fixtureGraph = () => new TiledRoadGraph(bufferByteSource(new Uint8Array(FIXTURE)), new LocalFrame(ORIGIN));
  const DRIVE: DriveSegment[] = [
    { durationS: 10, speedMps: 0, yawRateDegS: 0 },
    { durationS: 8, speedMps: 12, yawRateDegS: 0 },
    { durationS: 138.5, speedMps: 12, yawRateDegS: 0 },
    { durationS: 6, speedMps: 5, yawRateDegS: 0 },
    { durationS: 4.5, speedMps: 5, yawRateDegS: 20 },
    { durationS: 23, speedMps: 10, yawRateDegS: 0 },
  ];

  test("without an adapter: the driver's placing while standing, then the phone's dead reckoning once it drives", async () => {
    const drive = syntheticDrive({ segments: DRIVE, origin: ORIGIN, startHeadingRad: Math.PI / 2, gnss: "none", phoneAccel: {} });
    const start = drive.truthAt(drive.trip.imu[0].tUs);
    const h = harness({ vin: null, phoneGraph: fixtureGraph });
    h.service.setPhoneOnly(true);
    await h.service.start();
    expect(h.notes).toContain("nav phone-only waits for a start: a GPS fix with a course, or the driver's placing");
    h.play(drive, { untilS: 3, withoutObd: true });
    h.service.setUserPosition(start, Math.PI / 2);
    h.play(drive, { untilS: 8, withoutObd: true });
    expect(h.service.getSnapshot()!.source).toBe("manual");
    h.play(drive, { withoutObd: true });
    expect(h.notes).toContain("nav manual position released: the car drives (phone)");
    const p = h.service.getSnapshot()!;
    expect(p.source).toBe("dr");
    // Turned north onto 162 at the junction, about the right distance up it (the phone's speed is a few % off).
    expect(Math.abs(Math.atan2(Math.sin(p.headingRad!), Math.cos(p.headingRad!)))).toBeLessThan(0.3);
    expect(haversineM(p, drive.truthAt(drive.trip.imu.at(-1)!.tUs))).toBeLessThan(120);
    h.service.stop();
  });

  test("with a route the driver follows, the dot is on it", async () => {
    const drive = syntheticDrive({ segments: DRIVE, origin: ORIGIN, startHeadingRad: Math.PI / 2, gnss: "none", phoneAccel: {} });
    const imu = drive.trip.imu;
    const route = [];
    for (let t = imu[0].tUs; t <= imu.at(-1)!.tUs; t += 2e6) route.push(drive.truthAt(t));
    const h = harness({ vin: null, phoneGraph: fixtureGraph });
    h.service.setPhoneOnly(true);
    h.service.setPhoneRoute(route);
    await h.service.start();
    h.play(drive, { untilS: 3, withoutObd: true });
    h.service.setUserPosition(drive.truthAt(imu[0].tUs), Math.PI / 2);
    h.play(drive, { withoutObd: true });
    expect(h.notes).toContain("nav phone-only route: follows it");
    const p = h.service.getSnapshot()!;
    expect(p.source).toBe("dr");
    expect(haversineM(p, drive.truthAt(imu.at(-1)!.tUs))).toBeLessThan(40);
    h.service.stop();
  });

  test("off: without an adapter the map shows phone GNSS as before", async () => {
    const drive = syntheticDrive({ segments: DRIVE.slice(0, 3), origin: ORIGIN, startHeadingRad: Math.PI / 2, gnss: "coarse", phoneAccel: {} });
    const h = harness({ vin: null, phoneGraph: fixtureGraph });
    await h.service.start();
    h.play(drive, { untilS: 60, withoutObd: true });
    expect(h.service.getSnapshot()?.source).toBe("gnss");
    expect(h.notes.some((n) => n.startsWith("nav phone-only"))).toBe(false);
    h.service.stop();
  });
});
