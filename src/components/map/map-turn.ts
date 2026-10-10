import { useEffect, useState } from "react";

import { getRuntime } from "@/services/runtime";

/**
 * How the phone is held, as the turn (clockwise, degrees) that brings the map's top to the physical top: 0 upright,
 * 90 with the screen's right side up (the phone turned left, landscape), -90 with its left side up, 180 upside down.
 * The app stays portrait (UI-SPEC §4.7); only the map turns, so north-up keeps north up and heading-up keeps the
 * road ahead pointing up for a phone mounted sideways.
 */
export type MapTurn = 0 | 90 | -90 | 180;

/** Beyond 45° by this much before the turn changes: a phone near the diagonal doesn't flip back and forth. */
const HYSTERESIS_DEG = 15;
/** The screen leans back further than this from upright (gravity mostly through the screen): keep the turn. */
const MIN_IN_PLANE = 0.5;
/** A new turn must hold this long: a bump or a hand on the phone doesn't turn the map. */
export const TURN_HOLD_US = 700_000;

/**
 * The turn for gravity in the phone's frame (the iOS convention both platforms deliver, TRIP-LOGGER-SPEC §5.2: x to
 * the screen's right, y to its top, z out of it; any unit). `current` stays while the phone lies flat or is held
 * near a diagonal.
 */
export function turnFor(gravity: readonly [number, number, number], current: MapTurn): MapTurn {
  const [gx, gy, gz] = gravity;
  // Physical up, in the screen's plane.
  const ux = -gx;
  const uy = -gy;
  const inPlane = Math.hypot(ux, uy);
  if (inPlane < MIN_IN_PLANE * Math.hypot(gx, gy, gz)) return current;
  const angle = (Math.atan2(ux, uy) * 180) / Math.PI;
  const off = Math.abs((((angle - current) % 360) + 540) % 360 - 180);
  if (off <= 45 + HYSTERESIS_DEG) return current;
  const quadrant = Math.round(angle / 90) * 90;
  return (quadrant === -180 ? 180 : quadrant) as MapTurn;
}

/**
 * The map's turn for how the phone is held now, from the IMU's gravity (it runs while the map is on screen: the
 * navigator's capture). `enabled` false: always 0.
 */
export function useMapTurn(enabled: boolean): MapTurn {
  const [turn, setTurn] = useState<MapTurn>(0);

  useEffect(() => {
    if (!enabled) return;
    let shown: MapTurn = 0;
    let candidate: MapTurn = 0;
    let since = 0;
    return getRuntime().sensors.imu.on(({ motion }) => {
      for (const m of motion) {
        const next = turnFor(m.gravity, shown);
        if (next === shown) {
          candidate = shown;
          continue;
        }
        if (next !== candidate) {
          candidate = next;
          since = m.timestampUs;
        } else if (m.timestampUs - since >= TURN_HOLD_US) {
          shown = next;
          setTurn(next);
        }
      }
    });
  }, [enabled]);

  return enabled ? turn : 0;
}
