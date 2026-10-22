import { NativeModule, requireOptionalNativeModule } from "expo";

// Typed binding for modules/position-share: the car's position for other navigators (docs/ANDROID-SPEC.md §8).
// Android only.

/** What sharing needs from the phone, checked now. */
export interface ShareSetup {
  /** Developer options are on. */
  developerOptions: boolean;
  /** wtf.ai is the app chosen in Developer options → "Select mock location app". */
  mockLocationApp: boolean;
  /** Google Play services: the fused location provider the other navigators read. */
  playServices: boolean;
  /** Package names of the navigators installed (Waze, Google Maps). */
  navigators: string[];
}

/** One fix for the other apps; SI units, the course in radians clockwise from north. */
export interface SharedFixPayload {
  lat: number;
  lon: number;
  /** The 68 % radius, as Android's `Location.accuracy` is. */
  accuracyM: number;
  speedMps?: number;
  courseRad?: number;
  courseAccRad?: number;
}

/** The fused provider's last location, as other apps get it. */
export interface ReadBack {
  lat: number;
  lon: number;
  accuracyM: number;
  /** Marked as a mock location (one wtf.ai set). */
  mock: boolean;
  ageMs: number;
}

export type PositionShareEvents = {
  /** Sharing failed after it started (e.g. wtf.ai is no longer the mock location app). */
  onShareError: (e: { code: string; message: string }) => void;
};

declare class PositionShareNativeModule extends NativeModule<PositionShareEvents> {
  getSetup(): ShareSetup;
  /** Mock mode on. Rejects with `no-play-services`, `not-mock-app` or `start-failed`. */
  start(): Promise<void>;
  /** False when not sharing, or the fix can't be a position. */
  publish(fix: SharedFixPayload): boolean;
  /**
   * The platform `gps` provider replaced by wtf.ai's fixes (for Waze, which reads it directly), or given back. While
   * replaced, the phone's real GPS stops for wtf.ai too. Null when done, else why it couldn't. Absent in older builds.
   */
  setGpsTakeover?(on: boolean): string | null;
  /** Mock mode off: the other apps get the phone's own location again. */
  stop(): Promise<void>;
  readBack(): Promise<ReadBack | null>;
  /** Opens Waze or Google Maps; false when it isn't installed. */
  openApp(packageName: string): boolean;
}

/** Null on iOS and web, and in Android builds from before the module. */
export default requireOptionalNativeModule<PositionShareNativeModule>("PositionShare");
