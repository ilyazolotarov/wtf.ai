// The pose saved while driving (NAVIGATOR-SPEC §6.1, the parked pose with a speed): when the app dies mid-drive (iOS,
// a crash, the driver swiping it away) and is opened again within a couple of minutes, the navigator carries on from
// it instead of a Wi-Fi/cell fix kilometres wide. Nothing ran in between, so the pose is carried on along its heading
// at its speed for the time the app was off, and its circle and heading widened for what that can't know: braking,
// turns.

import { destinationAtBearing } from "./geo";
import type { ParkedPose } from "./navigator";

/**
 * Older than this, a start doesn't use it: carried on 2 min at 100 km/h it is ±1 km, no better than the Wi-Fi/cell
 * fix. A driver who sees the app gone opens it again in under a minute (2026-10-21: 33 s and 9 s).
 */
export const DRIVE_POSE_MAX_AGE_S = 120;
/** 1σ of the distance carried on, as a share of it: the car may have braked, stopped or turned meanwhile. */
const CARRIED_SIGMA_SHARE = 0.3;
/** Heading σ grows this much per second off (a turn the app didn't see), up to `MAX_HEADING_SIGMA_RAD`. */
const HEADING_SIGMA_RAD_PER_S = Math.PI / 180;
const MAX_HEADING_SIGMA_RAD = Math.PI / 4;

/** Where the car is likely `gapS` seconds after the pose was saved; null when too old (or the clock went back). */
export function carryDrivePose(pose: ParkedPose & { speedMps: number }, gapS: number): (ParkedPose & { carriedM: number }) | null {
  if (!(gapS >= 0) || gapS > DRIVE_POSE_MAX_AGE_S) return null;
  const carriedM = pose.speedMps * gapS;
  const at = destinationAtBearing(pose, pose.headingRad, carriedM);
  return {
    lat: at.lat,
    lon: at.lon,
    headingRad: pose.headingRad,
    posSigmaM: Math.hypot(pose.posSigmaM, CARRIED_SIGMA_SHARE * carriedM),
    headingSigmaRad: Math.min(MAX_HEADING_SIGMA_RAD, Math.hypot(pose.headingSigmaRad, HEADING_SIGMA_RAD_PER_S * gapS)),
    carriedM,
  };
}
