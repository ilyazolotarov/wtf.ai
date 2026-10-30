import { useEffect, useReducer, useRef, useState } from "react";

import type { RouteSnapshot } from "@/services/navigation/route-service";

import { cameraReducer, INITIAL_CAMERA, OVERVIEW_MIN_M, type CameraMode } from "./camera-policy";
import { COURSE_MIN_SPEED_MPS } from "./use-compass-heading";

export type { CameraMode } from "./camera-policy";

/** Moving this long on a trip counts as driving (UI-SPEC §6.2). */
const DRIVE_OFF_MS = 2000;

/**
 * The map camera's mode (UI-SPEC §6.2; the rules in `camera-policy.ts`): heading-up while driving, back to it by
 * itself after an overview or a look around, and the overview of a new route's alternatives while the car stands,
 * until the route goes.
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
    if ((camera.by !== "driving" && camera.by !== "overviewEnded") || was.mode === camera.mode) return;
    const why =
      camera.by === "overviewEnded"
        ? "the route of its overview went"
        : was.mode !== "free"
          ? "driving off"
          : was.freeBy === "app"
            ? "driving, after the app's view"
            : "driving, the map left alone";
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

  // A new route while the car stands: the map shows it as soon as it is planned, then with its alternatives
  // (ROUTING-SPEC §8.7); driving off, the button or the route going (stopped, arrived) goes back to following. Moving,
  // the camera is left alone.
  // (State adjusted during render, not in an effect.)
  const [overview, setOverview] = useState<number | null>(null);
  const [overviewFor, setOverviewFor] = useState<object | null>(null);
  const [framedWith, setFramedWith] = useState<object | null>(null);
  const framable = route?.plan != null && (route.plan.lengthM >= OVERVIEW_MIN_M || !!route.alternatives?.length);
  if (route && framable && overviewFor !== route.destination) {
    setOverviewFor(route.destination);
    setFramedWith(route.alternatives ?? null);
    if ((speedMps ?? 0) <= COURSE_MIN_SPEED_MPS) {
      dispatch({ type: "overview" });
      setOverview((n) => (n ?? 0) + 1);
    }
  } else if (route?.alternatives?.length && overviewFor === route.destination && framedWith !== route.alternatives) {
    // The alternatives came after the plan was framed: framed again with them, unless the map was moved since.
    setFramedWith(route.alternatives);
    if (camera.overview && camera.freeBy === "app") setOverview((n) => (n ?? 0) + 1);
  }
  if (!route && overviewFor !== null) {
    setOverviewFor(null);
    dispatch({ type: "overviewEnded" });
  }

  return { cameraMode: camera.mode, setCameraMode, onGesture, toggleCameraMode, overview };
}
