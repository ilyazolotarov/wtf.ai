import { readFileSync } from "node:fs";
import path from "node:path";

import { haversineM } from "@/nav/geo";
import { LocalFrame } from "@/nav/geo/local-frame";
import { bufferByteSource } from "@/nav/mapmatch/graph/byte-source";
import { TiledRoadGraph } from "@/nav/mapmatch/graph/road-graph";
import { planRoute, type RouteStart } from "@/nav/routing/router";
import { elapsedS, insertionIndex, joinPlans, planTrip, sideOf, tripManeuvers, TripSearch } from "@/nav/routing/trip";

// net.graph.bin (router.test.ts): 1 (0,0) — 2 (1,0) — 3 — 4 (3,0) east–west, 2 — 6 (1,−1) south, 5 (1,1) north of 2;
// a separate road ~1.1 km north, connected to nothing.
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
const point = (key: string, x: number, y: number) => ({ key, ...at(x, y) });

describe("trips with stops (STOPS-SPEC §4)", () => {
  test("a stop on the way: two legs joined into one plan, the stop a point along it", () => {
    const g = graph();
    const from = { ...at(0.2, 0, 90), speedMps: 10 };
    const r = planTrip(g, frame, from, [point("s1", 1, -0.5), point("destination", 2.5, 0)]);
    if (r.status !== "done") throw new Error(r.status);
    const { plan, legs } = r;
    expect(legs).toHaveLength(2);
    expect(plan.lengthM).toBeCloseTo(legs[0].lengthM + legs[1].lengthM);
    expect(plan.durationS).toBeCloseTo(legs[0].durationS + legs[1].durationS);
    expect(plan.stops).toHaveLength(1);
    const stop = plan.stops![0];
    expect(stop.key).toBe("s1");
    expect(stop.atM).toBeCloseTo(legs[0].lengthM);
    expect(stop.atS).toBeCloseTo(legs[0].durationS);
    expect(haversineM(stop, at(1, -0.5))).toBeLessThan(5);
    // The polyline runs through the stop and on to the destination.
    expect(plan.coordinates.some((c) => haversineM(c, at(1, -0.5)) < 5)).toBe(true);
    expect(haversineM(plan.coordinates.at(-1)!, at(2.5, 0))).toBeLessThan(5);
    expect(plan.legs).toHaveLength(legs[0].legs.length + legs[1].legs.length);
  });

  test("instructions: one depart, a stop in place of the first leg's arrival and the next leg's depart, arrive last", () => {
    const g = graph();
    const r = planTrip(g, frame, { ...at(0.2, 0, 90), speedMps: 10 }, [point("s1", 1, -0.5), point("destination", 2.5, 0)]);
    if (r.status !== "done") throw new Error(r.status);
    const m = tripManeuvers(g, r.legs, r.plan);
    expect(m.filter((x) => x.kind === "depart")).toHaveLength(1);
    expect(m.filter((x) => x.kind === "arrive")).toHaveLength(1);
    expect(m.at(-1)!.kind).toBe("arrive");
    const stops = m.filter((x) => x.kind === "stop");
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ stop: "s1", atM: r.plan.stops![0].atM });
    // In order along the route.
    for (let i = 1; i < m.length; i++) expect(m[i].atM).toBeGreaterThanOrEqual(m[i - 1].atM);
  });

  test("the leg after a stop leaves as a parked car does: turning back costs the parked turnaround, not the driving one", () => {
    const g = graph();
    const r = planTrip(g, frame, { ...at(0.2, 0, 90), speedMps: 10 }, [point("s1", 1, -0.5), point("destination", 0.5, 0)]);
    if (r.status !== "done") throw new Error(r.status);
    // Arrived heading south on the side road, the destination back north and west: turning round where it stopped.
    const direct = planRoute(g, frame, { ...at(1, -0.5, 180), speedMps: 0 }, at(0.5, 0));
    if (direct.status !== "done") throw new Error(direct.status);
    expect(r.legs[1].durationS).toBeCloseTo(direct.plan.durationS, 0);
  });

  test("a trip without stops is the plain route", () => {
    const g = graph();
    const from = { ...at(0.2, 0, 90), speedMps: 10 };
    const r = planTrip(g, frame, from, [point("destination", 2.5, 0)]);
    const plain = planRoute(g, frame, from, at(2.5, 0));
    if (r.status !== "done" || plain.status !== "done") throw new Error("no route");
    expect(r.plan).toEqual(plain.plan);
    expect(r.plan.stops).toBeUndefined();
  });

  test("a stop with no road route fails the trip, naming its leg", () => {
    const r = planTrip(graph(), frame, { ...at(0.2, 0, 90), speedMps: 10 }, [point("s1", 2, 16.7), point("destination", 2.5, 0)]);
    expect(r).toMatchObject({ status: "failed", leg: 0 });
    const last = planTrip(graph(), frame, { ...at(0.2, 0, 90), speedMps: 10 }, [point("s1", 1, -0.5), point("destination", 2, 16.7)]);
    expect(last).toMatchObject({ status: "failed", leg: 1 });
  });

  test("in slices: the same plan as in one go, the states counted over every leg", () => {
    const points = [point("s1", 1, -0.5), point("s2", 1, 0.5), point("destination", 2.5, 0)];
    const from = { ...at(0.2, 0, 90), speedMps: 10 };
    const whole = planTrip(graph(), frame, from, points);
    const search = new TripSearch(graph(), frame, from, points);
    let r = search.run(3);
    let slices = 1;
    while (r.status === "more") {
      r = search.run(3);
      slices++;
    }
    if (r.status !== "done" || whole.status !== "done") throw new Error("no route");
    expect(slices).toBeGreaterThan(2);
    expect(r.plan.lengthM).toBeCloseTo(whole.plan.lengthM);
    expect(r.plan.stops!.map((s) => s.key)).toEqual(["s1", "s2"]);
    expect(r.stats.states).toBe(whole.stats.states);
  });

  test("side of the road: left or right of the way driven, none on it", () => {
    const a = { lat: 50, lon: 30 };
    const b = { lat: 50, lon: 30.01 }; // east
    expect(sideOf(a, b, { lat: 50.001, lon: 30.01 })).toBe("left");
    expect(sideOf(a, b, { lat: 49.999, lon: 30.01 })).toBe("right");
    expect(sideOf(a, b, { lat: 50.0001, lon: 30.01 })).toBeNull(); // 11 m
    expect(sideOf(b, a, { lat: 50.001, lon: 30 })).toBe("right");
  });

  test("a stop's side is where its place is, driving its leg", () => {
    const g = graph();
    // On the east–west road, a place north of it, driving east: on the left.
    const r = planTrip(g, frame, { ...at(0.1, 0, 90), speedMps: 10 }, [point("s1", 0.3, 0.3), point("destination", 2.5, 0)]);
    if (r.status !== "done") throw new Error(r.status);
    expect(r.plan.stops![0].side).toBe("left");
  });

  test("time along the plan: each leg at its own pace", () => {
    const legs = [
      { legs: [], lengthM: 1000, durationS: 100, coordinates: [{ lat: 50, lon: 30 }, { lat: 50, lon: 30.014 }], offRoadM: { start: 0, end: 0 } },
      { legs: [], lengthM: 1000, durationS: 300, coordinates: [{ lat: 50, lon: 30.014 }, { lat: 50, lon: 30.028 }], offRoadM: { start: 0, end: 0 } },
    ];
    const plan = joinPlans(legs, [point("s1", 0, 0), point("destination", 0, 0)]);
    expect(plan.coordinates).toHaveLength(3);
    expect(elapsedS(plan, 500)).toBeCloseTo(50);
    expect(elapsedS(plan, 1000)).toBeCloseTo(100);
    expect(elapsedS(plan, 1500)).toBeCloseTo(250);
    expect(elapsedS(plan, 2000)).toBeCloseTo(400);
    expect(elapsedS({ ...legs[0], stops: undefined }, 250)).toBeCloseTo(25);
  });

  test("a new stop goes where it adds the least straight-line distance", () => {
    const car = { lat: 50, lon: 30 };
    const dest = { lat: 50, lon: 30.1 };
    const stops = [{ lat: 50, lon: 30.05 }];
    expect(insertionIndex(car, stops, dest, { lat: 50.001, lon: 30.02 })).toBe(0);
    expect(insertionIndex(car, stops, dest, { lat: 50.001, lon: 30.08 })).toBe(1);
    expect(insertionIndex(car, [], dest, { lat: 50.001, lon: 30.08 })).toBe(0);
  });
});
