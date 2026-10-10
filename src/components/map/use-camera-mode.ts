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
 * `pickCameraMode` is the driver's (or the screen's) choice: it ends the trip's auto heading-up. `setCameraMode`
 * leaves it armed.
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

  // Once per trip: follow becomes heading-up when the car first drives off, and goes back
  // to follow when the trip ends unless the driver has picked a mode since.
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
  const pickCameraMode = (next: (mode: CameraMode) => CameraMode) => {
    if (autoHeadingUp.current === "on") autoHeadingUp.current = "done";
    setCameraMode(next);
  };

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

  return { cameraMode, setCameraMode, pickCameraMode, overview };
}
