// OBD speed thinned to a lower poll rate, for replay experiments (`--obd-hz`): what a poller capped at that rate
// would have read (VEHICLE-LINK-SPEC §10.2, §16.2).

import type { TripLog } from "../../src/triplog/trip-log-reader";

/** Each sample kept at least 1/hz after the one kept before (5 % slack for poll jitter). */
export function thinObd(trip: TripLog, hz: number): TripLog {
  const gapUs = 1e6 / hz;
  let lastUs = -Infinity;
  const obdSpeed = trip.obdSpeed.filter((s) => {
    if (s.tUs - lastUs < gapUs * 0.95) return false;
    lastUs = s.tUs;
    return true;
  });
  return { ...trip, obdSpeed };
}
