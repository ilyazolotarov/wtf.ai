// What the map draws between the navigator's positions (UI-SPEC §6.2). Positions come twice a second; drawn as they
// came, the dot jumped ~8 m at 60 km/h and the camera eased after it, stopping before each one: a stutter at any frame
// rate. Between updates the shown pose goes on along the heading at the speed, and when one arrives the gap to it closes
// over ~¼ s instead of in a jump. Pure: the hook (use-smoothed-position.ts) runs it every frame.

import type { PositionEstimate } from "@/nav/position/types";

/** Below this the dot is drawn where it is: standing, crawling, walking. */
export const SMOOTH_MIN_SPEED_MPS = 2;
/** The pose goes on at most this long after the last position (the navigator stalled, the app in the background). */
const MAX_AHEAD_MS = 1_000;
/** The gap to a new position closes with this time constant. */
const CATCH_UP_MS = 250;
/** Further than this from where it was shown, the position snapped (a placing, GNSS back): shown at once. */
const SNAP_M = 80;
/** A heading that turned more than this between two positions is shown at once. */
const SNAP_TURN_RAD = Math.PI / 2;

const M_PER_DEG_LAT = 111_320;

export interface Pose {
  lat: number;
  lon: number;
  headingRad?: number;
}

/** Whether a position is smoothed: moving, with a heading, and not one the driver set. */
export function smoothable(p: PositionEstimate | null): p is PositionEstimate & { headingRad: number; speedMps: number } {
  return p != null && p.headingRad != null && (p.speedMps ?? 0) >= SMOOTH_MIN_SPEED_MPS && p.source !== "manual";
}

const wrapRad = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class PoseSmoother {
  private base: (PositionEstimate & { headingRad: number; speedMps: number }) | null = null;
  private baseAtMs = 0;
  /** Shown minus position when it arrived, m east / m north / rad; fades out over CATCH_UP_MS. */
  private gap = { e: 0, n: 0, heading: 0 };

  /** A new position at `nowMs` (any monotonic clock, the same one `at` gets). */
  update(position: PositionEstimate | null, nowMs: number): void {
    if (!smoothable(position)) {
      this.base = null;
      this.gap = { e: 0, n: 0, heading: 0 };
      return;
    }
    const shown = this.base ? this.at(nowMs) : null;
    this.gap = { e: 0, n: 0, heading: 0 };
    if (shown) {
      const kx = M_PER_DEG_LAT * Math.cos((position.lat * Math.PI) / 180);
      const e = (shown.lon - position.lon) * kx;
      const n = (shown.lat - position.lat) * M_PER_DEG_LAT;
      const turn = wrapRad((shown.headingRad ?? position.headingRad) - position.headingRad);
      if (Math.hypot(e, n) <= SNAP_M && Math.abs(turn) <= SNAP_TURN_RAD) this.gap = { e, n, heading: turn };
    }
    this.base = position;
    this.baseAtMs = nowMs;
  }

  /** The pose to draw at `nowMs`; null when nothing is smoothed (draw the position as it is). */
  at(nowMs: number): Pose | null {
    const p = this.base;
    if (!p) return null;
    const sinceMs = Math.max(0, nowMs - this.baseAtMs);
    const aheadM = (p.speedMps * Math.min(sinceMs, MAX_AHEAD_MS)) / 1000;
    const fade = Math.exp(-sinceMs / CATCH_UP_MS);
    const kx = M_PER_DEG_LAT * Math.cos((p.lat * Math.PI) / 180);
    const e = aheadM * Math.sin(p.headingRad) + this.gap.e * fade;
    const n = aheadM * Math.cos(p.headingRad) + this.gap.n * fade;
    return {
      lat: p.lat + n / M_PER_DEG_LAT,
      lon: p.lon + e / kx,
      headingRad: wrapRad(p.headingRad + this.gap.heading * fade),
    };
  }
}
