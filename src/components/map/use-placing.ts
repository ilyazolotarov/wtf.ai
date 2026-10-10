import { useEffect, useEffectEvent, useRef, useState } from "react";

import { bearingRad, haversineM, type Coordinate } from "@/nav/geo";
import type { PositionEstimate } from "@/nav/position/types";
import type { NavigatorService } from "@/services/navigation/navigator-service";
import { onPlacingRequest, STANDING_MPS, takePlacingRequest } from "@/services/navigation/place-request";

import type { CameraMode } from "./use-camera-mode";

export type PlacingStep = "position" | "heading";

/** Offer putting the car on the map when the position is rougher than this (or has no direction), without GPS. */
const PLACE_OFFER_ACCURACY_M = 75;
/**
 * …and when nothing has vouched for the dot in this far of dead reckoning. `accuracyM` alone is not enough:
 * the filter reports its own spread, which stays a few metres however wrong the dot is. On 2026-10-06 the car
 * stood at a filling station 10 km from the dot for 12 min at ±5 m, so the chip was never offered — the one
 * control that could have fixed it was hidden by the number that was broken.
 */
const PLACE_OFFER_DISTANCE_M = 5000;
/** The confirmed placing stays drawn until the dot is this far from it (the car drove off). */
const PLACED_SHOWN_M = 50;

/**
 * Lost enough to offer putting the car on the map: no GPS, and nothing vouching for the dot — rough, no direction,
 * off any road, or a long way on dead reckoning. A confident filter on the wrong road looks like none of the first
 * three.
 */
export function isLost(position: PositionEstimate | null): boolean {
  return (
    position != null &&
    position.trust !== "TRUSTED" &&
    (position.accuracyM > PLACE_OFFER_ACCURACY_M ||
      position.headingRad == null ||
      position.mapMatch === "offroad" ||
      (position.distanceSinceTrustedM ?? 0) > PLACE_OFFER_DISTANCE_M)
  );
}

/**
 * Putting the car on the map (NAVIGATOR-SPEC §6.2): where it stands, then which way it faces. Only while it stands;
 * moving off cancels. The confirmed placing stays on the map until the car has driven away from it.
 */
export function usePlacing({
  position,
  navigator,
  pickCameraMode,
  setCameraMode,
  onStart,
}: {
  position: PositionEstimate | null;
  navigator: NavigatorService;
  pickCameraMode(next: (mode: CameraMode) => CameraMode): void;
  setCameraMode(mode: CameraMode): void;
  /** A placing starts: whatever else the map was showing (a dropped pin) gives way. */
  onStart(): void;
}) {
  const [step, setStep] = useState<PlacingStep | null>(null);
  const [placeAt, setPlaceAt] = useState<Coordinate | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const [placed, setPlaced] = useState<{ at: Coordinate; headingRad: number | null } | null>(null);
  if (placed && position && haversineM(position, placed.at) > PLACED_SHOWN_M) setPlaced(null);
  const center = useRef<Coordinate | null>(null);
  const [placeFrom, setPlaceFrom] = useState<Coordinate | null>(null);
  const standing = position != null && (position.speedMps ?? 0) < STANDING_MPS;
  // The driver may say where the car is from a pin or a search result whenever it isn't moving, also before any
  // fix at all (indoors, jammed): the manual position is shown without one (NAVIGATOR-SPEC §6.3).
  const mayPlace = position == null || standing;

  // From the dot, or from where the driver says the car is (a dropped pin, a search result).
  const start = (at?: Coordinate) => {
    const from = at ?? (position ? { lat: position.lat, lon: position.lon } : null);
    onStart();
    center.current = from;
    setPlaceFrom(from);
    setPlaceAt(null);
    setHeading(null);
    setPlaced(null);
    setStep("position");
    pickCameraMode(() => "free");
  };
  const stop = () => {
    setStep(null);
    setPlaceAt(null);
    setHeading(null);
    pickCameraMode(() => "follow");
  };
  const placeHere = () => {
    const at = center.current;
    if (!at) return;
    setPlaceAt(at);
    setStep("heading");
  };
  // A tap aims the arrow (again and again); Confirm applies it, only once there is a heading.
  const aim = (towards: Coordinate) => {
    if (placeAt) setHeading(bearingRad(placeAt, towards));
  };
  const finish = () => {
    if (!placeAt || heading === null) return;
    navigator.setUserPosition(placeAt, heading);
    setPlaced({ at: placeAt, headingRad: heading });
    stop();
  };
  // Forgetting the manual position (✕, or "no" to "still here?") also takes the placing's mark off the map.
  const forgetManual = (notHere = false) => {
    if (notHere) navigator.answerManual(false);
    else navigator.discardManualPosition();
    setPlaced(null);
  };

  // "I'm here" on a search result (route screen): placing starts there.
  const takeRequest = useEffectEvent(() => {
    const at = takePlacingRequest();
    if (at && mayPlace) start(at);
  });
  // The map stays mounted under the route sheet, so the request always comes while subscribed.
  useEffect(() => onPlacingRequest(() => takeRequest()), []);
  // Moving off cancels (state adjusted during render, not in an effect).
  if (step && !mayPlace) {
    setStep(null);
    setPlaceAt(null);
    setHeading(null);
    setCameraMode("follow");
  }

  const mark =
    step === "heading" && placeAt
      ? { at: placeAt, headingRad: heading, draft: true }
      : placed && !step
        ? { ...placed, draft: false }
        : null;

  return {
    step,
    /** Where the "position" step zooms in. */
    placeFrom,
    hasHeading: heading !== null,
    /** The placing drawn on the map: the draft while aiming, then the confirmed one. */
    mark,
    standing,
    mayPlace,
    /** The map centre as it settles: the "position" step's pin. */
    setCenter: (at: Coordinate) => {
      center.current = at;
    },
    start,
    stop,
    placeHere,
    aim,
    finish,
    forgetManual,
  };
}
