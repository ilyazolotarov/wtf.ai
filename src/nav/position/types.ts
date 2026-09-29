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
}
