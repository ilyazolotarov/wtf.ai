// The map camera's mode and when it changes by itself (UI-SPEC §6.2), as a pure reducer: `useCameraMode` feeds it
// gestures, the button, the screen's own changes and, while the car drives, a tick.
//
// On a trip the map's job is to follow the car. Free is a look around (the driver's) or a view the app opened (a new
// route's alternatives, placing the car): it ends by itself once the car drives (2026-10-11: the alternatives'
// overview stayed on for 28 s of driving, and after a pan the button had to be found while driving).

export type CameraMode = "follow" | "follow-heading" | "free";
export type FollowMode = Exclude<CameraMode, "free">;

/** Driving, a pan or zoom stays this long after the last touch, then the camera follows the car again. */
export const RETURN_AFTER_TOUCH_MS = 10_000;

export interface CameraState {
  mode: CameraMode;
  /** Why the map is free: the driver's gesture, or the app's own view. */
  freeBy: "driver" | "app" | null;
  /** The last gesture, ms. */
  touchMs: number;
  /** The follow mode for driving on this trip: heading-up unless the driver toggles to north-up on it. */
  driving: FollowMode;
  /** The driver toggled between the follow modes on this trip: the mode stays after the trip. */
  picked: boolean;
  /** What changed the mode last. */
  by: CameraEvent["type"] | null;
}

export type CameraEvent =
  /** A pan, zoom or tilt by the driver (repeated while the gesture goes on). */
  | { type: "gesture"; nowMs: number }
  /** The camera button. */
  | { type: "button"; onTrip: boolean }
  /** The screen's own change (an overview, placing the car, the tour): not the driver's choice of view. */
  | { type: "set"; mode: CameraMode }
  /** The car has been driving on a trip for a while; sent every second while it does. */
  | { type: "driving"; nowMs: number }
  | { type: "tripEnded" };

export const INITIAL_CAMERA: CameraState = { mode: "follow", freeBy: null, touchMs: -Infinity, driving: "follow-heading", picked: false, by: null };

export function cameraReducer(s: CameraState, e: CameraEvent): CameraState {
  const next = step(s, e);
  return next.mode !== s.mode ? { ...next, by: e.type } : next;
}

function step(s: CameraState, e: CameraEvent): CameraState {
  switch (e.type) {
    case "gesture":
      return { ...s, mode: "free", freeBy: "driver", touchMs: e.nowMs };
    case "button": {
      // From free always heading-up first (the driver's wish, 2026-10-11); then between heading-up and north-up.
      if (s.mode === "free") return { ...s, mode: "follow-heading", freeBy: null };
      const mode: FollowMode = s.mode === "follow-heading" ? "follow" : "follow-heading";
      return e.onTrip ? { ...s, mode, driving: mode, picked: true } : { ...s, mode };
    }
    case "set":
      return s.mode === e.mode ? s : { ...s, mode: e.mode, freeBy: e.mode === "free" ? "app" : null };
    case "driving": {
      if (s.mode === "free") {
        const back = s.freeBy === "app" || e.nowMs - s.touchMs >= RETURN_AFTER_TOUCH_MS;
        return back ? { ...s, mode: s.driving, freeBy: null } : s;
      }
      return s.mode === s.driving ? s : { ...s, mode: s.driving };
    }
    case "tripEnded": {
      const mode = s.mode === "follow-heading" && !s.picked ? "follow" : s.mode;
      return mode === s.mode && s.driving === "follow-heading" && !s.picked ? s : { ...s, mode, driving: "follow-heading", picked: false };
    }
  }
}
