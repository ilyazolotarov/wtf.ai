import { NativeModule, requireNativeModule } from "expo";

// Typed binding for modules/sensor-capture (docs/TRIP-LOGGER-SPEC.md §5).

export type LocationPermission = "notDetermined" | "whenInUse" | "always" | "denied" | "restricted";

export interface SensorPermissions {
  location: LocationPermission;
  accuracy: "full" | "reduced";
}

/** Missing optional fields = invalid in CoreLocation (negative accuracy/speed/course). */
export interface NativeGnssFix {
  tUs: number;
  utcUs: number;
  deliveryDelayUs: number;
  lat: number;
  lon: number;
  altMsl?: number;
  altEllipsoid?: number;
  hAcc?: number;
  vAcc?: number;
  speed?: number;
  speedAcc?: number;
  courseRad?: number;
  courseAccRad?: number;
  simulated: boolean;
  fromAccessory: boolean;
}

/**
 * Flat rows. `motion`: 14 values per sample (tUs, gyro xyz rad/s, user accel xyz m/s²,
 * gravity xyz m/s², attitude quaternion w x y z). `gyro`/`accel`: 4 per sample (tUs, x, y, z).
 */
export interface NativeImuBatch {
  motion: number[];
  gyro: number[];
  accel: number[];
}

export const MOTION_ROW = 14;
export const RAW_ROW = 4;

export type SensorCaptureEvents = {
  onGnss: (fix: NativeGnssFix) => void;
  onGnssError: (e: { message: string; code: number }) => void;
  onImuBatch: (batch: NativeImuBatch) => void;
  onAuthorization: (p: SensorPermissions) => void;
};

declare class SensorCaptureNativeModule extends NativeModule<SensorCaptureEvents> {
  nowUs(): number;
  getPermissions(): Promise<SensorPermissions>;
  requestLocationPermission(): Promise<LocationPermission>;
  startGnss(): Promise<boolean>;
  stopGnss(): Promise<void>;
  startImu(options: { rateHz: number; raw: boolean; batchMs: number }): Promise<boolean>;
  stopImu(): Promise<void>;
}

export default requireNativeModule<SensorCaptureNativeModule>("SensorCapture");
