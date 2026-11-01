// The dot's position as the map draws it natively (UI-SPEC §6.2): MapLibre shows the app's fused position as its user
// location and eases the dot and the follow camera linearly from one fed pose to the next, over the time between them.
// The feed runs between the navigator's publishes (2–3 Hz) at the navigator's own pace (an IMU batch, ~10 Hz): the
// published dot, which map matching placed and the parity tool checks, moved on by the EKF's displacement since that
// publish, and predicted one feed interval ahead so the ease lands where the car is when it gets there. Standing, the
// dot is fed as published. Pure (`PuckFeed`); `PuckFeeder` wires it to the navigator and the mounted maps.
import type { PositionEstimate } from "@/nav/position/types";

/** Below this the dot is drawn where it is (as pose-smoother.ts: standing, crawling, walking). */
export const FEED_MIN_SPEED_MPS = 2;
/** Further than this from the last fed pose, the position snapped (a placing, GNSS back): placed, not animated. */
export const FEED_SNAP_M = 80;
/** A heading that turned more than this is shown at once. */
const SNAP_TURN_RAD = Math.PI / 2;
/** The estimate's heading takes over from the published one when they differ by more than this (a turn under way). */
const HEADING_TAKES_OVER_RAD = (3 * Math.PI) / 180;
/** The lead (and MapLibre's ease) is the feed interval, within these bounds; iOS caps its ease at a second. */
const LEAD_MIN_MS = 50;
const LEAD_MAX_MS = 1000;
const DEFAULT_INTERVAL_MS = 100;
const M_PER_DEG_LAT = 111_320;

/** The navigator's estimate after an advance (an IMU batch fed): NAVIGATOR-SPEC §9. */
export interface NavAdvance {
  lat: number;
  lon: number;
  headingRad?: number;
  speedMps?: number;
  tUs: number;
}

/** One pose for the map; `courseDeg` NaN: no heading. */
export interface FedPose {
  lat: number;
  lon: number;
  courseDeg: number;
  speedMps: number;
  accuracyM: number;
  leadMs: number;
  /** Placed, not animated from the last pose. */
  snap: boolean;
  /** Without trusted GPS: the doubt colour. */
  doubt: boolean;
}

const wrapRad = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Whether a position moves between publishes: moving, with a heading, and not one the driver set. */
export function fedMoving(p: PositionEstimate): p is PositionEstimate & { headingRad: number; speedMps: number } {
  return p.headingRad != null && (p.speedMps ?? 0) >= FEED_MIN_SPEED_MPS && p.source !== "manual";
}

function offsetM(from: { lat: number; lon: number }, to: { lat: number; lon: number }): { e: number; n: number } {
  const kx = M_PER_DEG_LAT * Math.cos((from.lat * Math.PI) / 180);
  return { e: (to.lon - from.lon) * kx, n: (to.lat - from.lat) * M_PER_DEG_LAT };
}

export class PuckFeed {
  private published: PositionEstimate | null = null;
  /** The advance the published dot is re-based on: displacements count from it. */
  private baseAdvance: NavAdvance | null = null;
  private lastAdvance: NavAdvance | null = null;
  private lastAdvanceAtMs = 0;
  private intervalMs = DEFAULT_INTERVAL_MS;
  private lastFed: FedPose | null = null;
  private lastSource: PositionEstimate["source"] | null = null;

  constructor(private readonly nowMs: () => number) {}

  /** A published position: fed as drawn, and the advances count from here on. */
  publish(p: PositionEstimate | null): FedPose | null {
    this.published = p;
    this.baseAdvance = this.lastAdvance;
    if (!p) {
      this.lastFed = null;
      this.lastSource = null;
      return null;
    }
    const moving = fedMoving(p);
    return this.pose(p, 0, 0, p.headingRad, moving ? this.intervalMs : 0);
  }

  /** The navigator advanced: the published dot moved on by the estimate's displacement since the publish. */
  advance(a: NavAdvance): FedPose | null {
    const now = this.nowMs();
    if (this.lastAdvanceAtMs) {
      const dt = now - this.lastAdvanceAtMs;
      if (dt > 0 && dt < 2 * LEAD_MAX_MS) this.intervalMs = 0.7 * this.intervalMs + 0.3 * dt;
    }
    this.lastAdvanceAtMs = now;
    this.lastAdvance = a;
    const p = this.published;
    const base = this.baseAdvance;
    if (!p || !base || !fedMoving(p)) return null;
    const d = offsetM(base, a);
    const heading =
      a.headingRad !== undefined && Math.abs(wrapRad(a.headingRad - p.headingRad)) > HEADING_TAKES_OVER_RAD ? a.headingRad : p.headingRad;
    return this.pose(p, d.e, d.n, heading, this.intervalMs);
  }

  private pose(p: PositionEstimate, dE: number, dN: number, headingRad: number | undefined, leadMs: number): FedPose {
    const lead = Math.min(LEAD_MAX_MS, Math.max(LEAD_MIN_MS, leadMs));
    const speed = p.speedMps ?? 0;
    // The lead is in the pose, not the time: MapLibre eases to it over the gap between two feeds.
    const ahead = leadMs > 0 && headingRad !== undefined ? (speed * lead) / 1000 : 0;
    const e = dE + ahead * Math.sin(headingRad ?? 0);
    const n = dN + ahead * Math.cos(headingRad ?? 0);
    const kx = M_PER_DEG_LAT * Math.cos((p.lat * Math.PI) / 180);
    const lat = p.lat + n / M_PER_DEG_LAT;
    const lon = p.lon + e / kx;
    const last = this.lastFed;
    const jumped = last ? Math.hypot(...Object.values(offsetM(last, { lat, lon }))) > FEED_SNAP_M : true;
    const turned =
      last && !Number.isNaN(last.courseDeg) && headingRad !== undefined
        ? Math.abs(wrapRad(headingRad - (last.courseDeg * Math.PI) / 180)) > SNAP_TURN_RAD
        : false;
    const snap = jumped || turned || (this.lastSource !== null && (this.lastSource === "manual") !== (p.source === "manual"));
    const fed: FedPose = {
      lat,
      lon,
      courseDeg: headingRad === undefined ? NaN : (((headingRad * 180) / Math.PI) % 360 + 360) % 360,
      speedMps: speed,
      accuracyM: p.accuracyM,
      leadMs: leadMs > 0 ? lead : 0,
      snap,
      doubt: p.trust !== "TRUSTED",
    };
    this.lastFed = fed;
    this.lastSource = p.source;
    return fed;
  }
}

/** A map the feed reaches (the wrapper's `MapRef.feedUserLocation`). */
export interface PuckTarget {
  feedUserLocation(lat: number, lon: number, courseDeg: number, speedMps: number, accuracyM: number, leadMs: number, flags: number): void;
}

export interface PuckTargetOptions {
  /** The map is on a screen that shows (the phone's app in front, or the car's own screen). */
  active(): boolean;
  /** The dot gives way (standing on the drawn car). */
  hidden(): boolean;
}

export const FEED_FLAG_SNAP = 1;
export const FEED_FLAG_DOUBT = 2;
export const FEED_FLAG_HIDDEN = 4;

/** Feeds every mounted map from the navigator: its publishes and its advances. */
export class PuckFeeder {
  private readonly feed: PuckFeed;
  private readonly targets = new Map<PuckTarget, PuckTargetOptions & { fedOnce: boolean }>();
  private last: FedPose | null = null;
  private stop: (() => void) | null = null;

  constructor(
    private readonly deps: {
      position: {
        subscribe(listener: () => void): () => void;
        getSnapshot(): PositionEstimate | null;
        onAdvance(listener: (a: NavAdvance) => void): () => void;
      };
      nowMs?(): number;
    },
  ) {
    this.feed = new PuckFeed(deps.nowMs ?? (() => Date.now()));
  }

  start(): void {
    if (this.stop) return;
    const offPublish = this.deps.position.subscribe(() => this.send(this.feed.publish(this.deps.position.getSnapshot())));
    const offAdvance = this.deps.position.onAdvance((a) => this.send(this.feed.advance(a)));
    this.stop = () => {
      offPublish();
      offAdvance();
    };
  }

  dispose(): void {
    this.stop?.();
    this.stop = null;
  }

  /** A map to feed; it gets the last pose at once, placed. */
  register(target: PuckTarget, options: PuckTargetOptions): () => void {
    const entry = { ...options, fedOnce: false };
    this.targets.set(target, entry);
    if (this.last) this.sendTo(target, entry, this.last);
    return () => {
      this.targets.delete(target);
    };
  }

  private send(pose: FedPose | null): void {
    if (!pose) return;
    this.last = pose;
    for (const [target, entry] of this.targets) this.sendTo(target, entry, pose);
  }

  private sendTo(target: PuckTarget, entry: PuckTargetOptions & { fedOnce: boolean }, pose: FedPose): void {
    if (!entry.active()) return;
    const snap = pose.snap || !entry.fedOnce;
    entry.fedOnce = true;
    const flags = (snap ? FEED_FLAG_SNAP : 0) | (pose.doubt ? FEED_FLAG_DOUBT : 0) | (entry.hidden() ? FEED_FLAG_HIDDEN : 0);
    try {
      target.feedUserLocation(pose.lat, pose.lon, pose.courseDeg, pose.speedMps, pose.accuracyM, pose.leadMs, flags);
    } catch {
      // A map whose view is gone before its unregister throws (the wrapper finds no view): it is fed no more.
      this.targets.delete(target);
    }
  }
}
