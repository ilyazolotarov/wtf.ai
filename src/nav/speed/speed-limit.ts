// The speed limit where the car is (UI-SPEC §6.4): the road's own from OSM, else Ukraine's default for that kind of
// road, and shown only while the roads the car may be on agree on one.

import { EdgeFlag, Oneway, RoadClass } from "../mapmatch/graph/format";
import type { NearEdge, RoadEdge } from "../mapmatch/graph/road-graph";

export interface SpeedLimit {
  kph: number;
  /** From the road's OSM tag; false: Ukraine's default for a road of its kind, where it is (`edgeLimit`). */
  tagged: boolean;
}

/**
 * Ukraine's defaults (Traffic Rules §12.4–12.6) for a road without a `maxspeed` tag: 50 in a settlement, 20 in a
 * living street, 130 on a motorway, 90 elsewhere. A settlement is the graph's `urban` (MAPMATCH-SPEC §4.3).
 */
export const DEFAULT_LIMITS = { urban: 50, livingStreet: 20, motorway: 130, rural: 90 } as const;

/**
 * The limit on an edge: its OSM tag, else the default for its kind. Null on a graph built without speed attributes;
 * on driveways and parking aisles (the car is there only to park, and a sign there would only flicker); and on an
 * untagged one-way trunk or primary road outside settlements. That may be a dual carriageway's side (110), or a split
 * around a village or works (90, 50): a sign too high warns too late, one too low warns a driver who is legal. Dual
 * carriageways are almost all tagged (`UA:trunk` is a tagged 110).
 */
export function edgeLimit(edge: RoadEdge): SpeedLimit | null {
  if (!(edge.flags & EdgeFlag.attributes) || edge.flags & EdgeFlag.minorService) return null;
  if (edge.maxspeedKph > 0) return { kph: edge.maxspeedKph, tagged: true };
  if (edge.cls === RoadClass.livingStreet) return { kph: DEFAULT_LIMITS.livingStreet, tagged: false };
  if (edge.cls === RoadClass.motorway) return { kph: DEFAULT_LIMITS.motorway, tagged: false };
  if (edge.flags & EdgeFlag.urban) return { kph: DEFAULT_LIMITS.urban, tagged: false };
  const oneWayMain =
    (edge.cls === RoadClass.trunk || edge.cls === RoadClass.primary) &&
    edge.oneway !== Oneway.none &&
    !(edge.flags & (EdgeFlag.link | EdgeFlag.roundabout));
  return oneWayMain ? null : { kph: DEFAULT_LIMITS.rural, tagged: false };
}

/**
 * A road the car may be on and the share of belief in it; `edge` null: off the roads. Moving, the way along it the
 * car goes (`dir`, along the geometry or against it) and where on it (`alongM`): the road ahead's start (§6.5).
 */
export interface LimitCandidate {
  edge: RoadEdge | null;
  weight: number;
  dir?: 1 | -1;
  alongM?: number;
}

/**
 * A limit is shown only when the roads holding at least this share of the weight have it. Below, the car may as well
 * be on a road with another limit (a junction, a parallel road, map matching torn between two): no sign, rather than
 * a wrong one (UI-SPEC §6.4).
 */
export const LIMIT_MIN_SHARE = 0.8;

/** The limit most of the weight agrees on; null when no limit holds `minShare` of it. */
export function agreedLimit(candidates: LimitCandidate[], minShare = LIMIT_MIN_SHARE): SpeedLimit | null {
  let total = 0;
  const byKph = new Map<number, { weight: number; tagged: number }>();
  for (const c of candidates) {
    if (!(c.weight > 0)) continue;
    total += c.weight;
    const limit = c.edge ? edgeLimit(c.edge) : null;
    if (!limit) continue;
    const b = byKph.get(limit.kph) ?? { weight: 0, tagged: 0 };
    b.weight += c.weight;
    if (limit.tagged) b.tagged += c.weight;
    byKph.set(limit.kph, b);
  }
  if (total <= 0) return null;
  for (const [kph, b] of byKph) if (b.weight >= minShare * total) return { kph, tagged: b.tagged >= b.weight / 2 };
  return null;
}

/** GNSS snapping (no map matching): how far from the fix a road can be, at least and at most, m. */
const SNAP_MIN_RADIUS_M = 25;
const SNAP_MAX_RADIUS_M = 60;
/** The spread of a fix around the road it was taken on: the fix's own, and never less (lanes, a wide avenue), m. */
const SNAP_MIN_SIGMA_M = 10;
/** Moving at least this fast, the GNSS course says which roads (and which way along them) the car can be on. */
const SNAP_COURSE_MIN_MPS = 3;
const SNAP_COURSE_TOLERANCE_RAD = (35 * Math.PI) / 180;
/**
 * At this speed (40 km/h) and over, service roads are no candidates: nobody drives that fast on one, and one along an
 * avenue 15 m off would hold a quarter of the weight and keep the avenue's sign away.
 */
const SNAP_SERVICE_MAX_MPS = 11;

/** The radius to look for roads around a fix of this accuracy (`snapCandidates`). */
export const snapRadiusM = (accuracyM: number) =>
  Math.min(SNAP_MAX_RADIUS_M, Math.max(SNAP_MIN_RADIUS_M, 2.5 * accuracyM));

const TWO_PI = 2 * Math.PI;
const angleBetween = (a: number, b: number) => Math.abs(a - b - TWO_PI * Math.floor((a - b + Math.PI) / TWO_PI));

/**
 * The roads around a GNSS position, weighted by how close they are (Gaussian at the fix's accuracy). Moving, only the
 * roads along the course, the way they may be driven: across a junction the crossing road drops out, and on a dual
 * carriageway the other side; fast, no service roads. Driveways and parking aisles count as off the roads. A parallel
 * road with another limit close by still leaves no sign: the fix can't tell which lane is whose.
 */
export function snapCandidates(near: NearEdge[], accuracyM: number, headingRad?: number, speedMps?: number): LimitCandidate[] {
  const sigma = Math.max(SNAP_MIN_SIGMA_M, accuracyM);
  const course = headingRad !== undefined && (speedMps ?? 0) >= SNAP_COURSE_MIN_MPS ? headingRad : undefined;
  const fast = (speedMps ?? 0) >= SNAP_SERVICE_MAX_MPS;
  const out: LimitCandidate[] = [];
  for (const n of near) {
    if (n.distanceM > snapRadiusM(accuracyM)) continue;
    const e = n.edge;
    if (fast && e.cls === RoadClass.service) continue;
    let dir: 1 | -1 | undefined;
    if (course !== undefined) {
      const along = angleBetween(course, n.headingRad) <= SNAP_COURSE_TOLERANCE_RAD;
      const against = angleBetween(course, n.headingRad + Math.PI) <= SNAP_COURSE_TOLERANCE_RAD;
      if (along && e.oneway !== Oneway.backward) dir = 1;
      else if (against && e.oneway !== Oneway.forward) dir = -1;
      else continue;
    }
    const weight = Math.exp(-0.5 * (n.distanceM / sigma) ** 2);
    if (e.flags & EdgeFlag.minorService) out.push({ edge: null, weight });
    else out.push({ edge: e, weight, ...(dir ? { dir, alongM: n.alongM } : {}) });
  }
  return out;
}

/** A limit appears this soon; another one (or none) replaces it only after holding this long, ms. */
const SHOW_AFTER_MS = 1000;
const CHANGE_AFTER_MS = 2000;

/**
 * Besides the hold, a change shows this much after the car meets it, s: the next position (every 0.4–0.5 s) and the
 * roads the car may be on agreeing on the new limit (no sign while they split, and the hold starts again). Measured at
 * town signs on real drives: shown 2.6–3.4 s after the car passed them with the 2 s hold.
 */
const LIMIT_LATENCY_S = 1;

/**
 * Moving, the limit is the road's where the car will be once a change has shown: this long ahead at its speed, as far
 * as the road can only go on (`edgeAhead`). A new limit then shows where the car meets it, not 3 s past it (90 m at
 * 110 km/h): a town's 50 came after its sign, the 90 leaving it after the end of the town. A lower one comes sooner
 * (`limitRoad`).
 */
export const LIMIT_LEAD_S = CHANGE_AFTER_MS / 1000 + LIMIT_LATENCY_S;

/**
 * A lower limit ahead shows early enough to slow down to it by its start at this rate, m/s²: lifting off and braking
 * lightly. From 110 to a town's 50 that is 250 m before its sign, from 90 140 m, from 50 to 30 40 m.
 */
export const SLOW_FOR_LIMIT_MPS2 = 1.5;

/** Metres to slow from `fromKph` to `toKph` at `SLOW_FOR_LIMIT_MPS2` (0 when not slower). */
export function slowingM(fromKph: number, toKph: number): number {
  const from = fromKph / 3.6;
  const to = toKph / 3.6;
  return to < from ? (from * from - to * to) / (2 * SLOW_FOR_LIMIT_MPS2) : 0;
}

/**
 * The limit as shown: a new one after it held a moment, so a junction or a hypothesis passing by doesn't flash a sign.
 * A limit that comes back within the wait cancels the change.
 */
export class LimitHold {
  private shown: SpeedLimit | null = null;
  private pending: { limit: SpeedLimit | null; sinceMs: number } | null = null;

  update(limit: SpeedLimit | null, nowMs: number): SpeedLimit | null {
    if (same(limit, this.shown)) {
      // The same number: whether it is the tag's or the default's is news, but nothing to wait for.
      this.shown = limit;
      this.pending = null;
      return this.shown;
    }
    if (!this.pending || !same(this.pending.limit, limit)) this.pending = { limit, sinceMs: nowMs };
    if (nowMs - this.pending.sinceMs >= (this.shown ? CHANGE_AFTER_MS : SHOW_AFTER_MS)) {
      this.shown = limit;
      this.pending = null;
    }
    return this.shown;
  }

  /** A change is waiting out its moment: it shows only with a position after it. */
  waiting(): boolean {
    return this.pending !== null;
  }

  reset(): void {
    this.shown = null;
    this.pending = null;
  }
}

const same = (a: SpeedLimit | null, b: SpeedLimit | null) => a?.kph === b?.kph;
