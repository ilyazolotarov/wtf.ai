import { readFileSync } from "node:fs";
import path from "node:path";

import { LocalFrame } from "@/nav/geo/local-frame";
import { bufferByteSource } from "@/nav/mapmatch/graph/byte-source";
import { TiledRoadGraph } from "@/nav/mapmatch/graph/road-graph";
import type { PositionEstimate } from "@/nav/position/types";
import { RouteService, type RoutingGraph } from "@/services/navigation/route-service";
import type { NavRouteProgressRecord, NavRouteRecord } from "@/triplog/schema";

// The fixture network (src/nav/routing/__tests__/router.test.ts): 101 = 1–2 east, 102 = 2–4 east, 104 = 2–6 south,
// a grid of D = 0.0006° around (LAT0, LON0).
const FIXTURE = readFileSync(path.join(__dirname, "../../../nav/mapmatch/__fixtures__/net.graph.bin"));
const LON0 = 30.75;
const LAT0 = 51.52;
const D = 0.0006;
const at = (x: number, y: number) => ({ lat: LAT0 + y * D, lon: LON0 + x * D });

function harness(options: { graph?: boolean } = {}) {
  let position: PositionEstimate | null = null;
  const listeners = new Set<() => void>();
  let clock = 1_000_000;
  const deferred: (() => void)[] = [];
  const notes: string[] = [];
  const routes: NavRouteRecord[] = [];
  const progress: NavRouteProgressRecord[] = [];
  let points = 0;
  let maneuvers = 0;
  let opened = 0;
  let closed = 0;
  const service = new RouteService({
    position: { getSnapshot: () => position, subscribe: (l) => (listeners.add(l), () => listeners.delete(l)) },
    openGraph: (): RoutingGraph | null => {
      if (options.graph === false) return null;
      opened++;
      const graph = new TiledRoadGraph(bufferByteSource(new Uint8Array(FIXTURE)), new LocalFrame({ lat: LAT0, lon: LON0 }));
      return { key: "net", graph, close: () => closed++ };
    },
    nowUs: () => clock * 1000,
    now: () => clock,
    note: (t) => notes.push(t),
    log: {
      route: (r) => routes.push(r),
      point: () => points++,
      maneuver: () => maneuvers++,
      progress: (r) => progress.push(r),
    },
    defer: (fn) => {
      deferred.push(fn);
      return () => deferred.splice(deferred.indexOf(fn) >>> 0, 1);
    },
  });
  /** Run everything deferred (the planner's slices), as the event loop would. */
  const flush = () => {
    while (deferred.length) deferred.shift()!();
  };
  const move = (x: number, y: number, more: Partial<PositionEstimate> = {}) => {
    position = { ...at(x, y), accuracyM: 5, source: "fused", trust: "TRUSTED", timestamp: clock, headingRad: Math.PI / 2, speedMps: 10, ...more };
    listeners.forEach((l) => l());
  };
  const tick = (ms: number) => (clock += ms);
  return { service, flush, move, tick, notes, routes, progress, counts: () => ({ points, maneuvers, opened, closed }) };
}

describe("RouteService", () => {
  test("plans in slices from the published position, then guides along the route", () => {
    const h = harness();
    h.move(0.5, 0);
    h.service.start({ ...at(1, -0.6), name: "south" });
    expect(h.service.getSnapshot()).toMatchObject({ status: "planning" });
    h.flush();
    const s = h.service.getSnapshot()!;
    expect(s).toMatchObject({ status: "active", planId: 1, replanning: false });
    expect(s.maneuvers!.map((m) => m.kind)).toEqual(["depart", "right", "arrive"]);
    // The plan, its polyline and maneuvers are in the trip log, with a readable note.
    expect(h.routes).toEqual([expect.objectContaining({ planId: 1, reason: "new", status: "done", maneuvers: 3 })]);
    expect(h.counts()).toMatchObject({ points: s.plan!.coordinates.length, maneuvers: 3 });
    expect(h.notes.find((n) => n.startsWith("route plan #1 (new)"))).toMatch(/1 maneuvers; \d+ states, \d+ tiles, \d+ ms in \d+ slices/);
    // The developer screen's numbers.
    expect(h.service.getDebug()).toMatchObject({ plans: 1, last: { id: 1, reason: "new", outcome: "done", slices: expect.any(Number) } });
    // Each published position: guidance, and a progress record.
    h.tick(1000);
    h.move(0.8, 0);
    expect(h.service.getSnapshot()!.guidance).toMatchObject({ state: "on" });
    expect(h.progress.at(-1)).toMatchObject({ planId: 1, state: "on", nextIndex: 1 });
  });

  test("leaving the route plans again from where the car is (reason off-route), the old route shown meanwhile", () => {
    const h = harness();
    h.move(0.2, 0);
    h.service.start(at(1, -0.6));
    h.flush();
    // Straight on east past node 2, where the route turned right.
    for (let i = 1; i <= 12; i++) {
      h.tick(1000);
      h.move(1 + 0.25 * i, 0);
    }
    expect(h.notes.some((n) => n.startsWith("route off at"))).toBe(true);
    expect(h.service.getSnapshot()).toMatchObject({ replanning: true, planId: 1 });
    h.flush();
    expect(h.service.getSnapshot()).toMatchObject({ status: "active", planId: 2, replanning: false });
    expect(h.routes.map((r) => r.reason)).toEqual(["new", "off-route"]);
  });

  test("a destination without a road route fails, and says why", () => {
    const h = harness();
    h.move(0.5, 0);
    h.service.start({ lat: LAT0 + 0.01, lon: LON0 + 0.03 }); // the separate long road
    h.flush();
    expect(h.service.getSnapshot()).toMatchObject({ status: "failed", failure: "no-route" });
    expect(h.routes).toEqual([expect.objectContaining({ status: "no-route" })]);
    expect(h.service.getDebug().last).toMatchObject({ outcome: "no-route", lengthM: null });
  });

  test("a destination outside the region's map is said to be so", () => {
    const h = harness();
    h.move(0.5, 0);
    h.service.start({ lat: 49.84, lon: 24.03 }); // Lviv
    expect(h.service.getSnapshot()).toMatchObject({ status: "failed", failure: "outside-region" });
  });

  test("without a downloaded road graph, or a position, the route can't be planned", () => {
    const noGraph = harness({ graph: false });
    noGraph.move(0.5, 0);
    noGraph.service.start(at(2, 0));
    expect(noGraph.service.getSnapshot()).toMatchObject({ status: "failed", failure: "no-road-graph" });
    const noPosition = harness();
    noPosition.service.start(at(2, 0));
    expect(noPosition.service.getSnapshot()).toMatchObject({ status: "failed", failure: "no-position" });
  });

  test("a trip starting logs the active route again; stopping ends it and closes the graph", () => {
    const h = harness();
    h.move(0.5, 0);
    h.service.start(at(2, 0));
    h.flush();
    h.service.logActiveRoute();
    expect(h.routes.map((r) => r.reason)).toEqual(["new", "resume"]);
    h.service.stop();
    expect(h.service.getSnapshot()).toBeNull();
    expect(h.counts()).toMatchObject({ opened: 1, closed: 1 });
    expect(h.notes.at(-1)).toMatch(/^route stop/);
  });

  test("arrival is noted with the planned and the real time and distance", () => {
    const h = harness();
    h.move(0.2, 0);
    h.service.start(at(2, 0));
    h.flush();
    for (let x = 0.4; x <= 2.01; x += 0.2) {
      h.tick(1000);
      h.move(x, 0);
    }
    expect(h.service.getSnapshot()!.guidance!.state).toBe("arrived");
    expect(h.notes.find((n) => n.startsWith("route arrived"))).toMatch(/min \(planned \d+\), driven [\d.]+ km \(planned [\d.]+ km\)/);
  });

  test("phone GPS that isn't trusted never sends the car off the route", () => {
    const h = harness();
    h.move(0.2, 0);
    h.service.start(at(2, 0));
    h.flush();
    for (let i = 1; i <= 10; i++) {
      h.tick(1000);
      h.move(0.2, 3 + i, { source: "gnss", trust: "UNTRUSTED" });
    }
    expect(h.service.getSnapshot()!.guidance!.state).toBe("unsure");
    expect(h.routes).toHaveLength(1);
  });
});
