// Ground truth for map-matching metrics (MAPMATCH-SPEC §10.1): which road the car was on.
// An offline Viterbi HMM over clean satellite fixes. Right here, unlike for live matching: clean
// GNSS errors are independent and bounded, and the matcher sees the whole drive. Transitions are
// scored against the OBD distance driven between fixes, which follows curves (straight-line
// distance doesn't). Replay only; not used by the navigator.

import type { TripLog } from "../../triplog/trip-log-reader";
import { LocalFrame } from "../geo/local-frame";
import type { EdgeId, RoadEdge, RoadGraph, TiledRoadGraph } from "../mapmatch/graph/road-graph";
import { isSatelliteFix, type GnssFix } from "../types";

export interface TruthOptions {
  /** Fixes at least this good are used (the replay's truth rule). */
  maxFixAccuracyM: number;
  candidateRadiusM: number;
  /** Nearest edges considered per fix (each in both directions). */
  maxCandidates: number;
  /** Emission: fix distance from the road, and course vs travel direction when moving. */
  positionSigmaM: number;
  headingSigmaRad: number;
  headingMinSpeedMps: number;
  /** Transition scale: β = base + share × OBD distance (OBD reads a few % off). */
  betaBaseM: number;
  betaShare: number;
  /** A route may be this much longer than the OBD distance, plus `routeSlackM`. */
  routeFactor: number;
  routeSlackM: number;
  /** Fixes further apart than this start a new chain. */
  maxGapS: number;
  /** Route penalties, m: OSM may be wrong, but these should win only when nothing else fits. */
  againstOnewayM: number;
  restrictedM: number;
  uTurnM: number;
  /** Projection back along the same edge accepted as fix jitter (standing, slow). */
  jitterM: number;
  /** Re-anchor the local frame beyond this distance. */
  reanchorM: number;
}

export const DEFAULT_TRUTH_OPTIONS: TruthOptions = {
  maxFixAccuracyM: 10,
  candidateRadiusM: 30,
  maxCandidates: 8,
  positionSigmaM: 5,
  headingSigmaRad: (20 * Math.PI) / 180,
  headingMinSpeedMps: 3,
  betaBaseM: 5,
  betaShare: 0.05,
  routeFactor: 1.5,
  routeSlackM: 50,
  maxGapS: 30,
  againstOnewayM: 200,
  restrictedM: 100,
  uTurnM: 100,
  jitterM: 10,
  reanchorM: 5000,
};

/** Where the car was at a fix: edge, travel direction, position along the edge geometry. */
export interface TruthPoint {
  tUs: number;
  edge: EdgeId;
  dir: 1 | -1;
  alongM: number;
  /** Distance from the fix to the road, m. */
  distanceM: number;
}

/** Route between two consecutive truth points of a chain. */
export interface TruthLeg {
  from: number;
  to: number;
  /** Directed edges from the first point's edge to the second's (both included). */
  path: { edge: EdgeId; dir: 1 | -1 }[];
  lengthM: number;
  /** OBD distance driven between the fixes, m. */
  obdM: number;
  /** One-way, restriction and U-turn penalties on the route, m (0 for a lawful route). */
  penaltyM: number;
}

export interface TruthBreak {
  /** First and last fix of the break (consecutive fixes with no road nearby form one break). */
  t0Us: number;
  t1Us: number;
  fixes: number;
  lat: number;
  lon: number;
  /** gap: fixes too far apart; no candidates: no road near the fix; no route: no route fits the OBD distance. */
  reason: "gap" | "no candidates" | "no route";
  /** gap: fixes in it that don't meet the truth rule (worse than 10 m, or Wi-Fi/cell): degraded GNSS rather than none. */
  degradedFixes?: number;
}

export interface TruthMatch {
  points: TruthPoint[];
  legs: TruthLeg[];
  breaks: TruthBreak[];
  /** Clean fixes considered. */
  fixes: number;
  /** Truth position at any time between two points of a chain (interpolated by OBD distance), else null. */
  at(tUs: number): { edge: EdgeId; dir: 1 | -1; alongM: number } | null;
}

interface State {
  edge: RoadEdge;
  dir: 1 | -1;
  alongM: number;
  distanceM: number;
  logEmission: number;
}

interface Route {
  lengthM: number;
  penaltyM: number;
  path: { edge: EdgeId; dir: 1 | -1 }[];
}

const angleDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const edgeLength = (e: RoadEdge) => e.cum[e.cum.length - 1];

/** Cumulative OBD distance at any time (speed held up to 2.5 s, like the navigator). */
export function obdOdometer(trip: TripLog): (tUs: number) => number {
  const t: number[] = [];
  const d: number[] = [];
  let total = 0;
  const s = trip.obdSpeed;
  for (let k = 0; k < s.length; k++) {
    if (k > 0) total += s[k - 1].speedMps * Math.min(2.5, (s[k].tUs - s[k - 1].tUs) / 1e6);
    t.push(s[k].tUs);
    d.push(total);
  }
  return (tUs) => {
    if (!t.length || tUs <= t[0]) return 0;
    let lo = 0;
    let hi = t.length - 1;
    if (tUs >= t[hi]) return d[hi];
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (t[mid] <= tUs) lo = mid;
      else hi = mid;
    }
    return d[lo] + s[lo].speedMps * Math.min(2.5, (tUs - t[lo]) / 1e6);
  };
}

export function matchTruth(trip: TripLog, graph: TiledRoadGraph, options: Partial<TruthOptions> = {}): TruthMatch {
  const o = { ...DEFAULT_TRUTH_OPTIONS, ...options };
  const odo = obdOdometer(trip);
  const fixes = trip.gnss.filter((f) => isSatelliteFix(f) && f.hAccM <= o.maxFixAccuracyM);
  const points: TruthPoint[] = [];
  const legs: TruthLeg[] = [];
  const breaks: TruthBreak[] = [];
  if (!fixes.length) return { points, legs, breaks, fixes: 0, at: () => null };

  let frame = new LocalFrame(fixes[0]);
  graph.setFrame(frame);

  const candidates = (fix: GnssFix): State[] => {
    let [e, n] = frame.toEnu(fix);
    if (Math.hypot(e, n) > o.reanchorM) {
      frame = new LocalFrame(fix);
      graph.setFrame(frame);
      [e, n] = [0, 0];
    }
    const moving = (fix.speedMps ?? 0) >= o.headingMinSpeedMps && fix.courseRad !== undefined;
    const out: State[] = [];
    for (const near of graph.edgesNear(e, n, o.candidateRadiusM).slice(0, o.maxCandidates)) {
      for (const dir of [1, -1] as const) {
        let logEmission = -0.5 * (near.distanceM / o.positionSigmaM) ** 2;
        if (moving) {
          const heading = dir === 1 ? near.headingRad : near.headingRad + Math.PI;
          logEmission += -0.5 * (angleDiff(fix.courseRad!, heading) / o.headingSigmaRad) ** 2;
        }
        out.push({ edge: near.edge, dir, alongM: near.alongM, distanceM: near.distanceM, logEmission });
      }
    }
    return out;
  };

  // Routes from one state to every target within maxLen (Dijkstra over directed edges).
  const routes = (from: State, targets: State[], maxLen: number): (Route | null)[] => {
    const out: (Route | null)[] = targets.map(() => null);
    const better = (k: number, r: Route) => {
      const cur = out[k];
      if (!cur || r.lengthM + r.penaltyM < cur.lengthM + cur.penaltyM) out[k] = r;
    };
    const len = edgeLength(from.edge);
    targets.forEach((t, k) => {
      if (t.edge.id !== from.edge.id) return;
      const ahead = (t.alongM - from.alongM) * from.dir;
      if (t.dir === from.dir && ahead >= -o.jitterM) {
        better(k, { lengthM: Math.abs(ahead), penaltyM: 0, path: [{ edge: from.edge.id, dir: from.dir }] });
      } else if (t.dir !== from.dir) {
        // Turned round on the edge.
        better(k, { lengthM: Math.abs(t.alongM - from.alongM), penaltyM: o.uTurnM, path: [{ edge: t.edge.id, dir: t.dir }] });
      }
    });
    const byEdge = new Map<string, number[]>();
    targets.forEach((t, k) => {
      const key = `${t.edge.id}:${t.dir}`;
      byEdge.set(key, [...(byEdge.get(key) ?? []), k]);
    });
    // Open set: directed edges entered at their start node; dist = length driven to get there.
    interface Node { edge: EdgeId; dir: 1 | -1; lengthM: number; penaltyM: number; path: { edge: EdgeId; dir: 1 | -1 }[] }
    const best = new Map<string, number>();
    const open: Node[] = [];
    const remaining = from.dir === 1 ? len - from.alongM : from.alongM;
    const push = (n: Node) => {
      const key = `${n.edge}:${n.dir}`;
      const cost = n.lengthM + n.penaltyM;
      if (n.lengthM > maxLen || (best.get(key) ?? Infinity) <= cost) return;
      best.set(key, cost);
      open.push(n);
    };
    const expand = (edge: EdgeId, dir: 1 | -1, lengthM: number, penaltyM: number, path: Node["path"]) => {
      const node = graph.node(dir === 1 ? graph.edge(edge).to : graph.edge(edge).from);
      for (const x of graph.exits(edge, dir)) {
        const penalty =
          (x.againstOneway ? o.againstOnewayM : 0) + (x.restricted ? o.restrictedM : 0) + (x.uTurn && node.edges.length > 1 ? o.uTurnM : 0);
        push({ edge: x.edge, dir: x.dir, lengthM, penaltyM: penaltyM + penalty, path: [...path, { edge: x.edge, dir: x.dir }] });
      }
    };
    expand(from.edge.id, from.dir, remaining, 0, [{ edge: from.edge.id, dir: from.dir }]);
    while (open.length) {
      let i = 0;
      for (let j = 1; j < open.length; j++) if (open[j].lengthM + open[j].penaltyM < open[i].lengthM + open[i].penaltyM) i = j;
      const n = open.splice(i, 1)[0];
      if ((best.get(`${n.edge}:${n.dir}`) ?? Infinity) < n.lengthM + n.penaltyM) continue;
      const e = graph.edge(n.edge);
      for (const k of byEdge.get(`${n.edge}:${n.dir}`) ?? []) {
        const t = targets[k];
        better(k, { lengthM: n.lengthM + (n.dir === 1 ? t.alongM : edgeLength(e) - t.alongM), penaltyM: n.penaltyM, path: n.path });
      }
      expand(n.edge, n.dir, n.lengthM + edgeLength(e), n.penaltyM, n.path);
    }
    return out.map((r) => (r && r.lengthM <= maxLen ? r : null));
  };

  // Viterbi over chains of fixes; a chain ends at a gap, a fix with no road, or no fitting route.
  let chain: { fix: GnssFix; states: State[]; score: number[]; back: { prev: number; route: Route | null }[] }[] = [];
  const finish = () => {
    if (!chain.length) return;
    let k = chain.at(-1)!.score.reduce((bi, v, i, a) => (v > a[bi] ? i : bi), 0);
    const picked: { state: State; route: Route | null; fix: GnssFix }[] = [];
    for (let i = chain.length - 1; i >= 0; i--) {
      const step = chain[i];
      picked.unshift({ state: step.states[k], route: step.back[k].route, fix: step.fix });
      k = step.back[k].prev;
    }
    const base = points.length;
    picked.forEach((p, i) => {
      points.push({ tUs: p.fix.tUs, edge: p.state.edge.id, dir: p.state.dir, alongM: p.state.alongM, distanceM: p.state.distanceM });
      if (i > 0 && p.route) {
        legs.push({ from: base + i - 1, to: base + i, path: p.route.path, lengthM: p.route.lengthM, penaltyM: p.route.penaltyM, obdM: odo(p.fix.tUs) - odo(picked[i - 1].fix.tUs) });
      }
    });
    chain = [];
  };

  let lastFixUs = -Infinity;
  for (const fix of fixes) {
    const states = candidates(fix);
    const prev = chain.at(-1);
    if (!states.length) {
      finish();
      const open = breaks.at(-1);
      if (open?.reason === "no candidates" && open.t1Us === lastFixUs) {
        open.t1Us = fix.tUs;
        open.fixes++;
      } else {
        breaks.push({ t0Us: fix.tUs, t1Us: fix.tUs, fixes: 1, lat: fix.lat, lon: fix.lon, reason: "no candidates" });
      }
      lastFixUs = fix.tUs;
      continue;
    }
    lastFixUs = fix.tUs;
    if (prev && (fix.tUs - prev.fix.tUs) / 1e6 > o.maxGapS) {
      finish();
      const degradedFixes = trip.gnss.filter((f) => f.tUs > prev.fix.tUs && f.tUs < fix.tUs).length;
      breaks.push({ t0Us: prev.fix.tUs, t1Us: fix.tUs, fixes: 0, lat: fix.lat, lon: fix.lon, reason: "gap", degradedFixes });
    }
    const last = chain.at(-1);
    if (!last) {
      chain.push({ fix, states, score: states.map((s) => s.logEmission), back: states.map(() => ({ prev: -1, route: null })) });
      continue;
    }
    const obd = Math.max(0, odo(fix.tUs) - odo(last.fix.tUs));
    const beta = o.betaBaseM + o.betaShare * obd;
    const maxLen = obd * o.routeFactor + o.routeSlackM;
    const score = states.map(() => -Infinity);
    const back = states.map(() => ({ prev: -1, route: null as Route | null }));
    last.states.forEach((p, pi) => {
      if (last.score[pi] === -Infinity) return;
      routes(p, states, maxLen).forEach((r, ci) => {
        if (!r) return;
        const s = last.score[pi] - (Math.abs(r.lengthM - obd) + r.penaltyM) / beta + states[ci].logEmission;
        if (s > score[ci]) {
          score[ci] = s;
          back[ci] = { prev: pi, route: r };
        }
      });
    });
    if (score.every((s) => s === -Infinity)) {
      finish();
      breaks.push({ t0Us: last.fix.tUs, t1Us: fix.tUs, fixes: 0, lat: fix.lat, lon: fix.lon, reason: "no route" });
      chain.push({ fix, states, score: states.map((s) => s.logEmission), back: states.map(() => ({ prev: -1, route: null })) });
      continue;
    }
    chain.push({ fix, states, score, back });
  }
  finish();

  const at = (tUs: number) => {
    const leg = legs.find((l) => points[l.from].tUs <= tUs && tUs <= points[l.to].tUs);
    if (!leg) return null;
    const a = points[leg.from];
    const b = points[leg.to];
    const span = odo(b.tUs) - odo(a.tUs);
    const f = span > 0.5 ? (odo(tUs) - odo(a.tUs)) / span : (tUs - a.tUs) / Math.max(1, b.tUs - a.tUs);
    return positionOnLeg(graph, leg, a, b, Math.min(1, Math.max(0, f)) * leg.lengthM);
  };
  return { points, legs, breaks, fixes: fixes.length, at };
}

/** The point `distanceM` along a leg's route. */
function positionOnLeg(graph: TiledRoadGraph, leg: TruthLeg, a: TruthPoint, b: TruthPoint, distanceM: number) {
  const path = leg.path;
  if (path.length === 1) {
    // Along one edge (possibly back a little, or turned round on it): straight from a to b.
    const along = a.alongM + Math.sign(b.alongM - a.alongM) * Math.min(distanceM, Math.abs(b.alongM - a.alongM));
    return { edge: b.edge, dir: b.dir, alongM: along };
  }
  let left = distanceM;
  for (let i = 0; i < path.length; i++) {
    const { edge, dir } = path[i];
    const len = edgeLength(graph.edge(edge));
    const start = i === 0 ? a.alongM : dir === 1 ? 0 : len;
    const end = i === path.length - 1 ? b.alongM : dir === 1 ? len : 0;
    const span = Math.abs(end - start);
    if (left <= span || i === path.length - 1) return { edge, dir, alongM: start + dir * Math.min(left, span) };
    left -= span;
  }
  return { edge: b.edge, dir: b.dir, alongM: b.alongM };
}

/**
 * Same road for the metrics (§10.1): the same edge, or an edge that shares a node with the truth
 * edge while the truth position is within `toleranceM` of that node (junction tolerance).
 */
export function isSameRoad(graph: Pick<RoadGraph, "edge">, truth: { edge: EdgeId; alongM: number }, edge: EdgeId, toleranceM = 15): boolean {
  if (truth.edge === edge) return true;
  const t = graph.edge(truth.edge);
  const e = graph.edge(edge);
  const len = edgeLength(t);
  return (
    ((t.from === e.from || t.from === e.to) && truth.alongM <= toleranceM) ||
    ((t.to === e.from || t.to === e.to) && len - truth.alongM <= toleranceM)
  );
}

/** Position and travel heading (clockwise from north) of a truth position on its edge. */
export function truthPose(graph: Pick<RoadGraph, "edge">, at: { edge: EdgeId; dir: 1 | -1; alongM: number }): { lat: number; lon: number; headingRad: number } {
  const { cum, lonLat, xy } = graph.edge(at.edge);
  let i = 0;
  while (i < cum.length - 2 && (cum[i + 1] < at.alongM || cum[i + 1] <= cum[i])) i++;
  const f = cum[i + 1] > cum[i] ? Math.max(0, Math.min(1, (at.alongM - cum[i]) / (cum[i + 1] - cum[i]))) : 0;
  const heading = Math.atan2(xy[2 * i + 2] - xy[2 * i], xy[2 * i + 3] - xy[2 * i + 1]) + (at.dir === 1 ? 0 : Math.PI);
  return {
    lon: lonLat[2 * i] + f * (lonLat[2 * i + 2] - lonLat[2 * i]),
    lat: lonLat[2 * i + 1] + f * (lonLat[2 * i + 3] - lonLat[2 * i + 1]),
    headingRad: Math.atan2(Math.sin(heading), Math.cos(heading)),
  };
}

/** Geometry of a leg's route as [lon, lat] pairs (for GeoJSON). */
export function legCoordinates(graph: TiledRoadGraph, leg: TruthLeg, a: TruthPoint, b: TruthPoint): [number, number][] {
  const out: [number, number][] = [];
  const slice = (edge: RoadEdge, from: number, to: number) => {
    const pts = sliceAlong(edge, Math.min(from, to), Math.max(from, to));
    if (from > to) pts.reverse();
    for (const p of pts) out.push(p);
  };
  leg.path.forEach(({ edge: id, dir }, i) => {
    const edge = graph.edge(id);
    const len = edgeLength(edge);
    const start = i === 0 ? a.alongM : dir === 1 ? 0 : len;
    const end = i === leg.path.length - 1 ? b.alongM : dir === 1 ? len : 0;
    slice(edge, start, end);
  });
  return out;
}

/** An edge's geometry from `from` to `to` m along it (from ≤ to), as [lon, lat] pairs. */
export function sliceAlong(edge: RoadEdge, from: number, to: number): [number, number][] {
  const { cum, lonLat } = edge;
  const point = (d: number): [number, number] => {
    let i = 0;
    while (i < cum.length - 2 && cum[i + 1] < d) i++;
    const f = cum[i + 1] > cum[i] ? (d - cum[i]) / (cum[i + 1] - cum[i]) : 0;
    return [lonLat[2 * i] + f * (lonLat[2 * i + 2] - lonLat[2 * i]), lonLat[2 * i + 1] + f * (lonLat[2 * i + 3] - lonLat[2 * i + 1])];
  };
  const out: [number, number][] = [point(from)];
  for (let i = 1; i < cum.length - 1; i++) if (cum[i] > from && cum[i] < to) out.push([lonLat[2 * i], lonLat[2 * i + 1]]);
  out.push(point(to));
  return out;
}
