import { useEffect, useReducer, useRef, useState } from "react";

import type { RouteSnapshot } from "@/services/navigation/route-service";

import { cameraReducer, INITIAL_CAMERA, type CameraMode } from "./camera-policy";
import { COURSE_MIN_SPEED_MPS } from "./use-compass-heading";

export type { CameraMode } from "./camera-policy";

/** Moving this long on a trip counts as driving (UI-SPEC §6.2). */
const DRIVE_OFF_MS = 2000;

/**
 * The map camera's mode (UI-SPEC §6.2; the rules in `camera-policy.ts`): heading-up while driving, back to it by
 * itself after an overview or a look around, and the overview of a new route's alternatives while the car stands.
 *
 * `onGesture`: the driver moved the map. `toggleCameraMode`: the camera button. `setCameraMode`: the screen's own
 * change (placing the car, the tour), which doesn't change the view the trip drives in.
 */
export function useCameraMode({
  recording,
  onTrip,
  speedMps,
  route,
  log,
}: {
  recording: boolean;
  /** Recording, or the linger after engine off: still the same drive for the camera. */
  onTrip: boolean;
  speedMps: number | undefined;
  route: RouteSnapshot | null;
  /** Into the trip log: the camera's changes by itself (the map surface logs every mode). */
  log?(text: string): void;
}) {
  const [camera, dispatch] = useReducer(cameraReducer, INITIAL_CAMERA);
  const driving = recording && (speedMps ?? 0) > COURSE_MIN_SPEED_MPS;
  const shown = useRef(camera);
  useEffect(() => {
    const was = shown.current;
    shown.current = camera;
    if (camera.by !== "driving" || was.mode === camera.mode) return;
    const why = was.mode !== "free" ? "driving off" : was.freeBy === "app" ? "driving, after the app's view" : "driving, the map left alone";
    log?.(`camera ${camera.mode} by itself: ${why}`);
    // Only on a change of mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera.mode]);

  // Driving: after DRIVE_OFF_MS of moving on a trip, and every second after, the policy may bring the driving view back.
  useEffect(() => {
    if (!driving) return;
    let interval: ReturnType<typeof setInterval> | undefined;
    const tick = () => dispatch({ type: "driving", nowMs: Date.now() });
    const timer = setTimeout(() => {
      tick();
      interval = setInterval(tick, 1000);
    }, DRIVE_OFF_MS);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [driving]);
  useEffect(() => {
    if (!onTrip) dispatch({ type: "tripEnded" });
  }, [onTrip]);

  const setCameraMode = (mode: CameraMode) => dispatch({ type: "set", mode });
  const onGesture = () => dispatch({ type: "gesture", nowMs: Date.now() });
  const toggleCameraMode = () => dispatch({ type: "button", onTrip });

  // Alternatives for a new route while the car stands: the map shows them all once (ROUTING-SPEC §8.7); driving off
  // or the button goes back to following. Moving, the camera is left alone.
  // (State adjusted during render, not in an effect.)
  const [overview, setOverview] = useState<number | null>(null);
  const [overviewFor, setOverviewFor] = useState<object | null>(null);
  if (route?.alternatives?.length && overviewFor !== route.destination) {
    setOverviewFor(route.destination);
    if ((speedMps ?? 0) <= COURSE_MIN_SPEED_MPS) {
      dispatch({ type: "set", mode: "free" });
      setOverview(route.planId);
    }
  }

  return { cameraMode: camera.mode, setCameraMode, onGesture, toggleCameraMode, overview };
}
