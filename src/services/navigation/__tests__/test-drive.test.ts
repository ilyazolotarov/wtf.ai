// The car's test drive (test-drive.ts, docs/ANDROID-AUTO-SPEC.md §4): on a fake route, then through the route service
// on the fixture network, to its destination.

import { readFileSync } from "node:fs";
import path from "node:path";

import { haversineM, type Coordinate } from "@/nav/geo";
import { LocalFrame } from "@/nav/geo/local-frame";
import { bufferByteSource } from "@/nav/mapmatch/graph/byte-source";
import { TiledRoadGraph } from "@/nav/mapmatch/graph/road-graph";
import type { DrivePoint } from "@/nav/sim/route-drive";
import type { PositionEstimate } from "@/nav/position/types";
import { RouteService, type RouteSnapshot } from "@/services/navigation/route-service";

import { TEST_DRIVE_STEP_MS, TestDrive } from "../test-drive";

const at = (east: number, north: number) => ({ lat: 50.45 + north / 111_195, lon: 30.52 + east / (111_195 * Math.cos((50.45 * Math.PI) / 180)) });

function setup() {
  let route: RouteSnapshot | null = null;
  const listeners = new Set<() => void>();
  const shown: (DrivePoint | null)[] = [];
  const notes: string[] = [];
  let step = null as (() => void) | null;
  let clock = 0;
  const drive = new TestDrive({
    routes: { getSnapshot: () => route, subscribe: (l) => (listeners.add(l), () => listeners.delete(l)) },
    show: (dot) => shown.push(dot),
    every: (ms, fn) => {
      expect(ms).toBe(TEST_DRIVE_STEP_MS);
      step = fn;
      return () => (step = null);
    },
    nowMs: () => clock,
    note: (t) => notes.push(t),
  });
  const setRoute = (line: Coordinate[] | null, planId = 1) => {
    route = line && ({ status: "active", planId, plan: { coordinates: line }, replanning: false } as unknown as RouteSnapshot);
    listeners.forEach((l) => l());
  };
  const run = (s: number) => {
    for (let t = 0; t < s * 1000 && step; t += TEST_DRIVE_STEP_MS) {
      clock += TEST_DRIVE_STEP_MS;
      step();
    }
  };
  return { drive, setRoute, run, shown, notes, stepping: () => step !== null, last: () => shown.at(-1) };
}

describe("the car's test drive", () => {
  test("nothing until a route; then its dot from the route's start, along it", () => {
    const h = setup();
    h.drive.start();
    expect(h.shown).toEqual([]);
    h.setRoute([at(0, 0), at(500, 0)]);
    expect(h.last()).toMatchObject({ speedMps: 0 });
    expect(haversineM(h.last()!, at(0, 0))).toBeLessThan(0.5);
    h.run(10);
    expect(h.last()!.speedMps).toBeGreaterThan(10);
    expect(h.notes).toEqual(["test drive on: each route is driven along", "test drive: along 500 m of route"]);
  });

  test("a new plan (an alternative, a re-plan) carries on from where the car is", () => {
    const h = setup();
    h.drive.start();
    h.setRoute([at(0, 0), at(500, 0)]);
    h.run(10);
    const was = h.last()!;
    h.setRoute([at(0, 0), at(500, 0), at(500, 500)], 2);
    expect(haversineM(h.last()!, was)).toBeLessThan(0.5);
    expect(h.last()!.speedMps).toBeCloseTo(was.speedMps, 5);
    expect(h.notes.at(-1)).toBe("test drive: along 1000 m of route, from where it was");
  });

  test("stops at the route's end; the route ended, the car stands there; the next route starts there", () => {
    const h = setup();
    h.drive.start();
    h.setRoute([at(0, 0), at(300, 0)]);
    h.run(120);
    expect(h.last()).toMatchObject({ arrived: true, speedMps: 0 });
    expect(h.stepping()).toBe(false);
    h.setRoute(null);
    expect(haversineM(h.last()!, at(300, 0))).toBeLessThan(0.5);
    h.setRoute([at(300, 0), at(300, 300)], 2);
    expect(haversineM(h.last()!, at(300, 0))).toBeLessThan(0.5);
    expect(h.stepping()).toBe(true);
  });

  test("a route ended on the way: the car stops where it is", () => {
    const h = setup();
    h.drive.start();
    h.setRoute([at(0, 0), at(1000, 0)]);
    h.run(10);
    const was = h.last()!;
    h.setRoute(null);
    expect(h.last()).toMatchObject({ lat: was.lat, lon: was.lon, speedMps: 0 });
    expect(h.stepping()).toBe(false);
  });

  test("off: the navigator's dot again, no more steps", () => {
    const h = setup();
    h.drive.start();
    h.setRoute([at(0, 0), at(1000, 0)]);
    h.run(5);
    h.drive.stop();
    expect(h.last()).toBeNull();
    expect(h.stepping()).toBe(false);
    expect(h.drive.on).toBe(false);
    h.setRoute([at(0, 0), at(500, 0)], 2);
    expect(h.last()).toBeNull();
  });
});

// The fixture network (route-service.test.ts): a grid of D = 0.0006° around (LAT0, LON0).
const FIXTURE = readFileSync(path.join(__dirname, "../../../nav/mapmatch/__fixtures__/net.graph.bin"));
const LON0 = 30.75;
const LAT0 = 51.52;
const D = 0.0006;
const grid = (x: number, y: number) => ({ lat: LAT0 + y * D, lon: LON0 + x * D });

test("a test drive gets to the destination with the route's guidance, as a drive does", () => {
  let clock = 1_000_000;
  let position: PositionEstimate | null = { ...grid(0.5, 0), accuracyM: 5, source: "fused", trust: "TRUSTED", timestamp: clock, headingRad: Math.PI / 2 };
  const positionListeners = new Set<() => void>();
  const deferred: (() => void)[] = [];
  const notes: string[] = [];
  const service = new RouteService({
    position: { getSnapshot: () => position, subscribe: (l) => (positionListeners.add(l), () => positionListeners.delete(l)) },
    openGraph: () => ({ key: "net", graph: new TiledRoadGraph(bufferByteSource(new Uint8Array(FIXTURE)), new LocalFrame({ lat: LAT0, lon: LON0 })), close: () => {} }),
    nowUs: () => clock * 1000,
    now: () => clock,
    note: (t) => notes.push(t),
    log: { route: () => {}, point: () => {}, maneuver: () => {}, progress: () => {} },
    defer: (fn) => {
      deferred.push(fn);
      return () => deferred.splice(deferred.indexOf(fn) >>> 0, 1);
    },
  });
  const flush = () => {
    while (deferred.length) deferred.shift()!();
  };
  let step = null as (() => void) | null;
  const drive = new TestDrive({
    routes: service,
    show: (dot) => {
      position = dot && { ...dot, accuracyM: 3, source: "fused", trust: "TRUSTED", timestamp: clock, testDrive: true };
      positionListeners.forEach((l) => l());
    },
    every: (_ms, fn) => {
      step = fn;
      return () => (step = null);
    },
    nowMs: () => clock,
    note: (t) => notes.push(t),
  });
  drive.start();
  service.start({ ...grid(1, -0.6), name: "south" });
  flush();
  expect(service.getSnapshot()).toMatchObject({ status: "active" });
  const states = new Set<string>();
  const plans = new Set<number>();
  // Run until it arrives (the route's end deferred after that runs at once here, ending the route).
  for (let i = 0; i < 2000 && step && !states.has("arrived"); i++) {
    clock += TEST_DRIVE_STEP_MS;
    step();
    const s = service.getSnapshot();
    states.add(s?.guidance?.state ?? "none");
    if (s) plans.add(s.planId);
    flush();
  }
  expect(states.has("arrived")).toBe(true);
  expect(states.has("on")).toBe(true);
  // Kept to the route: never re-planned.
  expect([...plans]).toEqual([1]);
  expect(notes.find((n) => n.startsWith("route arrived"))).toBeDefined();
});
