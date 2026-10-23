// Sensor inputs of the navigation core (SPEC §3.2). Pure data, SI units, monotonic
// uptime µs timestamps. Live services and the replay harness both produce these.

export type Vec3 = readonly [number, number, number];

/** CoreMotion device motion (`xArbitraryZVertical`), ~100 Hz. */
export interface ImuSample {
  tUs: number;
  /** Rotation rate, rad/s, device frame. */
  gyro: Vec3;
  /** Gravity, m/s², device frame (points down). */
  gravity: Vec3;
  /** Acceleration without gravity, m/s², device frame. */
  userAccel: Vec3;
  /**
   * The car's sample in place of the phone's (wheel yaw, NAVIGATOR-SPEC §5.4) while the phone's own read handled: in
   * the car's frame the navigator can't see that itself, and a parked car's pose freezes on it (§6.1).
   */
  handled?: true;
}

/** Raw magnetometer (`CMMagnetometerData`, uncalibrated), ~20 Hz. */
export interface MagSample {
  tUs: number;
  /** Magnetic field, µT, device frame. */
  field: Vec3;
}

/** OBD PID 0D. `tUs` is the sample time (midpoint of tx and rx). */
export interface ObdSpeedSample {
  tUs: number;
  speedMps: number;
  /** Raw PID byte, km/h (from CAN: the wheel speed in its 0.01 km/h steps). */
  rawKph: number;
  /** CAN wheel speeds (SPEC §2.1 Stage 2) instead of PID `0D`: finer and more often, so trusted more. */
  source?: "can";
}

/** CoreLocation fix. Optional fields are absent when CoreLocation reports them invalid. */
export interface GnssFix {
  /** Fix time (not delivery time). */
  tUs: number;
  lat: number;
  lon: number;
  hAccM: number;
  speedMps?: number;
  speedAccMps?: number;
  /** Course over ground, clockwise from north. */
  courseRad?: number;
  courseAccRad?: number;
}

/**
 * Satellite fix vs Wi-Fi/cell fallback. Under jamming iOS reports positions without
 * speed; those are coarse, often repeated, and their errors are correlated.
 */
/** A fix claiming worse than this is coarse whatever its source: it is weighed like a Wi-Fi/cell one. */
export const SATELLITE_MAX_HACC_M = 50;

export function isSatelliteFix(fix: GnssFix): boolean {
  return fix.speedMps !== undefined && fix.hAccM < SATELLITE_MAX_HACC_M;
}
