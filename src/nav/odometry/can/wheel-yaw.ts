// Yaw rate from the rear wheels' speed difference (SPEC §2.1 Stage 2): the car's own turning, whatever the phone in
// it does. The rear wheels aren't steered, so the difference of their speeds over the track is the yaw rate.
import type { CanSpeedSample } from "./can-speed";

/**
 * Rear track, m, until it is calibrated per car: against the phone gyro, 4 drives of one car (2026-10-12) gave
 * 1.60-1.63 m (its spec sheet: 1.595 m).
 */
export const DEFAULT_TRACK_M = 1.6;

export interface WheelYawSample {
  tUs: number;
  /** rad/s, counter-clockwise seen from above (left turn) positive, as the phone's `yawRate`. */
  radps: number;
}

/** In reverse the wheel speeds stay unsigned, so the difference turns the other way. */
export function wheelYawSamples(speeds: CanSpeedSample[], trackM = DEFAULT_TRACK_M): WheelYawSample[] {
  return speeds.map((s) => {
    const yaw = (s.wheelsMps[3] - s.wheelsMps[2]) / trackM;
    return { tUs: s.tUs, radps: s.reverse ? -yaw : yaw };
  });
}
