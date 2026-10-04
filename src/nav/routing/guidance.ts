// Guidance along a planned route (ROUTING-SPEC §8): where the car is along it, the next maneuver, the distance
// and time left, arrival, and when the car has left the route for long enough to plan again. Fed with the
// published position (the puck: map-matched while dead-reckoning), so it works without GPS.

import { haversineM, type Coordinate } from "../geo";
import { LocalFrame } from "../geo/local-frame";
import type { MapMatchState } from "../mapmatch/particle-filter";
import type { Maneuver } from "./maneuvers";
import type { RoutePlan } from "./router";

const DEG = Math.PI / 180;
const TWO_PI = 2 * Math.PI;
const wrap = (a: number) => a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI);

export interface GuidanceConfig {
  /** Off the route beyond max(`offMinM`, `offAccuracyFactor` × the position's accuracy). */
  offMinM: number;
  offAccuracyFactor: number;
  /** Off for this long and this far driven before planning again. */
  offHoldS: number;
  offHoldM: number;
  /** The route is matched within this behind the last progress, and this (or more when fast) ahead. */
  backM: number;
  aheadM: number;
  /** Moving faster than this, a route stretch more than `headingTolRad` off the heading doesn't match. */
  headingMinSpeedMps: number;
  headingTolRad: number;
  /** Within this of the route's end: arrived. */
  arriveM: number;
  /** A maneuver passed by less than this is still the next one (the position lags the turn). */
  passedM: number;
  /** The maneuver after the next is shown with it when this close to it ("then turn left"). */
  thenM: number;
}

export const DEFAULT_GUIDANCE: GuidanceConfig = {
  offMinM: 40,
  offAccuracyFactor: 1.5,
  offHoldS: 4,
  offHoldM: 30,
  backM: 60,
  aheadM: 300,
  headingMinSpeedMps: 3,
  headingTolRad: 75 * DEG,
  arriveM: 30,
  passedM: 10,
  thenM: 120,
};

/**
 * `on`: following the route. `off`: off it for long enough (plan again). `leaving`: off it, not for long enough yet.
 * `unsure`: map matching can't tell which road the car is on, so neither is decided. `arrived`: at the end.
 */
export type GuidanceState = "on" | "leaving" | "off" | "unsure" | "arrived";

export interface GuidancePosition extends Coordinate {
  /** Monotonic time, ms. */
  tMs: number;
  accuracyM: number;
  headingRad?: number;
  speedMps?: number;
  mapMatch?: MapMatchState;
}

export interface GuidanceStep {
  state: GuidanceState;
  /** Distance driven along the route, in the plan's metres. */
  alongM: number;
  /** Distance from the route at the matched point, m. */
  offM: number;
  remainingM: number;
  /** The plan's time for what is left (its pace for the whole route). */
  remainingS: number;
  /** Index in the maneuvers of the next one (`arrive` at the end). */
  nextIndex: number;
  toNextM: number;
  /** The maneuver after the next, when it follows closely. */
  thenIndex: number | null;
}

/** Progress along one plan's polyline. */
export class RouteGuidance {
  readonly config: GuidanceConfig;
  /** Cumulative polyline length at each vertex, m (haversine). */
  private readonly cum: number[];
  /** Polyline metres per plan metre (the plan counts OSM lengths). */
  private readonly scale: number;
  private alongPoly = 0;
  private last: GuidanceStep | null = null;
  private offSince: { tMs: number; drivenM: number } | null = null;
  private lastPosition: GuidancePosition | null = null;

  constructor(
    readonly plan: RoutePlan,
    readonly maneuvers: Maneuver[],
    config: Partial<GuidanceConfig> = {},
  ) {
    this.config = { ...DEFAULT_GUIDANCE, ...config };
    const pts = plan.coordinates;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + haversineM(pts[i - 1], pts[i]));
    const total = this.cum.at(-1)!;
    this.scale = plan.lengthM > 0 && total > 0 ? total / plan.lengthM : 1;
  }

  get step(): GuidanceStep | null {
    return this.last;
  }

  update(p: GuidancePosition): GuidanceStep {
    const c = this.config;
    if (this.last?.state === "arrived") return this.last;
    const prev = this.lastPosition;
    // Driven since the last update: from the speed (OBD while dead-reckoning), not from the positions, which jump.
    const dtS = prev ? Math.max(0, (p.tMs - prev.tMs) / 1000) : 0;
    const drivenM = prev ? (p.speedMps !== undefined ? p.speedMps * dtS : haversineM(prev, p)) : 0;
    this.lastPosition = p;
    const threshold = Math.max(c.offMinM, c.offAccuracyFactor * p.accuracyM);
    const fast = (p.speedMps ?? 0) >= c.headingMinSpeedMps && p.headingRad !== undefined;
    const ahead = c.aheadM + 3 * (p.speedMps ?? 0) * dtS;
    let match = this.match(p, this.alongPoly - c.backM, this.alongPoly + ahead, fast);
    // Far from the expected stretch: the car may have rejoined the route elsewhere (a shortcut, a jump after an
    // outage). Taken only when it fits there.
    if (!match || match.offM > threshold) {
      const anywhere = this.match(p, 0, Infinity, fast);
      if (anywhere && anywhere.offM <= threshold && (!match || anywhere.offM < match.offM)) match = anywhere;
    }
    const totalPoly = this.cum.at(-1)!;
    if (match && match.offM <= threshold) this.alongPoly = match.alongPoly;
    const offM = match?.offM ?? Infinity;
    const alongM = this.alongPoly / this.scale;
    const remainingM = Math.max(0, (totalPoly - this.alongPoly) / this.scale);

    let state: GuidanceState;
    const unsure = p.mapMatch === "multimodal" || p.mapMatch === "init";
    const end = this.plan.coordinates.at(-1)!;
    if ((remainingM <= c.arriveM && offM <= threshold) || haversineM(p, end) <= c.arriveM) {
      state = "arrived";
    } else if (offM <= threshold) {
      state = "on";
      this.offSince = null;
    } else if (unsure) {
      state = "unsure";
      this.offSince = null;
    } else {
      this.offSince ??= { tMs: p.tMs, drivenM: 0 };
      this.offSince.drivenM += drivenM;
      const held = p.tMs - this.offSince.tMs >= c.offHoldS * 1000 && this.offSince.drivenM >= c.offHoldM;
      state = held ? "off" : "leaving";
    }

    const nextIndex = this.nextManeuver(alongM);
    const next = this.maneuvers[nextIndex];
    const following = this.maneuvers[nextIndex + 1];
    this.last = {
      state,
      alongM,
      offM,
      remainingM,
      remainingS: this.plan.lengthM > 0 ? (this.plan.durationS * remainingM) / this.plan.lengthM : 0,
      nextIndex,
      toNextM: Math.max(0, next.atM - alongM),
      thenIndex: following && following.atM - next.atM <= c.thenM ? nextIndex + 1 : null,
    };
    return this.last;
  }

  /** The first maneuver not yet passed (by more than `passedM`); `arrive` at the end. */
  private nextManeuver(alongM: number): number {
    const list = this.maneuvers;
    for (let i = 1; i < list.length; i++) if (list[i].atM > alongM - this.config.passedM && list[i].atM > 0) return i;
    return list.length - 1;
  }

  /** The closest point of the polyline between `fromM` and `toM` (polyline metres). */
  private match(p: GuidancePosition, fromM: number, toM: number, useHeading: boolean): { alongPoly: number; offM: number } | null {
    const pts = this.plan.coordinates;
    const frame = new LocalFrame(p);
    let best: { alongPoly: number; offM: number } | null = null;
    for (let i = 0; i + 1 < pts.length; i++) {
      if (this.cum[i + 1] < fromM) continue;
      if (this.cum[i] > toM) break;
      const [ax, ay] = frame.toEnu(pts[i]);
      const [bx, by] = frame.toEnu(pts[i + 1]);
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 <= 0) continue;
      if (useHeading && Math.abs(wrap(Math.atan2(dx, dy) - p.headingRad!)) > this.config.headingTolRad) continue;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
      const offM = Math.hypot(ax + t * dx, ay + t * dy);
      if (!best || offM < best.offM) best = { alongPoly: this.cum[i] + t * (this.cum[i + 1] - this.cum[i]), offM };
    }
    return best;
  }
}
