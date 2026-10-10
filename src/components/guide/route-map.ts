import type { IconName } from "@/components/ui/icon";
import type { Strings } from "@/i18n/en";
import type { Coordinate } from "@/nav/geo";
import { LocalFrame } from "@/nav/geo/local-frame";
import { RoadClass } from "@/nav/mapmatch/graph/format";
import { MemoryRoadGraph, type MemoryWay } from "@/nav/mapmatch/graph/memory-graph";
import { routeManeuvers } from "@/nav/routing/maneuvers";
import { planRoute } from "@/nav/routing/router";
import type { RouteSnapshot } from "@/services/navigation/route-service";

import type { Box } from "./mini-map";

export interface Point {
  x: number;
  y: number;
}

// The drawn map is a real little road network: the app's router plans on it (ROUTING-SPEC §5) and the route banner
// shows its maneuvers. One map unit is 5 m, north up.
export const W = 358;
export const H = 520;
/**
 * The band under the route banner (to ~140 on the lessons' maps): only blocks and the vertical roads running on, no
 * cross street and no destination, so a route never runs where the banner hides it.
 */
export const TOP = 120;
const METRES_PER_UNIT = 5;
const frame = new LocalFrame({ lat: 50.45, lon: 30.52 });
export const toCoordinate = (p: Point): Coordinate => frame.toCoordinate(p.x * METRES_PER_UNIT, -p.y * METRES_PER_UNIT);
const toPoint = (c: Coordinate): Point => {
  const [e, n] = frame.toEnu(c);
  return { x: e / METRES_PER_UNIT, y: -n / METRES_PER_UNIT };
};

const VERTICAL: { x: number; cls: number }[] = [
  { x: 100, cls: RoadClass.primary },
  { x: 280, cls: RoadClass.residential },
];
const HORIZONTAL: { y: number; cls: number }[] = [
  { y: TOP + 90, cls: RoadClass.residential },
  { y: TOP + 200, cls: RoadClass.primary },
  { y: TOP + 305, cls: RoadClass.residential },
];
const WAYS: MemoryWay[] = [
  ...VERTICAL.map(({ x, cls }) => ({
    cls,
    points: [-10, ...HORIZONTAL.map((h) => h.y), H + 10].map((y) => toCoordinate({ x, y })),
  })),
  ...HORIZONTAL.map(({ y, cls }) => ({
    cls,
    points: [-10, ...VERTICAL.map((v) => v.x), W + 10].map((x) => toCoordinate({ x, y })),
  })),
];
const graph = new MemoryRoadGraph(frame, WAYS);
/** Along the road nearest to `p`, clockwise from up: north on a north–south road, east on a west–east one. */
export function roadHeadingDeg(p: Point): number {
  const toVertical = Math.min(...VERTICAL.map((v) => Math.abs(p.x - v.x)));
  const toHorizontal = Math.min(...HORIZONTAL.map((h) => Math.abs(p.y - h.y)));
  return toVertical <= toHorizontal ? 0 : 90;
}

export const roads = (cls: number) =>
  [
    ...VERTICAL.filter((v) => v.cls === cls).map((v) => `M${v.x} -10 V${H + 10}`),
    ...HORIZONTAL.filter((h) => h.cls === cls).map((h) => `M-10 ${h.y} H${W + 10}`),
  ].join(" ");
export const BLOCKS: Box[] = [
  { x: 14, y: TOP + 104, w: 72, h: 82 },
  { x: 14, y: TOP + 214, w: 72, h: 77 },
  { x: 14, y: TOP + 319, w: 72, h: 90 },
  { x: 114, y: TOP + 214, w: 152, h: 77 },
  { x: 114, y: TOP + 319, w: 152, h: 90 },
  { x: 294, y: TOP + 104, w: 70, h: 82 },
  { x: 294, y: TOP + 214, w: 70, h: 77 },
  { x: 294, y: TOP + 319, w: 70, h: 90 },
  { x: 14, y: TOP - 10, w: 72, h: 86 },
  { x: 294, y: TOP - 10, w: 70, h: 86 },
  // Under the banner.
  { x: 14, y: -10, w: 72, h: TOP - 24 },
  { x: 114, y: -10, w: 152, h: TOP - 24 },
  { x: 294, y: -10, w: 70, h: TOP - 24 },
];
export const PARKS: Box[] = [
  { x: 114, y: TOP + 104, w: 152, h: 82 },
  { x: 114, y: TOP - 10, w: 152, h: 86 },
];
/** Where the car stands at the start: on the main road, facing up it. */
export const CAR: Point = { x: 100, y: TOP + 350 };
/** Saved places, as the route screen lists them. */
export const PLACES: { icon: IconName; name: keyof Strings; at: Point }[] = [
  { icon: "home", name: "placeHome", at: { x: 320, y: TOP + 50 } },
  { icon: "work", name: "placeWork", at: { x: 30, y: TOP + 255 } },
];

export interface Planned {
  snapshot: RouteSnapshot;
  path: string;
  /** For the arrival clock. */
  nowMs: number;
}

/** Plan from the dot to `to` with the app's router and maneuvers, as a route snapshot for the real banner. */
export function plan(from: Point, to: Point, facingUp: boolean, planId: number): Planned {
  const destination = toCoordinate(to);
  const result = planRoute(graph, frame, { ...toCoordinate(from), ...(facingUp ? { headingRad: 0 } : {}) }, destination);
  const nowMs = Date.now();
  if (result.status !== "done") {
    return { snapshot: { destination, status: "failed", failure: result.reason, planId, replanning: false }, path: "", nowMs };
  }
  const points = result.plan.coordinates.map(toPoint);
  return {
    snapshot: {
      destination,
      status: "active",
      planId,
      plan: result.plan,
      maneuvers: routeManeuvers(graph, result.plan),
      replanning: false,
    },
    path: points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" "),
    nowMs,
  };
}

