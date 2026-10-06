// Phone GNSS as a map position: what the map shows without an OBD adapter (the navigator
// needs the car's speed). The fixes come from the native CoreLocation stream shared with the
// trip log (modules/sensor-capture: automotive navigation, never paused by iOS); expo-location's
// watcher used to stall for good, until an app restart, after a jamming episode.

import type { PositionEstimate, TrustState } from "@/nav/position/types";
import type { GnssRecord } from "@/triplog/schema";

const finite = (v: number) => (Number.isFinite(v) ? v : undefined);

/** Satellite fix vs Wi-Fi/cell fallback: only satellite fixes carry a speed (0 when standing). */
export const isSatelliteRecord = (fix: GnssRecord) => Number.isFinite(fix.speedMps) && fix.speedMps >= 0;

/** `lastTrustedFixAt`: integrity's, undefined while no fix has been trusted (never this fix's own time). */
export function mapFixToPosition(fix: GnssRecord, trust: TrustState = "TRUSTED", lastTrustedFixAt?: number): PositionEstimate {
  const speed = finite(fix.speedMps);
  return {
    lat: fix.latDeg,
    lon: fix.lonDeg,
    headingRad: finite(fix.courseRad),
    speedMps: speed !== undefined && speed >= 0 ? speed : undefined,
    accuracyM: finite(fix.hAccM) ?? 9999,
    source: "gnss",
    trust,
    timestamp: fix.utcUs / 1000,
    lastTrustedFixAt,
  };
}
