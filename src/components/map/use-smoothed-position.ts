import { useEffect, useRef, useState } from "react";

import type { PositionEstimate } from "@/nav/position/types";

import { PoseSmoother, smoothable, type Pose } from "./pose-smoother";

/** Redraws per second while moving: smooth to the eye, and light on the JS thread and MapLibre's sources. */
const FRAME_MS = 1000 / 30;
/** A drawn pose older than this (by its position's time) is from before a stop: not shown. */
const STALE_FRAME_MS = 1_500;

/**
 * The position as the map draws it (pose-smoother.ts): while moving, its lat/lon and heading go on smoothly between the
 * navigator's updates, ~30 times a second; everything else is the latest position's. Standing, the position itself.
 */
export function useSmoothedPosition(position: PositionEstimate | null): PositionEstimate | null {
  const smoother = useRef<PoseSmoother | null>(null);
  const [frame, setFrame] = useState<{ of: PositionEstimate; pose: Pose } | null>(null);

  useEffect(() => {
    smoother.current ??= new PoseSmoother();
    const s = smoother.current;
    s.update(position, performance.now());
    if (!smoothable(position)) return;
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
  }, [position]);

  // Until the new position's first frame (≤ 1 frame), the last pose drawn: showing the position itself for that
  // frame was a jump back and forth. Not one from an earlier drive.
  if (!frame || !smoothable(position) || Math.abs(position.timestamp - frame.of.timestamp) > STALE_FRAME_MS) return position;
  return { ...position, ...frame.pose };
}
