import * as Location from "expo-location";
import { useEffect, useState } from "react";

import type { PositionEstimate } from "@/nav/position/types";

/**
 * Phone compass heading, for the walking beam on the map only. Never feed it into
 * navigation: in a car the magnetometer is off by 10–30° and shows where the phone
 * points, not the vehicle (SPEC §2).
 */
export interface CompassHeading {
  headingRad: number;
  /** Half-width of the beam: iOS calibration level mapped to its stated uncertainty. */
  uncertaintyRad: number;
}

/** Walking pace and below (~11 km/h): the compass shows where the phone points. */
const COMPASS_MAX_SPEED_MPS = 3;
/** Heading-up from GNSS course only when moving; course is noise below this. */
export const COURSE_MIN_SPEED_MPS = 2;
const MIN_CHANGE_DEG = 2;
const MIN_INTERVAL_MS = 100;
/** iOS accuracy 0–3 → "< 50° / < 35° / < 20°" uncertainty; 0 means worse than 50°. */
const UNCERTAINTY_DEG = [60, 50, 35, 20];

export function useCompassHeading(enabled: boolean): CompassHeading | null {
  const [heading, setHeading] = useState<CompassHeading | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let subscription: Location.LocationSubscription | null = null;
    let lastDeg = NaN;
    let lastAccuracy = -1;
    let lastAt = 0;

    Location.watchHeadingAsync((h) => {
      const deg = h.trueHeading >= 0 ? h.trueHeading : h.magHeading;
      if (!(deg >= 0)) return;
      const now = Date.now();
      const delta = Math.abs(((deg - lastDeg + 540) % 360) - 180);
      if (
        h.accuracy === lastAccuracy &&
        (now - lastAt < MIN_INTERVAL_MS || delta < MIN_CHANGE_DEG)
      ) {
        return;
      }
      lastDeg = deg;
      lastAccuracy = h.accuracy;
      lastAt = now;
      const uncertaintyDeg = UNCERTAINTY_DEG[h.accuracy] ?? UNCERTAINTY_DEG[0];
      setHeading({
        headingRad: (deg * Math.PI) / 180,
        uncertaintyRad: (uncertaintyDeg * Math.PI) / 180,
      });
    })
      .then((sub) => {
        if (cancelled) sub.remove();
        else subscription = sub;
      })
      .catch(() => setHeading(null));

    return () => {
      cancelled = true;
      subscription?.remove();
      setHeading(null);
    };
  }, [enabled]);

  return enabled ? heading : null;
}

/** The compass heading to show, or null when moving faster than walking. */
export function walkingCompass(
  position: PositionEstimate | null | undefined,
  compass: CompassHeading | null,
): CompassHeading | null {
  return compass && position && (position.speedMps ?? 0) < COMPASS_MAX_SPEED_MPS
    ? compass
    : null;
}

/**
 * Direction of travel worth turning the map to, or undefined. The navigator's heading
 * (dr/fused) holds through stops; a GNSS course is noise unless moving.
 */
export function travelHeadingRad(
  position: PositionEstimate | null | undefined,
): number | undefined {
  if (position?.headingRad == null) return undefined;
  if (position.source === "dr" || position.source === "fused") return position.headingRad;
  return (position.speedMps ?? 0) > COURSE_MIN_SPEED_MPS ? position.headingRad : undefined;
}

/** Map bearing for heading-up: walking compass first, then travel heading, else the last one held. */
export function headingUpRad(
  position: PositionEstimate | null | undefined,
  compass: CompassHeading | null,
  heldRad = 0,
): number {
  return compass?.headingRad ?? travelHeadingRad(position) ?? heldRad;
}

/** `headingUpRad` that keeps the last travel heading through a stop instead of snapping north. */
export function useHeadingUp(
  position: PositionEstimate | null | undefined,
  compass: CompassHeading | null,
): number {
  const travel = travelHeadingRad(position);
  const [held, setHeld] = useState(0);
  if (travel !== undefined && travel !== held) setHeld(travel);
  return headingUpRad(position, compass, held);
}
