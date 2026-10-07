// Ground truth drawn by hand in the replay viewer (tools/replay): the roads the car drove, clicked on the map in
// order, and where on them the car was every second. Most jammed drives have no clean fix at all, so nothing else
// can say whether the dot was right there (MAPMATCH-SPEC §10.2). Pure TS; times are seconds since log start.

import type { TripLog } from "../../triplog/trip-log-reader";
import { haversineM, type Coordinate } from "../geo";
import type { LocalFrame } from "../geo/local-frame";
import type { EdgeId, NearEdge, NodeId, RoadEdge, RoadGraph } from "../mapmatch/graph/road-graph";
import { MinHeap } from "../routing/min-heap";
import { isSatelliteFix } from "../types";
import { TRUTH_ACCURACY_M, trackAt, type ShownPoint } from "./drive-report";
import { obdOdometer, sliceAlong } from "./truth-match";

/** A point clicked on the map. `straight`: the stretch from the previous point is a straight line, not along roads. */
export interface DrawnPoint extends Coordinate {
  straight?: boolean;
}

/** The stretch from one point to the next. */
export interface DrawnLeg {
  lengthM: number;
  /** Index in the path of the stretch's first point. */
  start: number;
  kind: "road" | "straight";
  /**
   * Why it is straight: asked; off the roads (both ends more than `ON_ROAD_M` from every road, or one more than
   * `REACH_M`); no road route; or only a detour (`isDetour`).
   */
  reason?: "asked" | "off the roads" | "no route" | "detour";
}

/** What the viewer saves next to a log, as `<log>.truth.json` (git-ignored with the logs: it is where the car went). */
export interface DrawnTruth {
  version: 1;
  file: string;
  points: DrawnPoint[];
  /** The whole path, [lat, lon]. */
  path: [number, number][];
  /** One per stretch between two points. */
  legs: DrawnLeg[];
  /**
   * Where the path is drawn straight, [from, to] m along it: a car park, a yard. Its length there is a guess (a
   * cloud of clicks marking a car park zigzags), so the timing stretches it, not the roads, to fit the odometer.
   */
  straightM?: [number, number][];
  /** The road graph it was drawn on (file name, OSM date). */
  graph: string | null;
  updatedAt: string;
}

/**
 * A click this close to a road is on it. Two or more in a row farther, or a drive's first or last, are off the roads
 * the map has: a car park, a yard, a lane OSM lacks. Of 540 clicks drawn for 29 drives, 434 were within 12 m of a road (373 within 1 m); the
 * car parks, drawn as clouds of clicks, were 15–45 m from one.
 */
export const ON_ROAD_M = 12;
/** A click alone on the way, up to this far from a road, is on it (a click beside it); farther, off the roads. */
export const SNAP_M = 40;
/** A stretch between a click off the roads and one on them leaves (or joins) the roads this close to the first. */
export const REACH_M = 100;
/** A road route longer than this many times the straight line between its clicks, plus the slack, isn't searched. */
const ROUTE_REACH_FACTOR = 4;
const ROUTE_REACH_SLACK_M = 1000;
/**
 * A road route this many times the straight line between its clicks, and this much longer, wasn't driven: two clicks
 * on different roads the map doesn't join nearby (a yard's entrance the map lacks; gaz9bc: 12 m apart, 733 m round).
 * Of the 29 drives drawn, that was the only stretch past 1.5× and 60 m longer.
 */
const DETOUR_FACTOR = 3;
const DETOUR_SLACK_M = 100;
export const isDetour = (routeM: number, straightM: number) => routeM > DETOUR_FACTOR * straightM && routeM > straightM + DETOUR_SLACK_M;

const edgeM = (e: RoadEdge) => e.cum[e.cum.length - 1];
const at = (p: [number, number]): Coordinate => ({ lat: p[0], lon: p[1] });

function polylineM(path: readonly [number, number][]): number {
  let m = 0;
  for (let i = 1; i < path.length; i++) m += haversineM(at(path[i - 1]), at(path[i]));
  return m;
}

/**
 * The path through the clicked points: the shortest way along the roads between each two, or a straight line.
 * One-ways and turn restrictions don't count: the car went where it went, and OSM is sometimes wrong about them (on
 * 2026-10-06 a roundabout's exit was mapped as a second entry). A wrong guess takes one more click. Between two
 * clicks off the roads (`ON_ROAD_M`) the line is straight: a car park the map lacks. From one of them to a click on
 * a road it is straight to the nearest road, then along the roads. Without a graph every stretch is straight.
 */
export function drawPath(graph: RoadGraph | null, frame: LocalFrame, points: readonly DrawnPoint[]): Pick<DrawnTruth, "path" | "legs" | "straightM"> {
  const snaps = points.map((p) => {
    const [e, n] = frame.toEnu(p);
    return graph?.edgesNear(e, n, REACH_M)[0] ?? null;
  });
  // Off the roads takes two clicks in a row, or a drive's end (where it parked): one alone beside a road on the way
  // was meant on it.
  const far = (i: number) => i >= 0 && i < points.length && !(snaps[i] && snaps[i]!.distanceM <= ON_ROAD_M);
  const alone = (i: number) => i > 0 && i + 1 < points.length && !far(i - 1) && !far(i + 1);
  const onRoad = snaps.map((s, i) => !far(i) || (!!s && s.distanceM <= SNAP_M && alone(i)));
  const clicked = (i: number): [number, number] => [points[i].lat, points[i].lon];
  // A point on a road is drawn on it when a road stretch arrives or leaves there, else where it was clicked.
  const place = (i: number): [number, number] => {
    const s = snaps[i];
    const roadNext = i + 1 < points.length && !points[i + 1].straight;
    const roadPrev = i > 0 && !points[i].straight;
    if (s && onRoad[i] && (roadNext || roadPrev)) {
      const c = frame.toCoordinate(s.e, s.n);
      return [c.lat, c.lon];
    }
    return clicked(i);
  };
  const path: [number, number][] = [];
  const append = (pts: readonly [number, number][]) => {
    for (const p of pts) {
      const last = path.at(-1);
      if (!last || last[0] !== p[0] || last[1] !== p[1]) path.push(p);
    }
  };
  const legs: DrawnLeg[] = [];
  if (points.length) append([place(0)]);
  for (let i = 0; i + 1 < points.length; i++) {
    const a = snaps[i];
    const b = snaps[i + 1];
    let reason: DrawnLeg["reason"];
    let road: [number, number][] | null = null;
    if (points[i + 1].straight) reason = "asked";
    else if (!graph || !a || !b || (!onRoad[i] && !onRoad[i + 1])) reason = "off the roads";
    else {
      const crow = haversineM(points[i], points[i + 1]);
      road = roadRoute(graph, a, b, ROUTE_REACH_FACTOR * crow + ROUTE_REACH_SLACK_M);
      if (!road) reason = "no route";
      else if (isDetour(polylineM(road), crow)) {
        road = null;
        reason = "detour";
      }
      else road = [...(onRoad[i] ? [] : [clicked(i)]), ...road, ...(onRoad[i + 1] ? [] : [clicked(i + 1)])];
    }
    const leg = road ?? [place(i), place(i + 1)];
    legs.push({ lengthM: polylineM(leg), start: Math.max(0, path.length - 1), kind: road ? "road" : "straight", ...(reason ? { reason } : {}) });
    append(leg);
  }
  // Where along the path it is straight: whole straight stretches, and a road stretch's ends off the roads.
  const cum = [0];
  for (let k = 1; k < path.length; k++) cum.push(cum[k - 1] + haversineM(at(path[k - 1]), at(path[k])));
  const straightM: [number, number][] = [];
  const add = (from: number, to: number) => {
    const last = straightM.at(-1);
    if (to <= from) return;
    if (last && last[1] >= from) last[1] = to;
    else straightM.push([from, to]);
  };
  legs.forEach((leg, i) => {
    const end = i + 1 < legs.length ? legs[i + 1].start : path.length - 1;
    if (leg.kind === "straight") return add(cum[leg.start], cum[end]);
    if (!onRoad[i]) add(cum[leg.start], cum[leg.start + 1]);
    if (!onRoad[i + 1]) add(cum[end - 1], cum[end]);
  });
  return { path, legs, straightM };
}

/** The shortest road route (by length, either way along every edge) between two points on the graph, as [lat, lon]. */
function roadRoute(graph: RoadGraph, a: NearEdge, b: NearEdge, reachM: number): [number, number][] | null {
  const out: [number, number][] = [];
  const slice = (edge: RoadEdge, from: number, to: number) => {
    const pts = sliceAlong(edge, Math.min(from, to), Math.max(from, to));
    if (from > to) pts.reverse();
    for (const [lon, lat] of pts) {
      const last = out.at(-1);
      if (!last || last[0] !== lat || last[1] !== lon) out.push([lat, lon]);
    }
  };
  if (a.edge.id === b.edge.id) {
    slice(a.edge, a.alongM, b.alongM);
    return out;
  }
  // Dijkstra over the nodes, from both ends of the start's edge.
  const dist = new Map<NodeId, number>();
  const via = new Map<NodeId, { edge: EdgeId; from: NodeId } | null>();
  const queued: NodeId[] = [];
  const heap = new MinHeap();
  const reach = (node: NodeId, d: number, step: { edge: EdgeId; from: NodeId } | null) => {
    if (d > reachM || d >= (dist.get(node) ?? Infinity)) return;
    dist.set(node, d);
    via.set(node, step);
    queued.push(node);
    heap.push(d, queued.length - 1);
  };
  reach(a.edge.from, a.alongM, null);
  reach(a.edge.to, edgeM(a.edge) - a.alongM, null);
  const lenB = edgeM(b.edge);
  let best = Infinity;
  let goal: NodeId | null = null;
  while (heap.size && heap.peekKey() < best) {
    const d = heap.peekKey();
    const node = queued[heap.pop()!];
    if (d > dist.get(node)!) continue;
    if (node === b.edge.from && d + b.alongM < best) {
      best = d + b.alongM;
      goal = node;
    }
    if (node === b.edge.to && d + lenB - b.alongM < best) {
      best = d + lenB - b.alongM;
      goal = node;
    }
    for (const { edge: id } of graph.node(node).edges) {
      const edge = graph.edge(id);
      const next = edge.from === node ? edge.to : edge.from;
      if (next !== node) reach(next, d + edgeM(edge), { edge: id, from: node });
    }
  }
  if (goal === null) return null;
  const chain: { edge: RoadEdge; forward: boolean }[] = [];
  let node = goal;
  for (let step = via.get(node); step; step = via.get(node)) {
    const edge = graph.edge(step.edge);
    chain.push({ edge, forward: edge.from === step.from });
    node = step.from;
  }
  chain.reverse();
  slice(a.edge, a.alongM, node === a.edge.from ? 0 : edgeM(a.edge));
  for (const { edge, forward } of chain) slice(edge, forward ? 0 : edgeM(edge), forward ? edgeM(edge) : 0);
  slice(b.edge, goal === b.edge.from ? 0 : lenB, b.alongM);
  return out;
}

/** Where the car was on the drawn path, once a second. */
export interface DrawnTruthTrack {
  path: [number, number][];
  /** Distance along `path` at each of its points, m. */
  cum: number[];
  /**
   * [t (s since log start), lat, lon, m along the path, ± m along it]: the timing's doubt grows with the odometer
   * distance to the nearest anchor (`TIMING_DOUBT`).
   */
  points: [number, number, number, number, number][];
  pathM: number;
  /** OBD distance over the drive. Next to `pathM` it checks the drawing: the odometer reads within a few %. */
  odometerM: number;
  /** Clean satellite fixes the timing is pinned to, besides the drive's two ends. */
  anchors: number;
  /** The largest doubt along the path, m. */
  doubtM: number;
}

/** A clean fix this close to the path pins the time there, if it is within the window around where the odometer puts the car. */
const ANCHOR_FIX_M = 25;
const ANCHOR_WINDOW_M = 300;
/** Odometer distance between two anchors: each fix is ±5 m, so anchors close together would bend the timing. */
const ANCHOR_SPACING_M = 100;
/**
 * How far along the path the timing may be off: this share of the odometer distance to the nearest anchor, plus the
 * floor. Drawn right (within 1 % of the odometer), clean drives timed by the odometer alone were 2–13 m off the fixes
 * at the median and 18–42 m at p90, over 1–3 km between their ends.
 */
const TIMING_DOUBT = { share: 0.03, floorM: 10 };

/** The end of a log, s: its last IMU, OBD or GNSS sample. */
function endS(trip: TripLog): number {
  const last = Math.max(trip.imu.at(-1)?.tUs ?? 0, trip.obdSpeed.at(-1)?.tUs ?? 0, trip.gnss.at(-1)?.tUs ?? 0);
  return Math.max(0, (last - trip.startUs) / 1e6);
}

/** The point of the path nearest to `p` between `fromM` and `toM` along it. */
function nearestOnPath(path: readonly [number, number][], cum: readonly number[], p: Coordinate, fromM: number, toM: number): { s: number; distanceM: number } | null {
  const kx = 111_195 * Math.cos((p.lat * Math.PI) / 180);
  const ky = 111_195;
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= fromM) lo = mid;
    else hi = mid;
  }
  let best: { s: number; distanceM: number } | null = null;
  for (let i = lo; i + 1 < path.length && cum[i] <= toM; i++) {
    const ax = (path[i][1] - p.lon) * kx;
    const ay = (path[i][0] - p.lat) * ky;
    const dx = (path[i + 1][1] - p.lon) * kx - ax;
    const dy = (path[i + 1][0] - p.lat) * ky - ay;
    const len2 = dx * dx + dy * dy;
    let f = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    // Within the window only.
    const segM = cum[i + 1] - cum[i];
    if (segM > 0) f = Math.max((fromM - cum[i]) / segM, Math.min((toM - cum[i]) / segM, f));
    f = Math.max(0, Math.min(1, f));
    const d = Math.hypot(ax + f * dx, ay + f * dy);
    if (!best || d < best.distanceM) best = { s: cum[i] + f * segM, distanceM: d };
  }
  return best;
}

function pointAlong(path: readonly [number, number][], cum: readonly number[], s: number): [number, number] {
  if (path.length === 1 || s <= 0) return path[0];
  let lo = 0;
  let hi = cum.length - 1;
  if (s >= cum[hi]) return path[hi];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const f = cum[hi] > cum[lo] ? (s - cum[lo]) / (cum[hi] - cum[lo]) : 0;
  return [path[lo][0] + f * (path[hi][0] - path[lo][0]), path[lo][1] + f * (path[hi][1] - path[lo][1])];
}

/** A straight stretch's drawn length is right to within this share: a cloud of clicks marking a car park zigzags. */
const STRAIGHT_DOUBT = 0.5;

/**
 * Between two anchors `odoM` apart on the odometer, where the car is along the path [sa, sb] at a share of it. Where
 * the drawing and the odometer disagree, the straight stretches take most of it (`STRAIGHT_DOUBT`, a quarter to four
 * times their drawn length), so a zigzag drawn through a car park doesn't push the car ahead on the roads.
 */
function stretched(sa: number, sb: number, odoM: number, straightM: readonly [number, number][]): (share: number) => number {
  const uniform = (share: number) => sa + share * (sb - sa);
  const pieces: { from: number; to: number; straight: boolean }[] = [];
  let s = sa;
  for (const [a, b] of straightM) {
    const from = Math.max(a, s);
    const to = Math.min(b, sb);
    if (to <= from) continue;
    if (from > s) pieces.push({ from: s, to: from, straight: false });
    pieces.push({ from, to, straight: true });
    s = to;
  }
  if (sb > s) pieces.push({ from: s, to: sb, straight: false });
  const lengthM = (straight: boolean) => pieces.reduce((m, p) => m + (p.straight === straight ? p.to - p.from : 0), 0);
  const roadM = lengthM(false);
  const straightLenM = lengthM(true);
  if (!(roadM > 0 && straightLenM > 0 && odoM > 0)) return uniform;
  // Odometer metres per drawn metre: on the roads about 1 (`TIMING_DOUBT.share`), on the straight stretches 1 to
  // within half. The least change to both, each by its doubt, that adds up to the odometer.
  const roadVar = (roadM * TIMING_DOUBT.share) ** 2;
  const straightVar = (straightLenM * STRAIGHT_DOUBT) ** 2;
  const k = (odoM - roadM - straightLenM) / (roadVar + straightVar);
  const perStraightM = Math.max(0.25, Math.min(4, 1 + (k * straightVar) / straightLenM));
  const perRoadM = (odoM - straightLenM * perStraightM) / roadM;
  if (!(perRoadM > 0)) return uniform;
  // The share of the odometer between the anchors each metre takes, summed piece by piece.
  const perRoad = perRoadM / odoM;
  const perStraight = perStraightM / odoM;
  const upTo = [0];
  for (const p of pieces) upTo.push(upTo.at(-1)! + (p.to - p.from) * (p.straight ? perStraight : perRoad));
  return (share) => {
    let i = 0;
    while (i + 1 < pieces.length && upTo[i + 1] < share) i++;
    const p = pieces[i];
    const span = upTo[i + 1] - upTo[i];
    return p.from + (span > 0 ? Math.max(0, Math.min(1, (share - upTo[i]) / span)) : 1) * (p.to - p.from);
  };
}

/**
 * Times the drawn path: the car is at its start when the log starts and at its end when the log ends, and in
 * between it moves along it as the OBD odometer says, scaled between anchors (the straight stretches take up what
 * the roads leave: `stretched`). Clean satellite fixes near the path are anchors too, so a drive with some GPS is
 * timed by it and only its gaps by the odometer.
 */
export function drawnTruthTrack(trip: TripLog, truth: Pick<DrawnTruth, "path" | "straightM">, stepS = 1): DrawnTruthTrack {
  const path = truth.path;
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + haversineM(at(path[i - 1]), at(path[i])));
  const pathM = cum.at(-1) ?? 0;
  const odometer = obdOdometer(trip);
  const odo = (t: number) => odometer(trip.startUs + t * 1e6);
  const end = endS(trip);
  const odometerM = odo(end);
  const ratio = odometerM > 0 ? pathM / odometerM : 1;
  const anchors: [number, number][] = [[0, 0]];
  let anchorOdo = 0;
  for (const f of trip.gnss) {
    if (!isSatelliteFix(f) || f.hAccM > TRUTH_ACCURACY_M) continue;
    const t = (f.tUs - trip.startUs) / 1e6;
    const d = odo(t);
    if (t <= 0 || t >= end || d - anchorOdo < ANCHOR_SPACING_M) continue;
    const [t0, s0] = anchors.at(-1)!;
    const guess = s0 + (d - odo(t0)) * ratio;
    const window = ANCHOR_WINDOW_M + 0.05 * (d - odo(t0));
    const hit = path.length > 1 ? nearestOnPath(path, cum, f, guess - window, guess + window) : null;
    if (!hit || hit.distanceM > ANCHOR_FIX_M || hit.s < s0) continue;
    anchors.push([t, hit.s]);
    anchorOdo = d;
  }
  anchors.push([end, pathM]);
  const along = anchors.slice(1).map(([tb, sb], k) => {
    const [ta, sa] = anchors[k];
    return stretched(sa, sb, odo(tb) - odo(ta), truth.straightM ?? []);
  });
  const points: DrawnTruthTrack["points"] = [];
  let k = 0;
  let doubtM = 0;
  for (let t = 0; path.length && t <= end + 1e-9; t += stepS) {
    while (k + 2 < anchors.length && anchors[k + 1][0] <= t) k++;
    const [ta] = anchors[k];
    const [tb] = anchors[k + 1];
    const dOdo = odo(tb) - odo(ta);
    const d = odo(t);
    const f = dOdo > 0 ? (d - odo(ta)) / dOdo : tb > ta ? (t - ta) / (tb - ta) : 1;
    const s = along[k](Math.max(0, Math.min(1, f)));
    const [lat, lon] = pointAlong(path, cum, s);
    const doubt = TIMING_DOUBT.floorM + TIMING_DOUBT.share * Math.max(0, Math.min(d - odo(ta), odo(tb) - d));
    doubtM = Math.max(doubtM, doubt);
    points.push([t, lat, lon, s, doubt]);
  }
  return { path, cum, points, pathM, odometerM, anchors: anchors.length - 2, doubtM };
}

/** A track against the drawn truth. Distances in m; only while the car moves (over 2 m/s), but for `endErrorM`. */
export interface DrawnScore {
  /** Seconds compared: the car moving and the track running. */
  movingS: number;
  /**
   * From the dot to the drawn path within `OFF_PATH_WINDOW_M` (plus twice the timing's doubt) along it of where the
   * car was: on the right road or not, whatever the timing.
   */
  offPathMedianM: number | null;
  offPathP90M: number | null;
  /** Seconds the dot was more than `OFF_PATH_M` from the path: on another road, or through the blocks. */
  offPathS: number;
  /** From the dot to where the car was then: the timing is the odometer's, ±1–2 % of the distance to an anchor. */
  errorMedianM: number | null;
  errorP90M: number | null;
  errorMaxM: number | null;
  /** At the drive's end: where the car parked. */
  endErrorM: number | null;
}

export const OFF_PATH_M = 30;
export const OFF_PATH_WINDOW_M = 300;
const MOVING_MPS = 2;

const quantile = (v: number[], q: number) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

export function scoreDrawn(trip: TripLog, truth: DrawnTruthTrack, track: ShownPoint[]): DrawnScore {
  const odometer = obdOdometer(trip);
  const odo = (t: number) => odometer(trip.startUs + t * 1e6);
  const off: number[] = [];
  const err: number[] = [];
  let offPathS = 0;
  let endErrorM: number | null = null;
  const step = truth.points.length > 1 ? truth.points[1][0] - truth.points[0][0] : 1;
  for (const [t, lat, lon, s, doubt] of truth.points) {
    const p = trackAt(track, t);
    if (!p) continue;
    endErrorM = haversineM(p, { lat, lon });
    if (odo(t + step / 2) - odo(t - step / 2) < MOVING_MPS * step) continue;
    const reach = OFF_PATH_WINDOW_M + 2 * doubt;
    const near = nearestOnPath(truth.path, truth.cum, p, s - reach, s + reach);
    const d = near?.distanceM ?? Infinity;
    off.push(d);
    if (d > OFF_PATH_M) offPathS += step;
    err.push(endErrorM);
  }
  return {
    movingS: off.length * step,
    offPathMedianM: quantile(off, 0.5),
    offPathP90M: quantile(off, 0.9),
    offPathS,
    errorMedianM: quantile(err, 0.5),
    errorP90M: quantile(err, 0.9),
    errorMaxM: err.length ? Math.max(...err) : null,
    endErrorM,
  };
}
