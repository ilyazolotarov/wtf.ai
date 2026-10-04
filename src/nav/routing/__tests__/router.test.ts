import { readFileSync } from "node:fs";
import path from "node:path";

import { haversineM } from "@/nav/geo";
import { LocalFrame } from "@/nav/geo/local-frame";
import { bufferByteSource } from "@/nav/mapmatch/graph/byte-source";
import { TiledRoadGraph } from "@/nav/mapmatch/graph/road-graph";
import { DEFAULT_ROUTE_COSTS, turnSeconds } from "@/nav/routing/cost";
import { planRoute, RouteSearch, type RoutePlan, type RouteStart } from "@/nav/routing/router";

// net.graph.bin (tools/tiles/tests/test_graph.py): a grid of D = 0.0006° around (LAT0, LON0).
//
//        5                    101 = 1–2 primary, 102 = 2–4 primary, 103 = 5–2 residential, 104 = 2–6 residential,
//        |                    105 = 4–8 residential, one-way 8 → 4. no_left_turn 101 → 103 at 2; only_straight_on
//  1 --- 2 --- 3 --- 4        103 → 104 at 2. 108 = a parking-aisle loop at (0–1, 3–4), connected to nothing.
//        |           |        A separate long road 160–161 at LAT0 + 0.01, ~1.1 km north, not connected either.
//        6           8
const FIXTURE = readFileSync(path.join(__dirname, "../../mapmatch/__fixtures__/net.graph.bin"));
const LON0 = 30.75;
const LAT0 = 51.52;
const D = 0.0006;
const frame = new LocalFrame({ lat: LAT0, lon: LON0 });
const graph = () => new TiledRoadGraph(bufferByteSource(new Uint8Array(FIXTURE)), frame);
const at = (x: number, y: number, headingDeg?: number): RouteStart => ({
  lat: LAT0 + y * D,
  lon: LON0 + x * D,
  ...(headingDeg === undefined ? {} : { headingRad: (headingDeg * Math.PI) / 180 }),
});
const DEG = Math.PI / 180;

function plan(from: RouteStart, to: RouteStart, g = graph()): RoutePlan & { ways: number[] } {
  const r = planRoute(g, frame, from, to);
  if (r.status !== "done") throw new Error(`no route: ${r.reason}`);
  return { ...r.plan, ways: r.plan.legs.map((l) => g.edge(l.edge).wayId) };
}

describe("cost model", () => {
  test("turns: straight free, left costs more than right (right-hand traffic), sharp more still", () => {
    const c = DEFAULT_ROUTE_COSTS;
    expect(turnSeconds(10 * DEG, c)).toBe(0);
    expect(turnSeconds(90 * DEG, c)).toBe(c.rightS);
    expect(turnSeconds(-90 * DEG, c)).toBe(c.leftS);
    expect(c.leftS).toBeGreaterThan(c.rightS);
    expect(turnSeconds(150 * DEG, c)).toBe(c.sharpRightS);
    expect(turnSeconds(-150 * DEG, c)).toBe(c.sharpLeftS);
  });
});

describe("planRoute", () => {
  test("straight on through a junction: length, time and the polyline between the two points", () => {
    const from = at(0.5, 0, 90);
    const to = at(2, 0);
    const p = plan(from, to);
    expect(p.ways).toEqual([101, 102]);
    const metres = haversineM(from, to);
    expect(p.lengthM).toBeCloseTo(metres, -1);
    // 60 km/h on primary roads, plus 2 s for passing node 2 (four roads meet there).
    expect(p.durationS).toBeCloseTo(p.lengthM / (60 / 3.6) + DEFAULT_ROUTE_COSTS.junctionS, 0);
    expect(haversineM(p.coordinates[0], from)).toBeLessThan(1);
    expect(haversineM(p.coordinates.at(-1)!, to)).toBeLessThan(1);
    expect(p.offRoadM.start).toBeLessThan(1);
    expect(p.offRoadM.end).toBeLessThan(1);
  });

  test("never takes a restricted turn: no left from 101 onto 103, so it turns around somewhere", () => {
    const p = plan(at(0.5, 0, 90), at(1, 0.5));
    expect(p.ways[0]).toBe(101);
    expect(p.ways[1]).not.toBe(103);
    expect(p.ways.at(-1)).toBe(103);
    // The detour turns around at a dead end: the same way twice, one leg each direction.
    const uTurn = p.legs.findIndex((l, i) => i > 0 && l.edge === p.legs[i - 1].edge && l.dir !== p.legs[i - 1].dir);
    expect(uTurn).toBeGreaterThan(0);
    expect(p.durationS).toBeGreaterThan(DEFAULT_ROUTE_COSTS.uTurnS);
  });

  test("only_straight_on: from 103 at node 2 the only way on is straight to 104", () => {
    const p = plan(at(1, 0.5, 180), at(0.5, 0));
    expect(p.ways.slice(0, 2)).toEqual([103, 104]);
    expect(p.ways.at(-1)).toBe(101);
  });

  test("one-ways: 105 runs 8 → 4 only, so a car on it heading south still starts north", () => {
    const p = plan(at(3, -0.5, 180), at(2, 0));
    expect(p.ways).toEqual([105, 102]);
    expect(p.legs[0].dir).toBe(-1); // against the way's geometry (4 → 8), with its one-way
  });

  test("a destination ahead on the same road is one leg; behind, the car turns around", () => {
    const ahead = plan(at(0.2, 0, 90), at(0.8, 0));
    expect(ahead.legs).toHaveLength(1);
    expect(ahead.lengthM).toBeCloseTo(0.6 * D * 111_320 * Math.cos(LAT0 * DEG), -1);
    // Behind: turning on the spot costs 60 s; here driving on to turn at the dead end at node 4 is cheaper.
    const behind = plan(at(0.8, 0, 90), at(0.2, 0));
    expect(behind.ways.at(-1)).toBe(101);
    expect(behind.legs.at(-1)!.dir).toBe(-1);
    expect(behind.durationS).toBeGreaterThan(DEFAULT_ROUTE_COSTS.uTurnS);
    // Without a heading, either direction starts free: one leg, west.
    const free = plan(at(0.8, 0), at(0.2, 0));
    expect(free.legs).toHaveLength(1);
    expect(free.durationS).toBeLessThan(5);
  });

  test("a destination on a road island ends on the nearest connected road, without the penalty in its time", () => {
    // The parking-aisle loop 108 isn't connected to anything; road 103 runs 2 → 5, ~70 m east of it.
    const p = plan(at(0.5, 0, 90), at(0, 3.5));
    expect(p.offRoadM.end).toBeGreaterThan(30);
    expect(p.ways).not.toContain(108);
    expect(p.durationS).toBeLessThan(300);
  });

  test("ends on unconnected networks: no route, found without searching", () => {
    const r = planRoute(graph(), frame, at(0.5, 0, 90), { lat: LAT0 + 0.01, lon: LON0 + 0.03 });
    expect(r).toMatchObject({ status: "failed", reason: "no-route" });
    expect(r.stats.states).toBe(0);
  });

  test("no road near the destination", () => {
    const r = planRoute(graph(), frame, at(0.5, 0, 90), { lat: LAT0 - 0.05, lon: LON0 });
    expect(r).toMatchObject({ status: "failed", reason: "no-road-at-destination" });
  });
});

describe("RouteSearch", () => {
  test("in slices: the same route as in one go", () => {
    const g = graph();
    const search = new RouteSearch(g, frame, at(0.5, 0, 90), at(1, 0.5));
    let result = search.run(1);
    let slices = 1;
    while (result.status === "more") {
      result = search.run(1);
      slices++;
    }
    expect(slices).toBeGreaterThan(2);
    expect(result.status).toBe("done");
    const once = planRoute(graph(), frame, at(0.5, 0, 90), at(1, 0.5));
    expect(result.status === "done" && once.status === "done" && result.plan.legs).toEqual(once.status === "done" && once.plan.legs);
    // Finished searches answer the same again.
    expect(search.run()).toBe(result);
  });
});
