import { readFileSync } from "node:fs";
import path from "node:path";

import { syntheticDrive, type DriveSegment, type SyntheticDrive } from "@/nav/__fixtures__/synthetic-drive";
import { haversineM } from "@/nav/geo";
import { LocalFrame } from "@/nav/geo/local-frame";
import { bufferByteSource } from "@/nav/mapmatch/graph/byte-source";
import { TiledRoadGraph } from "@/nav/mapmatch/graph/road-graph";
import type { GnssFix } from "@/nav/types";
import { Emitter } from "@/obd/emitter";
import type { EngineState, SpeedSample } from "@/obd/types";
import type { KeyValueStore } from "@/obd/vehicle-link-core";
import { CALIBRATION_KEY, CalibrationStore, PARKED_POSES_KEY, type StoredPose } from "@/services/navigation/calibration-store";
import { NavigatorService } from "@/services/navigation/navigator-service";
import type { ActiveRoadGraph, RoadGraphSource } from "@/services/offline-map/road-graph-file";
import type { decodeImuBatch } from "@/services/sensor-capture/sensor-service";
import type { GnssRecord, NavEstimateRecord, NavMapMatchRecord } from "@/triplog/schema";

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
function harness(options: { vin?: string | null; store?: ReturnType<typeof memoryStore>; roadGraph?: RoadGraphSource } = {}) {
  const gnss = new Emitter<[GnssRecord]>();
  const imu = new Emitter<[ReturnType<typeof decodeImuBatch>]>();
  const speed = new Emitter<[SpeedSample]>();
  const engine = new Emitter<[EngineState, number]>();
  const want = jest.fn();
  const notes: string[] = [];
  const logged: NavEstimateRecord[] = [];
  const loggedMapMatch: NavMapMatchRecord[] = [];
  const store = options.store ?? memoryStore();
  // The link's car: null before an adapter initialises (then the expected VIN is `options.vin`); a VIN of null is a car it doesn't know.
  let vehicle: { vin: string | null } | null = options.vin === null ? null : { vin: options.vin ?? VIN };
  let nowUs = 1_000_000_000;
  jest.setSystemTime((nowUs + UTC_OFFSET_US) / 1000);
  const service = new NavigatorService({
    sensors: { gnss, imu, want } as never,
    link: {
      onSpeed: (l) => speed.on(l),
      onEngineState: (l) => engine.on(l),
      getSnapshot: () => ({ vehicle: vehicle as never }),
      expectedVin: () => (vehicle ? vehicle.vin : null),
    },
    calibration: new CalibrationStore(store, PHONE),
    nowUs: () => nowUs,
    note: (text) => notes.push(text),
    log: (r) => logged.push(r),
    logMapMatch: (r) => loggedMapMatch.push(r),
    roadGraph: options.roadGraph,
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
    let k = trip.mag.findIndex((s) => s.tUs > nowUs);
    if (k < 0) k = trip.mag.length;
    while (nowUs < lastUs) {
      nowUs += 100_000;
      const batch = [];
      while (i < trip.imu.length && trip.imu[i].tUs <= nowUs) {
        const s = trip.imu[i++];
        batch.push({ timestampUs: s.tUs, gyro: s.gyro, gravity: s.gravity, userAccel: s.userAccel, attitude: [1, 0, 0, 0] as [number, number, number, number] });
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
  return { service, gnss, engine, want, notes, logged, loggedMapMatch, store, play, setVehicle, now: () => nowUs };
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

/** The parked pose stored for a car. */
const storedPose = (store: KeyValueStore, vin = VIN) => store.getJson<Record<string, StoredPose>>(PARKED_POSES_KEY)?.[vin] ?? null;

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

  test("under jamming the next session dead-reckons from it right away, and driving clears it", async () => {
    const { store, pose } = await parkFirst();
    const drive = syntheticDrive({ segments: DRIVE_OFF, gnss: "coarse", origin: pose, startHeadingRad: pose.headingRad, seed: 7 });
    const next = harness({ store });
    await next.service.start();
    expect(next.notes.some((n) => n.startsWith("nav mode dr (parked pose"))).toBe(true);
    next.play(drive, { untilS: 5 });
    expect(next.service.getSnapshot()).toMatchObject({ source: "dr" });
    next.play(drive);
    expect(storedPose(store)).toBeNull();
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

  test("placed with a heading while standing: it becomes the car's parked pose at once", async () => {
    const store = memoryStore();
    const drive = syntheticDrive({ segments: SEGMENTS, gnss: "none", origin, startHeadingRad: 0.8, seed: 3 });
    const h = harness({ store });
    await h.service.start();
    h.play(drive, { untilS: 3 });
    h.service.setUserPosition(origin, 0.8);
    const pose = storedPose(store);
    expect(pose && haversineM(pose, origin)).toBeLessThan(2);
    expect(pose?.headingRad).toBeCloseTo(0.8, 2);
    h.service.stop();
  });

  test("without a heading: anchored there", async () => {
    const drive = syntheticDrive({ segments: SEGMENTS, gnss: "none", origin, startHeadingRad: 0.8, seed: 3 });
    const h = harness({ vin: null });
    await h.service.start();
    h.play(drive, { untilS: 3 });
    h.service.setUserPosition(origin);
    h.play(drive, { untilS: 5 });
    expect(h.notes.some((n) => n.endsWith("heading skipped"))).toBe(true);
    expect(h.service.getDebug().mode).toBe("anchored");
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
    expect(notes.at(-1)).toMatch(
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

  test("the navigator version switch: the running navigator follows, and the drive's road corrections are noted", async () => {
    const drive = syntheticDrive({ segments: JUNCTION_DRIVE, origin: GRAPH_ORIGIN, startHeadingRad: Math.PI / 2, gnss: "clean", obdScale: 0.99 });
    const { service, play, notes, engine, now } = harness({ roadGraph: fixtureGraphSource() });
    await service.start();
    expect(service.getDebug().mapMatchLoop).toBe("open");
    play(drive, { untilS: 30 });
    service.setMapMatchLoop("closed");
    expect(notes.at(-1)).toBe("nav map-match loop closed");
    play(drive, { withoutGnssFromS: 100 });
    const debug = service.getDebug();
    expect(debug.mapMatchLoop).toBe("closed");
    expect(debug.roadHeading!.accepted).toBeGreaterThan(10);
    expect(debug.roadPosition!.accepted).toBeGreaterThanOrEqual(1);
    engine.emit("engine-off", now());
    expect(notes.find((n) => n.startsWith("mm loop closed:"))).toMatch(/^mm loop closed: road heading \d+ \(0 refused\), road position \d+ \(0 refused\)$/);
    service.stop();
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
});
