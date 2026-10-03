import type { EventSubscription } from "expo-modules-core";

import SensorCaptureModule, {
  MOTION_ROW,
  RAW_ROW,
  type LocationPermission,
  type NativeGnssFix,
  type NativeImuBatch,
} from "../../../modules/sensor-capture/src/SensorCaptureModule";
import { Emitter } from "@/obd/emitter";
import { GNSS_FLAGS, type GnssRecord, type ImuMotionRecord, type Vec3Record } from "@/triplog/schema";

export interface ImuSettings {
  rateHz: number;
  raw: boolean;
}

export interface SensorSnapshot {
  permission: LocationPermission | null;
  gnssRunning: boolean;
  imuRunning: boolean;
  gnssHz: number;
  imuHz: number;
  lastFix: GnssRecord | null;
  lastError: string | null;
}

const nan = (v: number | undefined) => (v === undefined ? NaN : v);

export function toGnssRecord(f: NativeGnssFix): GnssRecord {
  return {
    timestampUs: Math.round(f.tUs),
    utcUs: Math.round(f.utcUs),
    latDeg: f.lat,
    lonDeg: f.lon,
    altMslM: nan(f.altMsl),
    altEllipsoidM: nan(f.altEllipsoid),
    hAccM: nan(f.hAcc),
    vAccM: nan(f.vAcc),
    speedMps: nan(f.speed),
    speedAccMps: nan(f.speedAcc),
    courseRad: nan(f.courseRad),
    courseAccRad: nan(f.courseAccRad),
    deliveryDelayUs: Math.round(f.deliveryDelayUs),
    flags: (f.simulated ? GNSS_FLAGS.simulated : 0) | (f.fromAccessory ? GNSS_FLAGS.fromAccessory : 0),
  };
}

export function decodeImuBatch(b: NativeImuBatch): { motion: ImuMotionRecord[]; gyro: Vec3Record[]; accel: Vec3Record[] } {
  const motion: ImuMotionRecord[] = [];
  for (let i = 0; i + MOTION_ROW <= b.motion.length; i += MOTION_ROW) {
    const r = b.motion;
    motion.push({
      timestampUs: Math.round(r[i]),
      gyro: [r[i + 1], r[i + 2], r[i + 3]],
      userAccel: [r[i + 4], r[i + 5], r[i + 6]],
      gravity: [r[i + 7], r[i + 8], r[i + 9]],
      attitude: [r[i + 10], r[i + 11], r[i + 12], r[i + 13]],
    });
  }
  const vec = (rows: number[]): Vec3Record[] => {
    const out: Vec3Record[] = [];
    for (let i = 0; i + RAW_ROW <= rows.length; i += RAW_ROW) {
      out.push({ timestampUs: Math.round(rows[i]), v: [rows[i + 1], rows[i + 2], rows[i + 3]] });
    }
    return out;
  };
  return { motion, gyro: vec(b.gyro), accel: vec(b.accel) };
}

class RateMeter {
  private times: number[] = [];
  add(tUs: number, count = 1): void {
    for (let i = 0; i < count; i++) this.times.push(tUs);
    const cutoff = tUs - 5_000_000;
    while (this.times.length > 0 && this.times[0] < cutoff) this.times.shift();
  }
  hz(): number {
    if (this.times.length < 2) return 0;
    const span = this.times[this.times.length - 1] - this.times[0];
    return span > 0 ? ((this.times.length - 1) * 1e6) / span : 0;
  }
  reset(): void {
    this.times = [];
  }
}

/** Starts/stops native capture on demand and fans records out (TRIP-LOGGER-SPEC §5). */
export class SensorService {
  readonly gnss = new Emitter<[GnssRecord]>();
  readonly imu = new Emitter<[ReturnType<typeof decodeImuBatch>]>();

  private snapshot: SensorSnapshot = {
    permission: null,
    gnssRunning: false,
    imuRunning: false,
    gnssHz: 0,
    imuHz: 0,
    lastFix: null,
    lastError: null,
  };
  private listeners = new Set<() => void>();
  private subscriptions: EventSubscription[] = [];
  private gnssRate = new RateMeter();
  private imuRate = new RateMeter();
  private lastNotifyUs = 0;
  private imuSettings: ImuSettings = { rateHz: 100, raw: false };
  private wanted = { gnss: false, imu: false };
  private applying: Promise<void> = Promise.resolve();

  constructor() {
    this.subscriptions.push(
      SensorCaptureModule.addListener("onGnss", (fix) => {
        const rec = toGnssRecord(fix);
        this.gnssRate.add(rec.timestampUs);
        this.gnss.emit(rec);
        this.update({ lastFix: rec, gnssHz: this.gnssRate.hz(), lastError: null });
      }),
      SensorCaptureModule.addListener("onGnssError", (e) => this.update({ lastError: e.message })),
      SensorCaptureModule.addListener("onImuBatch", (batch) => {
        const decoded = decodeImuBatch(batch);
        const last = decoded.motion[decoded.motion.length - 1];
        if (last) this.imuRate.add(last.timestampUs, decoded.motion.length);
        this.imu.emit(decoded);
        const now = last?.timestampUs ?? 0;
        if (now - this.lastNotifyUs > 1_000_000) {
          this.lastNotifyUs = now;
          this.update({ imuHz: this.imuRate.hz() });
        }
      }),
      SensorCaptureModule.addListener("onAuthorization", (p) => this.update({ permission: p.location })),
    );
    void SensorCaptureModule.getPermissions().then((p) => this.update({ permission: p.location }));
  }

  getSnapshot = (): SensorSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async requestPermission(): Promise<LocationPermission> {
    const p = await SensorCaptureModule.requestLocationPermission();
    this.update({ permission: p });
    return p;
  }

  setImuSettings(settings: ImuSettings): void {
    const changed = settings.rateHz !== this.imuSettings.rateHz || settings.raw !== this.imuSettings.raw;
    this.imuSettings = settings;
    if (changed && this.snapshot.imuRunning) {
      this.wanted.imu = false;
      void this.apply().then(() => this.want(this.wanted.gnss, true));
    }
  }

  /** Declare what should be running; idempotent. */
  want(gnss: boolean, imu: boolean): void {
    if (this.wanted.gnss === gnss && this.wanted.imu === imu) return;
    this.wanted = { gnss, imu };
    void this.apply();
  }

  private apply(): Promise<void> {
    this.applying = this.applying.then(async () => {
      const { gnss, imu } = this.wanted;
      try {
        if (gnss && !this.snapshot.gnssRunning) {
          const started = await SensorCaptureModule.startGnss();
          this.update({ gnssRunning: started, lastError: started ? null : "location permission missing" });
        } else if (!gnss && this.snapshot.gnssRunning) {
          await SensorCaptureModule.stopGnss();
          this.gnssRate.reset();
          this.update({ gnssRunning: false, gnssHz: 0 });
        }
        if (imu && !this.snapshot.imuRunning) {
          const started = await SensorCaptureModule.startImu({ ...this.imuSettings, batchMs: 100 });
          this.update({ imuRunning: started });
        } else if (!imu && this.snapshot.imuRunning) {
          await SensorCaptureModule.stopImu();
          this.imuRate.reset();
          this.update({ imuRunning: false, imuHz: 0 });
        }
      } catch (error) {
        this.update({ lastError: String(error) });
      }
    });
    return this.applying;
  }

  private update(patch: Partial<SensorSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }
}
