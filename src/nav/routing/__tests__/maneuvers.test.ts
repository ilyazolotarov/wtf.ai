import { readFileSync } from "node:fs";
import path from "node:path";

import { LocalFrame } from "@/nav/geo/local-frame";
import { bufferByteSource } from "@/nav/mapmatch/graph/byte-source";
import type { Exit, RoadEdge, RoadGraph, RoadNode } from "@/nav/mapmatch/graph/road-graph";
import { TiledRoadGraph } from "@/nav/mapmatch/graph/road-graph";
import { routeManeuvers } from "@/nav/routing/maneuvers";
import { planRoute, type RoutePlan, type RouteStart } from "@/nav/routing/router";

// The fixture network (router.test.ts): 101 = 1–2 east, 102 = 2–4 east, 103 = 5–2 from the north, 104 = 2–6 south;
// a roundabout 106 (10–11–12–10) joined at 11 by 107 from node 13 in the east.
const FIXTURE = readFileSync(path.join(__dirname, "../../mapmatch/__fixtures__/net.graph.bin"));
const LON0 = 30.75;
const LAT0 = 51.52;
const D = 0.0006;
const frame = new LocalFrame({ lat: LAT0, lon: LON0 });
const at = (x: number, y: number, headingDeg?: number): RouteStart => ({
  lat: LAT0 + y * D,
  lon: LON0 + x * D,
  ...(headingDeg === undefined ? {} : { headingRad: (headingDeg * Math.PI) / 180 }),
});
const DEG = Math.PI / 180;

function maneuvers(from: RouteStart, to: RouteStart) {
  const graph = new TiledRoadGraph(bufferByteSource(new Uint8Array(FIXTURE)), frame);
  const r = planRoute(graph, frame, from, to);
  if (r.status !== "done") throw new Error(r.reason);
  return { plan: r.plan, list: routeManeuvers(graph, r.plan) };
}

describe("routeManeuvers", () => {
  test("straight through a junction: nothing between depart and arrive", () => {
    const { plan, list } = maneuvers(at(0.5, 0, 90), at(2, 0));
    expect(list.map((m) => m.kind)).toEqual(["depart", "arrive"]);
    expect(list[1].atM).toBeCloseTo(plan.lengthM, 6);
  });

  test("a right turn at node 2, at its distance from the start", () => {
    const { list } = maneuvers(at(0.5, 0, 90), at(1, -0.5));
    expect(list.map((m) => m.kind)).toEqual(["depart", "right", "arrive"]);
    expect(list[1].atM).toBeCloseTo(0.5 * D * 111_320 * Math.cos(LAT0 * DEG), -1);
    expect(list[1].lon).toBeCloseTo(LON0 + D, 6);
    expect(list[1].turnRad).toBeCloseTo(Math.PI / 2, 1);
  });

  test("the detour around a banned left turn has its U-turn", () => {
    const { list } = maneuvers(at(0.5, 0, 90), at(1, 0.5));
    expect(list.map((m) => m.kind)).toContain("u-turn");
  });

  test("a roundabout is one maneuver at its entry, with the exit to take", () => {
    // On 107 heading west, to a point behind: round the roundabout and back out the way in (its only exit).
    const { plan, list } = maneuvers(at(6.6, 0, 270), at(6.8, 0));
    expect(list.map((m) => m.kind)).toEqual(["depart", "roundabout", "arrive"]);
    expect(list[1]).toMatchObject({ exit: 1 });
    expect(list[1].lon).toBeCloseTo(LON0 + 6 * D, 6); // node 11
    expect(plan.legs.length).toBeGreaterThan(2);
  });

  test("fork: the straightest way with another close to it is keep left / keep right", () => {
    // A three-edge stand-in: arriving on 1, on along 2 (10° right) or 3 (30° right).
    const edge = (id: number): RoadEdge => ({
      id, wayId: id, from: 10 * id, to: 10 * id + 1, lengthM: 100, cls: 2, oneway: 0, flags: 0,
      lonLat: new Float64Array([0, 0, 0, 0]), xy: new Float64Array([0, 0, 0, 100]), cum: new Float64Array([0, 100]),
    });
    const node = (id: number): RoadNode => ({ id, lat: 50, lon: 30, e: 0, n: 0, flags: 0, edges: [] });
    const exit = (id: number, deg: number): Exit => ({ edge: id, dir: 1, turnRad: deg * DEG, againstOneway: false, restricted: false, uTurn: false });
    const graph = { edge, node, exits: () => [exit(2, 10), exit(3, 30)] } as unknown as RoadGraph;
    const plan = (to: number): RoutePlan => ({
      legs: [{ edge: 1, dir: 1, fromM: 0, toM: 100 }, { edge: to, dir: 1, fromM: 0, toM: 100 }],
      lengthM: 200,
      durationS: 12,
      coordinates: [{ lat: 50, lon: 30 }, { lat: 50.001, lon: 30 }],
      offRoadM: { start: 0, end: 0 },
    });
    expect(routeManeuvers(graph, plan(2)).map((m) => m.kind)).toEqual(["depart", "keep-left", "arrive"]);
    expect(routeManeuvers(graph, plan(3)).map((m) => m.kind)).toEqual(["depart", "slight-right", "arrive"]);
  });
});
