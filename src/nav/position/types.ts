import type { MapMatchState } from "../mapmatch/particle-filter";

export type TrustState = "TRUSTED" | "UNTRUSTED" | "REACQUIRING" | "NO_FIX";

export type PositionSourceKind = "gnss" | "fused" | "dr" | "manual";

export interface RawGnssFix {
  lat: number;
  lon: number;
  accuracyM: number;
  timestamp: number;
}

export interface PositionEstimate {
  lat: number;
  lon: number;
  headingRad?: number;
  speedMps?: number;
  accuracyM: number;
  source: PositionSourceKind;
  trust: TrustState;
  timestamp: number;
  lastTrustedFixAt?: number;
  distanceSinceTrustedM?: number;
  rawGnss?: RawGnssFix;
  /** Map matching (MAPMATCH-SPEC §6.2); absent without a road graph. */
  mapMatch?: MapMatchState;
  /** Other roads the car may be on while map matching is ambiguous, heaviest first. */
  alternatives?: { lat: number; lon: number; weight: number }[];
}
