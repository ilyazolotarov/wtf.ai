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

interface StoredLag extends GnssLagEstimate, PhoneKey {
  savedAt: number;
}

interface StoredSpeedScale {
  ks: number;
  ksVar: number;
  savedAt: number;
}

export interface StoredPose extends ParkedPose {
  vin: string;
  savedAt: number;
}

interface StoredCompass {
  calibrations: CompassCalibration[];
  savedAt: number;
}

interface Stored {
  gnssLag?: StoredLag;
  speedScaleByVin?: Record<string, StoredSpeedScale>;
  compassByVin?: Record<string, StoredCompass>;
}

export const CALIBRATION_KEY = "nav.calibration";
/** Before poses were kept per car: one pose, with its VIN. */
export const PARKED_POSE_KEY = "nav.parkedPose";
export const PARKED_POSES_KEY = "nav.parkedPoses";

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
