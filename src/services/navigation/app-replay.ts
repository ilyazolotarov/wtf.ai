// A trip log replayed through the app's own NavigatorService (not a Navigator alone), so a replay is what the app
// would show now: the reorder window, the parked pose per car (started from, confirmed, saved every 30 s, dropped
// once the car moves), the speed scale, GNSS lag and compass from storage, the simulated outages, and the dot the
// service publishes (`published`, the trip log's `nav_estimate`). Inputs arrive as on the phone: IMU in 100 ms
// batches, OBD speed when its reply came, fixes after CoreLocation's delivery delay, all on a virtual clock (uptime
// from the log, wall clock from its time sync). A ReplayRecorder looks in through the service's observer, so the
// result has the same track, fixes, particles and summary as `replayTrip`.
// Drives replayed in order with one CalibrationStore carry what the app keeps from drive to drive.

import { jamFixes, type JamOptions, type JamWindow } from "@/nav/replay/jam";
import { appOutageCuts, ReplayRecorder, type RecorderOptions, type ReplayCut, type ReplayResult } from "@/nav/replay/replay";
import type { NavConfig } from "@/nav/navigator";
import { isSatelliteFix, type GnssFix } from "@/nav/types";
import type { EngineState, SpeedSample } from "@/obd/types";
import type { ActiveRoadGraph } from "@/services/offline-map/road-graph-file";
import type { TripLog } from "@/triplog/trip-log-reader";
import { ENGINE_STATE_CODES, type GnssRecord, type ImuMotionRecord, type NavEstimateRecord, type NavMapMatchRecord, type Vec3Record } from "@/triplog/schema";

import type { KeyValueStore } from "@/obd/vehicle-link-core";

import type { CalibrationStore, PhoneKey, StoredSnapshot } from "./calibration-store";
import { NavigatorService, STORAGE_NOTE, toNavFix, type MapMatchLoop, type ServiceClock } from "./navigator-service";

/** The app's key-value storage in memory: one carried through drives replayed in order, copied to try variants. */
export class MemoryKeyValueStore implements KeyValueStore {
  constructor(private readonly data = new Map<string, string>()) {}
  getJson<T>(key: string): T | null {
    const v = this.data.get(key);
    return v === undefined ? null : (JSON.parse(v) as T);
  }
  setJson(key: string, value: unknown): void {
    this.data.set(key, JSON.stringify(value));
  }
  copy(): MemoryKeyValueStore {
    return new MemoryKeyValueStore(new Map(this.data));
  }
}

/**
 * Puts into `calibration` what the app had stored when the log's navigator started (its `nav storage` notes, the
 * first for the phone and for each car). Returns how many it found (0: an older log, which doesn't have them).
 */
export function seedFromLog(trip: TripLog, calibration: CalibrationStore): number {
  const seen = new Set<string>();
  for (const m of trip.messages) {
    if (!m.text.startsWith(STORAGE_NOTE)) continue;
    let snap: StoredSnapshot;
    try {
      snap = JSON.parse(m.text.slice(STORAGE_NOTE.length)) as StoredSnapshot;
    } catch {
      continue; // cut at the log's 4000-character limit
    }
    const key = "vin" in snap ? snap.vin : "";
    if (seen.has(key)) continue;
    seen.add(key);
    calibration.restore(snap);
  }
  return seen.size;
}

/** The phone a log was recorded on (the GNSS lag is stored per model and iOS version). */
export function phoneOf(trip: TripLog): PhoneKey {
  return { model: String(trip.info.sys_hw ?? "unknown"), os: String(trip.info.sys_os_ver ?? "unknown") };
}

/** IMU batches from the sensor module (SensorService), as on the phone. */
const IMU_BATCH_US = 100_000;
/** A fix's delivery when its record doesn't say (CoreLocation's usual). */
const DEFAULT_DELIVERY_US = 50_000;

export interface AppReplayOptions extends Pick<RecorderOptions, "trackStepS" | "truthAccuracyM" | "truthLagS"> {
  /** What the app keeps between drives: parked poses, speed scales, compass calibrations, GNSS lag. */
  calibration: CalibrationStore;
  loop?: MapMatchLoop;
  nav?: Partial<NavConfig>;
  /** The active region's road graph (map matching off without it). */
  roadGraph?: ActiveRoadGraph | null;
  /** GNSS withheld (the service's simulated outage) in these windows; default: the log's own "Cut GPS" moments. */
  cuts?: ReplayCut[];
  /** Simulated jamming (jam.ts): satellite fixes in these windows become coarse ones. */
  jam?: JamWindow[];
  jamOptions?: Partial<JamOptions>;
  /** Withhold every fix from this long after the heading is first known. */
  openLoop?: { delayS: number };
  /** The car's VIN (default: the log's; null: a car the link doesn't know). */
  vin?: string | null;
  /** Map-matching truth and particle snapshots for the recorder (the graph is `roadGraph`'s). */
  mapMatch?: Pick<NonNullable<RecorderOptions["mapMatch"]>, "truth" | "particlesEveryS">;
}

export interface AppReplayResult extends ReplayResult {
  /** Every position the service published, as the trip log records it. */
  published: NavEstimateRecord[];
  publishedMapMatch: NavMapMatchRecord[];
  /** The service's notes (what the app would write to the trip log). */
  notes: { tUs: number; text: string }[];
}

/** Listeners that let a failure through (the app's Emitter logs and swallows it, which would hide a replay bug). */
class Channel<Args extends unknown[]> {
  private readonly listeners = new Set<(...args: Args) => void>();
  on = (listener: (...args: Args) => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  emit(...args: Args): void {
    for (const l of this.listeners) l(...args);
  }
}

/** A navigator fix as CoreLocation's record (synthetic logs, jammed fixes); `utcUs` from the log's clock. */
function recordFromFix(f: GnssFix, utcUs: number, like?: GnssRecord): GnssRecord {
  const satellite = isSatelliteFix(f);
  return {
    timestampUs: f.tUs,
    utcUs,
    latDeg: f.lat,
    lonDeg: f.lon,
    altMslM: like?.altMslM ?? NaN,
    altEllipsoidM: like?.altEllipsoidM ?? NaN,
    hAccM: f.hAccM,
    vAccM: like?.vAccM ?? NaN,
    speedMps: satellite ? (f.speedMps ?? NaN) : NaN,
    speedAccMps: satellite ? (f.speedAccMps ?? NaN) : NaN,
    courseRad: satellite ? (f.courseRad ?? NaN) : NaN,
    courseAccRad: satellite ? (f.courseAccRad ?? NaN) : NaN,
    deliveryDelayUs: like?.deliveryDelayUs ?? DEFAULT_DELIVERY_US,
    flags: 0,
  };
}

/** Uptime → wall clock, µs: the log's time-sync pairs, else its fixes, else an arbitrary offset. */
function wallClock(trip: TripLog): (tUs: number) => number {
  const pairs = trip.timeSync.length ? trip.timeSync : (trip.gnssRecords ?? []).filter((r) => Number.isFinite(r.utcUs)).map((r) => ({ tUs: r.timestampUs, utcUs: r.utcUs }));
  if (!pairs.length) return (tUs) => tUs + 1_700_000_000_000_000;
  return (tUs) => {
    let k = 0;
    while (k + 1 < pairs.length && pairs[k + 1].tUs <= tUs) k++;
    return pairs[k].utcUs + (tUs - pairs[k].tUs);
  };
}

export function replayTripInApp(trip: TripLog, o: AppReplayOptions): AppReplayResult {
  const utcAt = wallClock(trip);
  const tS = (tUs: number) => (tUs - trip.startUs) / 1e6;
  let nowUs = trip.startUs;
  const timers: { fn: () => void; everyUs: number; nextUs: number; id: number }[] = [];
  let timerId = 0;
  const clock: ServiceClock = {
    nowMs: () => utcAt(nowUs) / 1000,
    setInterval: (fn, ms) => {
      timers.push({ fn, everyUs: ms * 1000, nextUs: nowUs + ms * 1000, id: ++timerId });
      return timerId;
    },
    clearInterval: (id) => {
      const k = timers.findIndex((t) => t.id === id);
      if (k >= 0) timers.splice(k, 1);
    },
  };

  const gnss = new Channel<[GnssRecord]>();
  const imu = new Channel<[{ motion: ImuMotionRecord[]; mag: Vec3Record[] }]>();
  const speed = new Channel<[SpeedSample]>();
  const engine = new Channel<[EngineState, number]>();
  const logVin = typeof trip.info.vehicle_vin === "string" && trip.info.vehicle_vin ? trip.info.vehicle_vin : null;
  const vin = o.vin === undefined ? logVin : o.vin;
  const published: NavEstimateRecord[] = [];
  const publishedMapMatch: NavMapMatchRecord[] = [];
  const notes: AppReplayResult["notes"] = [];
  const graph = o.roadGraph ?? null;
  const rec = new ReplayRecorder(trip, {
    cuts: o.cuts ?? appOutageCuts(trip),
    openLoop: o.openLoop,
    trackStepS: o.trackStepS,
    truthAccuracyM: o.truthAccuracyM,
    truthLagS: o.truthLagS,
    ...(graph ? { mapMatch: { graph: graph.graph, ...o.mapMatch } } : {}),
  });

  const service = new NavigatorService({
    sensors: { gnss, imu, want: () => {} } as never,
    link: {
      onSpeed: speed.on,
      onEngineState: engine.on,
      getSnapshot: () => ({ vehicle: { vin } as never }),
      expectedVin: () => vin,
    },
    calibration: o.calibration,
    nowUs: () => nowUs,
    clock,
    note: (text) => notes.push({ tUs: nowUs, text }),
    log: (r) => published.push(r),
    logMapMatch: (r) => publishedMapMatch.push(r),
    roadGraph: { current: () => graph, subscribe: () => () => {} },
    nav: o.nav,
    observer: {
      navigator: (nav) => rec.use(nav),
      fix: (fix, out) => rec.fixOutcome(fix, out),
      fed: (tUs) => rec.afterEvent(tUs),
      withheld: (r) => {
        const fix = toNavFix(r);
        if (fix) rec.withheld(fix);
      },
    },
  });
  if (o.loop) service.setMapMatchLoop(o.loop);

  // The inputs, each at the time the app would get it.
  const records = (() => {
    const own = trip.gnssRecords;
    if (o.jam?.length || !own) {
      const byTime = new Map((own ?? []).map((r) => [r.timestampUs, r]));
      const fixes = o.jam?.length ? jamFixes(trip.gnss, trip.startUs, o.jam, o.jamOptions) : trip.gnss;
      return fixes.map((f) => {
        const like = byTime.get(f.tUs);
        return recordFromFix(f, like?.utcUs ?? utcAt(f.tUs), like);
      });
    }
    return own;
  })();
  const arrival = (r: GnssRecord) => r.timestampUs + (Number.isFinite(r.deliveryDelayUs) && r.deliveryDelayUs >= 0 ? r.deliveryDelayUs : DEFAULT_DELIVERY_US);
  const fixes = [...records].sort((a, b) => arrival(a) - arrival(b));
  const engineStates = trip.engine
    .map((e) => ({ tUs: e.tUs, state: e.state as EngineState }))
    .filter((e) => (ENGINE_STATE_CODES as readonly string[]).includes(e.state));
  const ends = [trip.imu.at(-1)?.tUs, trip.obdSpeed.at(-1)?.tUs, trip.gnss.at(-1)?.tUs].filter((t): t is number => t !== undefined);
  const endUs = ends.length ? Math.max(...ends) : trip.startUs;

  service.setKeepAlive(true);
  let i = 0;
  let k = 0;
  let ob = 0;
  let g = 0;
  let en = 0;
  while (nowUs < endUs + IMU_BATCH_US) {
    nowUs += IMU_BATCH_US;
    // The scenario's outage, as the developer switch would set it.
    service.setSimulatedOutage(rec.inCut(tS(nowUs)));
    while (en < engineStates.length && engineStates[en].tUs <= nowUs) {
      const e = engineStates[en++];
      engine.emit(e.state, e.tUs);
    }
    while (ob < trip.obdSpeed.length && (trip.obdSpeed[ob].rxUs ?? trip.obdSpeed[ob].tUs) <= nowUs) {
      const s = trip.obdSpeed[ob++];
      const rx = s.rxUs ?? s.tUs;
      speed.emit({ txUs: 2 * s.tUs - rx, rxUs: rx, tUs: s.tUs, speedMps: s.speedMps, raw: s.rawKph });
    }
    while (g < fixes.length && arrival(fixes[g]) <= nowUs) gnss.emit(fixes[g++]);
    const motion: ImuMotionRecord[] = [];
    while (i < trip.imu.length && trip.imu[i].tUs <= nowUs) {
      const s = trip.imu[i++];
      motion.push({ timestampUs: s.tUs, gyro: s.gyro, gravity: s.gravity, userAccel: s.userAccel, attitude: [1, 0, 0, 0] });
    }
    const mag: Vec3Record[] = [];
    while (k < (trip.mag?.length ?? 0) && trip.mag[k].tUs <= nowUs) {
      const s = trip.mag[k++];
      mag.push({ timestampUs: s.tUs, v: s.field });
    }
    if (motion.length || mag.length) imu.emit({ motion, mag });
    for (const t of [...timers]) {
      while (timers.includes(t) && t.nextUs <= nowUs) {
        t.nextUs += t.everyUs;
        t.fn();
      }
    }
  }
  // The app closes: what's pending is fed, and the calibration saved.
  service.setKeepAlive(false);
  const result = rec.finish(tS(endUs));
  return { ...result, published, publishedMapMatch, notes };
}
