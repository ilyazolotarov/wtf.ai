import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import type { PositionEstimate } from "@/nav/position/types";

import { PoseSmoother, smoothable, type Pose } from "./pose-smoother";

/** Redraws per second while moving: smooth to the eye, and light on the JS thread and MapLibre's sources. */
const FRAME_MS = 1000 / 30;
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
 * Only while the app is on screen: React Native's requestAnimationFrame is a setTimeout(0), paced by the display only in
 * the foreground; in the background the loop spun the JS thread flat out and iOS killed the app for its CPU use
 * (80 % over 60 s), mid-drive, whenever the driver switched to another app (2026-10-16).
 */
export function useSmoothedPosition(position: PositionEstimate | null): PositionEstimate | null {
  const smoother = useRef<PoseSmoother | null>(null);
  const [frame, setFrame] = useState<{ of: PositionEstimate; pose: Pose } | null>(null);
  const active = useSyncExternalStore(subscribeAppState, appActive, appActive);

  useEffect(() => {
    smoother.current ??= new PoseSmoother();
    const s = smoother.current;
    s.update(position, performance.now());
    if (!active || !smoothable(position)) return;
    let raf = 0;
    let drawnAt = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - drawnAt < FRAME_MS) return;
      drawnAt = now;
      const pose = s.at(performance.now());
      if (pose) setFrame({ of: position, pose });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [position, active]);

  // Until the new position's first frame (≤ 1 frame), the last pose drawn: showing the position itself for that
  // frame was a jump back and forth. Not one from an earlier drive.
  if (!frame || !smoothable(position) || Math.abs(position.timestamp - frame.of.timestamp) > STALE_FRAME_MS) return position;
  return { ...position, ...frame.pose };
}
