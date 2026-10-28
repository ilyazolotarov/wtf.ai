// Which speed camera the car is warned of, from the cameras on the road ahead (UI-SPEC §6.5): the nearest, once it
// is within 30 s at the speed, held through a moment out of sight and while the road ahead can't be seen, gone once
// passed; one lost for a while and found again is the same warning.

import type { SpeedCamera } from "./cameras";

/** A camera on the road ahead with its limit: its own, else the road's at it. */
export interface CameraInSight {
  camera: SpeedCamera;
  distanceM: number;
  /** The share of the car's positions that have it ahead. */
  share: number;
  limitKph?: number;
}

/** The camera the driver is warned of (`PositionEstimate.cameraAhead`). */
export interface CameraAhead {
  /** Its index in the cameras file, the trip log's name for it. */
  id: number;
  lat: number;
  lon: number;
  distanceM: number;
  /** Its distance when it was first shown: the card's bar runs from there to the camera. */
  fromM: number;
  /** At the camera, km/h: its own, else the road's there; absent: none known. */
  limitKph?: number;
  /** On the Interior Ministry's list. */
  listed: boolean;
}

/** Shown 30 s ahead at the speed, at least 250 m and at most 900 m. */
const WARN_S = 30;
const WARN_MIN_M = 250;
const WARN_MAX_M = 900;
export const warnDistanceM = (speedMps?: number) => Math.min(WARN_MAX_M, Math.max(WARN_MIN_M, (speedMps ?? 0) * WARN_S));
/** How far the road ahead is looked along: the farthest a camera is shown, and a little more. */
export const LOOK_AHEAD_M = WARN_MAX_M + 100;
/** A camera ahead on roads holding less of the belief isn't the car's (a parallel road, a hypothesis passing by). */
const MIN_SHARE = 0.4;
/** In sight this long before the card shows: a hypothesis passing by doesn't flash one. */
const SHOW_AFTER_MS = 1000;
/** Out of sight this long while moving, the card goes. */
const KEEP_MS = 3000;
/**
 * The road ahead not looked along (no road position to look from: GNSS gives no course under 11 km/h, a queue creeping
 * to a light before the camera) holds the card this long: it isn't out of sight, just unseen.
 */
const BLIND_KEEP_MS = 60_000;
/** A camera gone out of sight (not passed) and back within this is the same warning: at once, its bar where it was. */
const LOST_FOR_MS = 60_000;
/** Out of sight this close while moving (the distance run on at the speed), the camera was passed. */
const PASSED_M = 60;
/** A passed camera isn't shown again this soon (the dot settling back a little after it). */
const PASSED_FOR_MS = 120_000;
/** Another camera takes the card only this much nearer. */
const NEARER_M = 50;
/** Below this the car stands: a camera out of sight stays (at a stop the road ahead may not be known). */
const MOVING_MPS = 1;

export class CameraAlert {
  private shown: (CameraAhead & { seenMs: number; atMs: number }) | null = null;
  private pending: { id: number; sinceMs: number } | null = null;
  private readonly passed = new Map<number, number>();
  /** Cameras gone out of sight, not passed: when, and where their bar started. */
  private readonly lost = new Map<number, { atMs: number; fromM: number }>();
  /** Since when the road ahead hasn't been looked along. */
  private blindSinceMs: number | null = null;
  /** The camera the last update took off the card: passed, or out of sight farther away. */
  ended: { id: number; passed: boolean; distanceM: number } | null = null;

  /**
   * `looked`: the road ahead was looked along (there was a road position to look from); false, `sightings` is empty
   * for want of one, not because the camera is behind.
   */
  update(sightings: readonly CameraInSight[], speedMps: number | undefined, nowMs: number, looked = true): CameraAhead | null {
    this.ended = null;
    for (const [id, at] of this.passed) if (nowMs - at > PASSED_FOR_MS) this.passed.delete(id);
    for (const [id, l] of this.lost) if (nowMs - l.atMs > LOST_FOR_MS) this.lost.delete(id);
    const usable = sightings.filter((s) => s.share >= MIN_SHARE && !this.passed.has(s.camera.id));
    const moving = (speedMps ?? 0) >= MOVING_MPS;
    this.blindSinceMs = looked ? null : (this.blindSinceMs ?? nowMs);

    const shown = this.shown;
    if (shown) {
      const s = usable.find((x) => x.camera.id === shown.id);
      if (s) {
        shown.distanceM = s.distanceM;
        shown.limitKph = s.limitKph ?? shown.limitKph;
        shown.seenMs = nowMs;
      } else {
        shown.distanceM = Math.max(0, shown.distanceM - ((speedMps ?? 0) * (nowMs - shown.atMs)) / 1000);
        if (this.blindSinceMs !== null) {
          // Unseen, not out of sight: held a while, never passed meanwhile.
          if (nowMs - this.blindSinceMs > BLIND_KEEP_MS) this.end(nowMs);
        } else if (!moving) {
          // Standing (at a light just before it), the camera isn't passed.
          shown.seenMs = nowMs;
        } else if (shown.distanceM <= PASSED_M || nowMs - shown.seenMs > KEEP_MS) this.end(nowMs);
      }
      if (this.shown) this.shown.atMs = nowMs;
    }

    const limit = warnDistanceM(speedMps);
    const next = usable.find((s) => s.distanceM <= limit);
    const takes = next && (!this.shown || (next.camera.id !== this.shown.id && next.distanceM < this.shown.distanceM - NEARER_M));
    const back = takes ? this.lost.get(next.camera.id) : undefined;
    if (!takes) this.pending = null;
    else if (back) this.show(next, nowMs, back.fromM);
    else if (this.pending?.id !== next.camera.id) this.pending = { id: next.camera.id, sinceMs: nowMs };
    else if (nowMs - this.pending.sinceMs >= SHOW_AFTER_MS) this.show(next, nowMs);
    if (!this.shown) return null;
    const { seenMs: _s, atMs: _a, ...ahead } = this.shown;
    return ahead;
  }

  reset(): void {
    this.shown = null;
    this.pending = null;
    this.passed.clear();
    this.lost.clear();
    this.blindSinceMs = null;
    this.ended = null;
  }

  private show(next: CameraInSight, nowMs: number, fromM?: number): void {
    const c = next.camera;
    this.shown = {
      id: c.id,
      lat: c.lat,
      lon: c.lon,
      distanceM: next.distanceM,
      fromM: Math.max(fromM ?? next.distanceM, next.distanceM, 1),
      ...(next.limitKph !== undefined ? { limitKph: next.limitKph } : {}),
      listed: c.listed,
      seenMs: nowMs,
      atMs: nowMs,
    };
    this.pending = null;
    this.lost.delete(c.id);
  }

  private end(nowMs: number): void {
    const s = this.shown!;
    const passed = s.distanceM <= PASSED_M && this.blindSinceMs === null;
    if (passed) this.passed.set(s.id, nowMs);
    else this.lost.set(s.id, { atMs: nowMs, fromM: s.fromM });
    this.ended = { id: s.id, passed, distanceM: Math.round(s.distanceM) };
    this.shown = null;
  }
}
