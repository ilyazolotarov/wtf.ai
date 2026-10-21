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
 * gravity xyz m/s², attitude quaternion w x y z). `gyro`/`accel`/`mag`: 4 per sample (tUs, x, y, z);
 * `mag` is the raw magnetic field in µT.
 */
export interface NativeImuBatch {
  motion: number[];
  gyro: number[];
  accel: number[];
  mag: number[];
}

export const MOTION_ROW = 14;
export const RAW_ROW = 4;

/** The previous process's last heartbeat (`processStats`), read at this launch (TRIP-LOGGER-SPEC §4.4). */
export interface PreviousRun {
  wallMs: number;
  appState: string;
  /** What the app was doing, as JS said (`processStats` context). */
  context: string;
  /** -1 unknown. */
  footprintMb: number;
  headroomMb: number;
  thermal: string;
  memoryWarnings: number;
  /** iOS: the system said it would end the app (`applicationWillTerminate`). */
  willTerminateWallMs?: number;
}

export interface LaunchInfo {
  wallMs: number;
  uptimeUs: number;
  inBackground: boolean;
  /** iOS launch options (`location`, `bluetooth`, …); Android the start reason when the OS gives one. */
  reasons: string[];
  previous?: PreviousRun;
}

/** The newest location iOS gave for the drive wake (the one it relaunched the app for, or one cached before). */
export interface DriveWakeFix {
  lat: number;
  lon: number;
  accuracyM: number;
  wallMs: number;
}

export interface NativeProcessStats {
  footprintMb: number;
  headroomMb: number;
  /** CPU time used since the process started, s. */
  cpuS: number;
  thermal: "nominal" | "fair" | "serious" | "critical";
  lowPower: boolean;
  memoryWarnings: number;
}

/** What the OS reported about the app since the last call (iOS MetricKit, Android's exit history). */
export type HealthReport =
  | {
      kind: "exits";
      fromMs: number;
      toMs: number;
      foreground: Record<string, number>;
      background: Record<string, number>;
    }
  | { kind: "crash"; atMs: number; exceptionType?: number; exceptionCode?: number; signal?: number; terminationReason?: string; build?: string }
  | { kind: "hang"; atMs: number; seconds: number }
  | { kind: "cpu"; atMs: number; cpuSeconds: number; sampledSeconds: number }
  | { kind: "exit"; atMs: number; reason: string; importance: string; description?: string; pssMb?: number; rssMb?: number };

export type SensorCaptureEvents = {
  onGnss: (fix: NativeGnssFix) => void;
  onGnssError: (e: { message: string; code: number }) => void;
  onImuBatch: (batch: NativeImuBatch) => void;
  onAuthorization: (p: SensorPermissions) => void;
  onMemoryWarning: (e: { level?: string }) => void;
};

declare class SensorCaptureNativeModule extends NativeModule<SensorCaptureEvents> {
  nowUs(): number;
  getPermissions(): Promise<SensorPermissions>;
  requestLocationPermission(): Promise<LocationPermission>;
  startGnss(): Promise<boolean>;
  stopGnss(): Promise<void>;
  startImu(options: { rateHz: number; raw: boolean; batchMs: number; magRateHz: number }): Promise<boolean>;
  stopImu(): Promise<void>;
  /** The app process (TRIP-LOGGER-SPEC §4.4). */
  launchInfo(): LaunchInfo;
  /** Also keeps a heartbeat the next launch reads (`LaunchInfo.previous`). */
  processStats(appState: string, context: string): Promise<NativeProcessStats>;
  takeHealthReports(): HealthReport[];
  /**
   * iOS: hold (or let go) the background location session (TRIP-LOGGER-SPEC §4.3); only one held while the app is in
   * front counts. True while held. Android: false (its trip service keeps a trip alive).
   */
  setLocationSession(on: boolean): Promise<boolean>;
  /** Developer: ends the process as the OS would (not a swipe), to try the relaunch paths. */
  simulateSystemKill(): void;
  /**
   * iOS only (undefined on Android and web): relaunched a few hundred metres into a drive with location "Always"
   * (VEHICLE-LINK-SPEC §11). Resolves true while monitoring; on without "Always", it starts once that is granted.
   */
  setDriveWake?(on: boolean): Promise<boolean>;
  driveWakeOn?(): boolean;
  driveWakeFix?(): DriveWakeFix | null;
  /**
   * Android only (foreground service so a trip survives the screen turning off); undefined on iOS and web.
   * `gpsLabel`: the notification's button when Android refuses location from the background (VEHICLE-LINK-SPEC §11).
   */
  startTripService?(title: string, text: string, channelName: string, gpsLabel: string | null): Promise<boolean>;
  stopTripService?(): Promise<void>;
  isTripServiceRunning?(): boolean;
  tripServiceHasLocation?(): boolean;
}

export default requireNativeModule<SensorCaptureNativeModule>("SensorCapture");
