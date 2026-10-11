import { useEffect, useRef, useState } from "react";

import type { RouteSnapshot } from "@/services/navigation/route-service";

import { COURSE_MIN_SPEED_MPS } from "./use-compass-heading";

export type CameraMode = "follow" | "follow-heading" | "free";

/** Driving this long on a trip turns follow into heading-up (UI-SPEC §6.2). */
const AUTO_HEADING_UP_MS = 2000;

/**
 * The map camera's mode (UI-SPEC §6.2) and its own turns: heading-up once per trip as the car drives off, and the
 * overview of a new route's alternatives while the car stands.
 *
 * `pickCameraMode` is the driver's (or the screen's) choice: a follow mode picked ends the trip's auto heading-up.
 * `setCameraMode` leaves it armed.
 */
export function useCameraMode({
  recording,
  onTrip,
  speedMps,
  route,
}: {
  recording: boolean;
  /** Recording, or the linger after engine off: still the same drive for the camera. */
  onTrip: boolean;
  speedMps: number | undefined;
  route: RouteSnapshot | null;
}) {
  const [cameraMode, setCameraMode] = useState<CameraMode>("follow");

  // Once per trip: heading-up when the car first drives off, and back to follow when the trip ends unless the
  // driver has picked a follow mode since. Driving off in free (the map panned, a route's overview), the map stays
  // free: the button brings heading-up.
  const autoHeadingUp = useRef<"armed" | "on" | "done">("armed");
  const driving = recording && (speedMps ?? 0) > COURSE_MIN_SPEED_MPS;
  useEffect(() => {
    if (!driving || autoHeadingUp.current !== "armed") return;
    const timer = setTimeout(() => {
      if (cameraMode !== "follow") {
        autoHeadingUp.current = "done";
        return;
      }
      autoHeadingUp.current = "on";
      setCameraMode("follow-heading");
    }, AUTO_HEADING_UP_MS);
    return () => clearTimeout(timer);
  }, [driving, cameraMode]);
  useEffect(() => {
    if (onTrip) return;
    if (autoHeadingUp.current === "on") {
      setCameraMode((mode) => (mode === "follow-heading" ? "follow" : mode));
    }
    autoHeadingUp.current = "armed";
  }, [onTrip]);
  /** The driver's (or the screen's) choice. Picking a follow mode ends the trip's auto heading-up; free doesn't. */
  const pickCameraMode = (next: (mode: CameraMode) => CameraMode) => {
    const picked = next(cameraMode);
    if (picked !== "free" && autoHeadingUp.current === "on") autoHeadingUp.current = "done";
    setCameraMode(picked);
  };
  /**
   * The camera button: from free always heading-up first (the driver's choice, 2026-10-11: back to north-up read
   * as "heading-up points north"), then between heading-up and follow.
   */
  const toggleCameraMode = () => pickCameraMode((mode) => (mode === "follow-heading" ? "follow" : "follow-heading"));

  // Alternatives for a new route while the car stands: the map shows them all once (ROUTING-SPEC §8.7); the
  // recentre button goes back to following. Moving, the camera is left alone.
  // (State adjusted during render, not in an effect.)
  const [overview, setOverview] = useState<number | null>(null);
  const [overviewFor, setOverviewFor] = useState<object | null>(null);
  if (route?.alternatives?.length && overviewFor !== route.destination) {
    setOverviewFor(route.destination);
    if ((speedMps ?? 0) <= COURSE_MIN_SPEED_MPS) {
      setCameraMode("free");
      setOverview(route.planId);
    }
  }

  return { cameraMode, setCameraMode, pickCameraMode, toggleCameraMode, overview };
}
