// Navigator values kept between sessions (NAVIGATOR-SPEC §7.4), so a session starts calibrated
// instead of re-learning them over the first kilometres:
// - GNSS lag, per phone model + iOS version: Apple's filtering can change with either, so a
//   value stored under another model or version is dropped.
// - OBD speed scale k_s, per VIN: a property of the car and its tyres.
// - the pose while parked, per VIN: the next session starts dead reckoning from it at once
//   instead of waiting for a GNSS course, or for ~500 m of alignment under jamming. One per car: with a
//   single slot, a second car's pose replaced the first's (2026-10-05).
// - the compass calibrations, per VIN (§7.6): the car's own magnetic field and the phone's angle in
//   the mount, learned against known headings over earlier drives, one per mounting (the phone's
//   tilt), most recent first. This phone only (the store is local).
// - the position the driver set on the map (§6.3): for this phone, not a car, so it outlives the session (and a
//   placing made without a car connected) until it is released or discarded.
// The gyro bias and scale are not stored: CoreMotion corrects the bias itself and it drifts
// with temperature, and the learned k_ω mostly absorbs GNSS timing (§7.2), not the gyro.

import type { GnssLagEstimate } from "@/nav/calibration/gnss-lag";
import type { CompassCalibration } from "@/nav/compass/compass";
import type { ParkedPose } from "@/nav/navigator";
import type { KeyValueStore } from "@/obd/vehicle-link-core";

export interface PhoneKey {
  /** `sys_hw` in the trip log, e.g. iPhone14,5. */
  model: string;
  /** e.g. "ios 26.0". */
  os: string;
}

export interface StoredLag extends GnssLagEstimate, PhoneKey {
  savedAt: number;
}

export interface StoredSpeedScale {
  ks: number;
  ksVar: number;
  savedAt: number;
}

export interface StoredPose extends ParkedPose {
  vin: string;
  savedAt: number;
}

/** The driver's placing on the map (NAVIGATOR-SPEC §6.3); times wall clock, ms. */
export interface StoredManualPosition {
  lat: number;
  lon: number;
  headingRad: number;
  placedAt: number;
  /** When it was placed, or last answered "still here". */
  confirmedAt: number;
}

export interface StoredCompass {
  calibrations: CompassCalibration[];
  savedAt: number;
}

interface Stored {
  gnssLag?: StoredLag;
  speedScaleByVin?: Record<string, StoredSpeedScale>;
  compassByVin?: Record<string, StoredCompass>;
}

/**
 * What is stored, raw, for the phone (`vin` absent: its GNSS lag) or for one car. The service writes it to the trip
 * log when a navigator starts, so a replay can start from what the app had (app-replay.ts).
 */
export type StoredSnapshot =
  | { gnssLag: StoredLag | null }
  | { vin: string; parkedPose: StoredPose | null; speedScale: StoredSpeedScale | null; compass: StoredCompass | null };

export const CALIBRATION_KEY = "nav.calibration";
/** Before poses were kept per car: one pose, with its VIN. */
export const PARKED_POSE_KEY = "nav.parkedPose";
export const PARKED_POSES_KEY = "nav.parkedPoses";
export const MANUAL_POSITION_KEY = "nav.manualPosition";

/** Save k_s only once it is learned this well (1σ). The EKF prior is 0.03. */
const SPEED_SCALE_SAVE_SIGMA = 0.01;
/** Added to a stored k_s σ: drives of one car learn 1.00–1.03 (NAVIGATOR-SPEC §5.2). */
const SPEED_SCALE_DRIFT_SIGMA = 0.01;
/** A value outside this range is a bug, not a car. */
const SPEED_SCALE_RANGE = [0.85, 1.15] as const;

export class CalibrationStore {
  private readonly store: KeyValueStore;
  private readonly phone: PhoneKey;

  constructor(store: KeyValueStore, phone: PhoneKey) {
    this.store = store;
    this.phone = phone;
  }

  /** Stored GNSS lag for this phone model and iOS version, s (null: none, or another phone/iOS). */
  gnssLag(): StoredLag | null {
    const lag = this.read().gnssLag;
    if (!lag) return null;
    if (lag.model === this.phone.model && lag.os === this.phone.os && Number.isFinite(lag.lagS)) return lag;
    this.write((s) => delete s.gnssLag);
    return null;
  }

  /** Store a lag measured on this phone; returns false when nothing changed. */
  saveGnssLag(estimate: GnssLagEstimate, now = Date.now()): boolean {
    const old = this.read().gnssLag;
    if (old && old.model === this.phone.model && old.os === this.phone.os && old.lagS === estimate.lagS && old.windows === estimate.windows) {
      return false;
    }
    this.write((s) => (s.gnssLag = { ...estimate, ...this.phone, savedAt: now }));
    return true;
  }

  /** Speed scale prior for this car: the stored value with its variance widened by the drift. */
  speedScale(vin: string): { ks: number; ksVar: number } | null {
    const v = this.read().speedScaleByVin?.[vin];
    if (!v || !(v.ks >= SPEED_SCALE_RANGE[0] && v.ks <= SPEED_SCALE_RANGE[1]) || !(v.ksVar >= 0)) return null;
    return { ks: v.ks, ksVar: v.ksVar + SPEED_SCALE_DRIFT_SIGMA ** 2 };
  }

  /** Store a learned speed scale once it is certain enough; returns whether it was stored. */
  saveSpeedScale(vin: string, ks: number, ksVar: number, now = Date.now()): boolean {
    if (!(ksVar <= SPEED_SCALE_SAVE_SIGMA ** 2) || !(ks >= SPEED_SCALE_RANGE[0] && ks <= SPEED_SCALE_RANGE[1])) return false;
    this.write((s) => (s.speedScaleByVin = { ...s.speedScaleByVin, [vin]: { ks, ksVar, savedAt: now } }));
    return true;
  }

  /** The compass calibrations learned in this car, one per mounting, most recent first (malformed ones dropped). */
  compassCalibrations(vin: string): CompassCalibration[] {
    const list = this.read().compassByVin?.[vin]?.calibrations;
    return Array.isArray(list) ? list.filter(isCalibration) : [];
  }

  saveCompassCalibrations(vin: string, calibrations: CompassCalibration[], now = Date.now()): void {
    this.write((s) => (s.compassByVin = { ...s.compassByVin, [vin]: { calibrations, savedAt: now } }));
  }

  /** Pose saved when this car was last parked. */
  parkedPose(vin: string): StoredPose | null {
    const pose = this.parkedPoses()[vin];
    return pose && Number.isFinite(pose.lat) && Number.isFinite(pose.headingRad) ? pose : null;
  }

  saveParkedPose(vin: string, pose: ParkedPose, now = Date.now()): void {
    this.store.setJson(PARKED_POSES_KEY, { ...this.parkedPoses(), [vin]: { ...pose, vin, savedAt: now } satisfies StoredPose });
  }

  /** This car moved, or a fix showed its pose is wrong. */
  clearParkedPose(vin: string): void {
    const { [vin]: _dropped, ...rest } = this.parkedPoses();
    this.store.setJson(PARKED_POSES_KEY, rest);
  }

  /** The position the driver set on the map, if one is held. */
  manualPosition(): StoredManualPosition | null {
    const m = this.store.getJson<StoredManualPosition>(MANUAL_POSITION_KEY);
    return m && [m.lat, m.lon, m.headingRad, m.placedAt, m.confirmedAt].every(Number.isFinite) ? m : null;
  }

  /** `null`: released or discarded. */
  saveManualPosition(m: StoredManualPosition | null): void {
    this.store.setJson(MANUAL_POSITION_KEY, m);
  }

  /** What is stored for the phone (`vin` null) or this car, as it is. */
  snapshot(vin: string | null): StoredSnapshot {
    const s = this.read();
    if (vin === null) return { gnssLag: s.gnssLag ?? null };
    return { vin, parkedPose: this.parkedPoses()[vin] ?? null, speedScale: s.speedScaleByVin?.[vin] ?? null, compass: s.compassByVin?.[vin] ?? null };
  }

  /** Writes a snapshot back (a replay starting from what the app had); an absent item is cleared. */
  restore(snap: StoredSnapshot): void {
    if (!("vin" in snap)) {
      this.write((s) => (snap.gnssLag ? (s.gnssLag = snap.gnssLag) : delete s.gnssLag));
      return;
    }
    const { vin } = snap;
    this.write((s) => {
      const { [vin]: _scale, ...scales } = s.speedScaleByVin ?? {};
      const { [vin]: _compass, ...compasses } = s.compassByVin ?? {};
      s.speedScaleByVin = snap.speedScale ? { ...scales, [vin]: snap.speedScale } : scales;
      s.compassByVin = snap.compass ? { ...compasses, [vin]: snap.compass } : compasses;
    });
    const { [vin]: _pose, ...poses } = this.parkedPoses();
    this.store.setJson(PARKED_POSES_KEY, snap.parkedPose ? { ...poses, [vin]: snap.parkedPose } : poses);
  }

  private parkedPoses(): Record<string, StoredPose> {
    const poses = this.store.getJson<Record<string, StoredPose>>(PARKED_POSES_KEY);
    if (poses) return poses;
    const old = this.store.getJson<StoredPose>(PARKED_POSE_KEY);
    return old?.vin ? { [old.vin]: old } : {};
  }

  private read(): Stored {
    return this.store.getJson<Stored>(CALIBRATION_KEY) ?? {};
  }

  private write(change: (s: Stored) => void): void {
    const s = this.read();
    change(s);
    this.store.setJson(CALIBRATION_KEY, s);
  }
}

function isCalibration(c: CompassCalibration): boolean {
  const numbers = [...(c?.xtx ?? []), ...(c?.xty ?? []), ...(c?.up ?? []), c?.yty, c?.samples, c?.sectors];
  return c?.xtx?.length === 16 && c.xty?.length === 4 && c.up?.length === 3 && [0, 1, 2].includes(c.refAxis) && numbers.every(Number.isFinite);
}
