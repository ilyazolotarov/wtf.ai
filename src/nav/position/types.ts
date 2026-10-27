import type { MapMatchState } from "../mapmatch/particle-filter";

export type TrustState = "TRUSTED" | "UNTRUSTED" | "REACQUIRING" | "NO_FIX";

export type PositionSourceKind = "gnss" | "fused" | "dr" | "manual";

export interface RawGnssFix {
  lat: number;
  lon: number;
  accuracyM: number;
  timestamp: number;
}

/** A GNSS outage simulated in the app (test tool): fixes are withheld from the navigator, not from the log. */
export interface SimulatedOutage {
  /** Wall clock, ms. */
  startedAt: number;
  /** Distance driven since GNSS was cut (OBD odometry), m; absent without the navigator. */
  distanceM?: number;
  /** The newest withheld satellite fix (≤ 10 m): where the car really is. */
  gnss?: RawGnssFix;
  /** The dot's distance from that fix now, and the largest so far, m. */
  errorM?: number;
  maxErrorM?: number;
}

export interface PositionEstimate {
  lat: number;
  lon: number;
  headingRad?: number;
  /** How far off the heading may be (the navigator's); absent: as good as its source gives it (a GNSS course). */
  headingSigmaRad?: number;
  speedMps?: number;
  accuracyM: number;
  source: PositionSourceKind;
  trust: TrustState;
  timestamp: number;
  lastTrustedFixAt?: number;
  distanceSinceTrustedM?: number;
  rawGnss?: RawGnssFix;
  /**
   * The phone's last satellite fix, refused or not; never a simulated one (wtf.ai's own, shared with Waze) or a
   * Wi-Fi/cell one. What Waze reads while wtf.ai lets go of the gps provider (position/share.ts).
   */
  satelliteFix?: RawGnssFix;
  /** Map matching (MAPMATCH-SPEC §6.2); absent without a road graph. */
  mapMatch?: MapMatchState;
  /** Standing where it was parked off the roads, started from there: `offroad` is where the car is, not lost. */
  parkedOffRoad?: boolean;
  /** Phone-only mode's dead reckoning (NAVIGATOR-SPEC §9.6), not the navigator's: never shared with other apps. */
  phoneOnly?: boolean;
  /** Driven since the driver put the car on the map (or confirmed the parked pose), m (NAVIGATOR-SPEC §6.2). */
  sinceDriverM?: number;
  /** Other roads the car may be on while map matching is ambiguous, heaviest first. */
  alternatives?: { lat: number; lon: number; weight: number }[];
  simulatedOutage?: SimulatedOutage;
  /**
   * The car started from where it was parked and a Wi-Fi/cell fix puts it elsewhere: ask the driver "is the car
   * here?" (NAVIGATOR-SPEC §6.1). `distanceM`: how far that fix is.
   */
  poseQuestion?: { distanceM: number };
  /**
   * A position the driver set on the map is held (NAVIGATOR-SPEC §6.3): shown instead of the phone's fixes while no
   * car speed comes. Wall clock, ms. `asking`: it is 15 min since it was confirmed, ask "are you still here?".
   */
  manual?: { placedAt: number; confirmedAt: number; asking: boolean };
  /**
   * The car's test drive (ANDROID-AUTO-SPEC §4): a dot driven along the route, published instead of the navigator's.
   * Not where the car is: never shared with other apps.
   */
  testDrive?: boolean;
}
