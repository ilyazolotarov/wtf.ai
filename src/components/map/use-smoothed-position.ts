import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import type { PositionEstimate } from "@/nav/position/types";

import { PoseSmoother, smoothable, type Pose } from "./pose-smoother";

/** Redraws per second while moving: smooth to the eye, and light on the JS thread and MapLibre's sources. */
const FRAME_MS = 1000 / 30;
/** Display frames come a hair early or late: two 60 Hz frames are 33.3 ms ± jitter. Without the slack, one a hair
 * early waited a third frame (50 ms), and the dot and camera stepped 33/50 ms unevenly: visible jitter. A timer due
 * this much sooner fires on the second frame. */
const FRAME_SLACK_MS = 4;
/** A drawn pose older than this (by its position's time) is from before a stop: not shown. */
const STALE_FRAME_MS = 1_500;

const subscribeAppState = (onChange: () => void) => {
  const subscription = AppState.addEventListener("change", onChange);
  return () => subscription.remove();
};
const appActive = () => AppState.currentState === "active";

/**
 * The position as the map draws it (pose-smoother.ts): while moving, its lat/lon and heading go on smoothly between the
 * navigator's updates, ~30 times a second; everything else is the latest position's. Standing, the position itself.
 * Only while the app is on screen. Paced by a timer of a frame's length, not requestAnimationFrame: React Native's is a
 * setTimeout(0), paced by the phone's display only while the phone shows the app. Otherwise it fires at once, and the
 * loop spun the JS thread flat out until iOS killed the app for its CPU use (80 % over 60 s), mid-drive, whenever the
 * driver switched to another app (2026-10-16). The car's map draws in just that state (CARPLAY-SPEC §4, JS timers).
 * `onScreen`: the map's own screen says (the car's, which shows while the phone's app is in the background).
 */
export function useSmoothedPosition(position: PositionEstimate | null, onScreen?: boolean): PositionEstimate | null {
  const smoother = useRef<PoseSmoother | null>(null);
  const [frame, setFrame] = useState<{ of: PositionEstimate; pose: Pose } | null>(null);
  const appInFront = useSyncExternalStore(subscribeAppState, appActive, appActive);
  const active = onScreen ?? appInFront;

  useEffect(() => {
    smoother.current ??= new PoseSmoother();
    const s = smoother.current;
    s.update(position, performance.now());
    if (!active || !smoothable(position)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      timer = setTimeout(tick, FRAME_MS - FRAME_SLACK_MS);
      const pose = s.at(performance.now());
      if (pose) setFrame({ of: position, pose });
    };
    timer = setTimeout(tick, 0);
    return () => clearTimeout(timer);
  }, [position, active]);

  // Until the new position's first frame (≤ 1 frame), the last pose drawn: showing the position itself for that
  // frame was a jump back and forth. Not one from an earlier drive.
  if (!frame || !smoothable(position) || Math.abs(position.timestamp - frame.of.timestamp) > STALE_FRAME_MS) return position;
  return { ...position, ...frame.pose };
}
