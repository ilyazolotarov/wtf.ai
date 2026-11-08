// The emulated adapter's car on the map's roads (emulated-drive.ts, VEHICLE-LINK-SPEC §13): from the dot, along the
// route or the road, re-anchored on its own place when the route changes, the phone's fixes withheld meanwhile.

import { haversineM, type Coordinate } from "@/nav/geo";
import { LocalFrame } from "@/nav/geo/local-frame";
import { Oneway, RoadClass } from "@/nav/mapmatch/graph/format";
import { MemoryRoadGraph } from "@/nav/mapmatch/graph/memory-graph";
import type { PositionEstimate } from "@/nav/position/types";
import type { RouteSnapshot } from "@/services/navigation/route-service";

import { EmulatedDrive } from "../emulated-drive";

const frame = new LocalFrame({ lat: 50.45, lon: 30.52 });
const at = (e: number, n: number) => frame.toCoordinate(e, n);

// A street east 3 km, crossed at 1 km by an avenue north 7 km; off the avenue a one-way east 1 km, nothing past it.
const graph = new MemoryRoadGraph(frame, [
  { cls: RoadClass.residential, points: [at(0, 0), at(1000, 0), at(3000, 0)] },
  { cls: RoadClass.primary, points: [at(1000, -2000), at(1000, -1000), at(1000, 0), at(1000, 5000)] },
  { cls: RoadClass.residential, oneway: Oneway.forward, points: [at(1000, -1000), at(2000, -1000)] },
]);

function setup(opts: { graph?: boolean } = {}) {
  let route: RouteSnapshot | null = null;
  const listeners = new Set<() => void>();
  let dot: PositionEstimate | null = null;
  const notes: string[] = [];
  const gps: ("ignored" | "back")[] = [];
  let truth: (() => Coordinate) | null = null;
  let closed = 0;
  let clock = 0;
  const drive = new EmulatedDrive({
    routes: { getSnapshot: () => route, subscribe: (l) => (listeners.add(l), () => listeners.delete(l)) },
    position: () => dot,
    roads: { near: () => (opts.graph === false ? null : { graph, frame }), close: () => closed++ },
    ignoreGps: (t) => {
      truth = t;
      gps.push(t ? "ignored" : "back");
    },
    note: (t) => notes.push(t),
  });
  const setDot = (p: Partial<PositionEstimate> & Coordinate | null) => {
    dot = p && { accuracyM: 5, source: "fused", trust: "TRUSTED", timestamp: 0, ...p };
  };
  const setRoute = (line: Coordinate[] | null) => {
    route = line && ({ status: "active", planId: 1, plan: { coordinates: line }, replanning: false } as unknown as RouteSnapshot);
    listeners.forEach((l) => l());
  };
  /** `s` seconds on in 50 ms steps (the wheels' frames); the car each step. */
  const run = (s: number, cruiseKph = 60) => {
    const cars = [];
    for (let t = 0; t < s * 1000; t += 50) {
      clock += 50;
      cars.push({ ...drive.at(clock, cruiseKph), ...drive.where()! });
    }
    return cars;
  };
  return { drive, setDot, setRoute, run, notes, gps, truth: () => truth?.(), closed: () => closed, begin: () => drive.begin(clock) };
}

describe("the emulated adapter's car on the roads", () => {
  test("waits for the car's own dot; then drives the road from it, the phone's fixes withheld", () => {
    const h = setup();
    expect(h.begin()).toBe(false);
    h.setDot({ ...at(200, 5), headingRad: Math.PI / 2, waitingForCar: true });
    expect(h.begin()).toBe(false);
    h.setDot({ ...at(200, 5), headingRad: Math.PI / 2 });
    expect(h.begin()).toBe(true);
    expect(h.gps).toEqual(["ignored"]);
    expect(haversineM(h.truth()!, at(200, 0))).toBeLessThan(0.5);
    expect(h.notes.at(-1)).toMatch(/^emulated drive: along the road from the dot/);
    const cars = h.run(60);
    expect(cars[0].speedKph).toBeLessThan(1);
    expect(Math.max(...cars.map((c) => c.speedKph))).toBeCloseTo(60, 0);
    // Straight on over the crossing, east along the street: no turning, never off it.
    expect(Math.max(...cars.map((c) => Math.abs(c.yawRad)))).toBeLessThan(1e-6);
    for (const c of cars) expect(Math.abs(frame.toEnu(c)[1])).toBeLessThan(0.5);
    // The truth is where the car is.
    expect(haversineM(h.truth()!, cars.at(-1)!)).toBeLessThan(0.01);
  });

  test("no road at the dot, or no map: it stands, to be asked again", () => {
    const h = setup();
    h.setDot(at(500, 500));
    expect(h.begin()).toBe(false);
    const n = setup({ graph: false });
    n.setDot(at(200, 0));
    expect(n.begin()).toBe(false);
    expect(n.gps).toEqual([]);
  });

  test("a dead end: it turns back round a bulb and drives on", () => {
    const h = setup();
    h.setDot({ ...at(2500, 0), headingRad: Math.PI / 2 });
    expect(h.begin()).toBe(true);
    const cars = h.run(120);
    let turned = 0;
    for (const c of cars) turned += c.yawRad * 0.05;
    expect(turned).toBeCloseTo(Math.PI, 1);
    expect(Math.max(...cars.map((c) => Math.abs(c.yawRad)))).toBeLessThan(1.2);
    expect(Math.min(...cars.slice(-100).map((c) => c.speedKph))).toBeGreaterThan(30);
    expect(frame.toEnu(cars.at(-1)!)[0]).toBeLessThan(2500);
  });

  test("the road's end (no way on, back against a one-way): it stops there", () => {
    const h = setup();
    h.setDot({ ...at(1500, -1000), headingRad: Math.PI / 2 });
    expect(h.begin()).toBe(true);
    const cars = h.run(120);
    expect(cars.at(-1)).toMatchObject({ arrived: true, speedKph: 0 });
    expect(haversineM(cars.at(-1)!, at(2000, -1000))).toBeLessThan(0.5);
    expect(h.notes.at(-1)).toBe("emulated drive: at the road's end, standing");
  });

  test("the road laid on before it runs out: a long drive never stops", () => {
    const h = setup();
    h.setDot({ ...at(1000, -1900), headingRad: 0 });
    expect(h.begin()).toBe(true);
    // North along the avenue 7 km: past the first line's 3 km.
    const cars = h.run(390, 60);
    expect(cars.filter((c) => c.speedKph > 55).length).toBeGreaterThan(cars.length * 0.8);
    expect(frame.toEnu(cars.at(-1)!)[1]).toBeGreaterThan(4000);
    for (const c of cars) expect(Math.abs(frame.toEnu(c)[0] - 1000)).toBeLessThan(0.5);
  });

  test("a route from the dot; a new plan from where the car is; ended on the way, on along the road", () => {
    const h = setup();
    h.setDot({ ...at(0, 0), headingRad: Math.PI / 2 });
    h.setRoute([at(0, 0), at(1000, 0), at(1000, 2000)]);
    expect(h.begin()).toBe(true);
    expect(h.notes.at(-1)).toBe("emulated drive: along 3000 m of route from the dot");
    let cars = h.run(120);
    // Turned left at the crossing: north on the avenue.
    let turned = 0;
    for (const c of cars) turned += c.yawRad * 0.05;
    expect(turned).toBeCloseTo(Math.PI / 2, 1);
    const was = h.drive.where()!;
    expect(frame.toEnu(was)[1]).toBeGreaterThan(100);
    // A re-plan: joined where the car is, at its speed.
    h.setRoute([at(1000, 0), at(1000, 5000)]);
    expect(haversineM(h.drive.where()!, was)).toBeLessThan(0.5);
    expect(h.drive.where()!.speedMps).toBeCloseTo(was.speedMps, 5);
    expect(h.notes.at(-1)).toBe("emulated drive: along 5000 m of route from where the car is");
    cars = h.run(10);
    // The route stopped on the way: on along the avenue, no stop.
    h.setRoute(null);
    expect(h.notes.at(-1)).toMatch(/^emulated drive: route ended, along the road on/);
    cars = h.run(10);
    expect(Math.min(...cars.map((c) => c.speedKph))).toBeGreaterThan(55);
    expect(frame.toEnu(cars.at(-1)!)[1]).toBeGreaterThan(frame.toEnu(was)[1]);
  });

  test("at the route's end it stands, also once the route is gone; the next route starts there", () => {
    const h = setup();
    h.setDot({ ...at(0, 0), headingRad: Math.PI / 2 });
    h.setRoute([at(0, 0), at(600, 0)]);
    expect(h.begin()).toBe(true);
    let cars = h.run(120);
    expect(cars.at(-1)).toMatchObject({ arrived: true, speedKph: 0 });
    expect(h.notes.at(-1)).toBe("emulated drive: at the route's end, standing");
    h.setRoute(null);
    cars = h.run(10);
    expect(cars.every((c) => c.speedKph === 0)).toBe(true);
    expect(haversineM(cars.at(-1)!, at(600, 0))).toBeLessThan(0.5);
    h.setRoute([at(600, 0), at(1000, 0)]);
    cars = h.run(10);
    expect(cars.at(-1)!.speedKph).toBeGreaterThan(10);
  });

  test("over: the phone's fixes back, the graph reader let go", () => {
    const h = setup();
    h.setDot({ ...at(200, 0), headingRad: Math.PI / 2 });
    h.begin();
    h.run(5);
    h.drive.stop();
    expect(h.gps).toEqual(["ignored", "back"]);
    expect(h.closed()).toBe(1);
    expect(h.drive.at(1e9, 60)).toEqual({ speedKph: 0, yawRad: 0 });
    // Never begun: nothing to give back.
    const n = setup();
    n.drive.stop();
    expect(n.gps).toEqual([]);
  });
});
