import { readFileSync } from "node:fs";
import path from "node:path";

import { LocalFrame } from "@/nav/geo/local-frame";
import { bufferByteSource } from "@/nav/mapmatch/graph/byte-source";
import { TiledRoadGraph } from "@/nav/mapmatch/graph/road-graph";
import type { Coordinate } from "@/nav/geo";
import type { PositionEstimate } from "@/nav/position/types";
import { at as ladderAt, ladder } from "@/nav/routing/__fixtures__/ladder";
import { RouteService, type RoutingGraph } from "@/services/navigation/route-service";
import type { NavRouteProgressRecord, NavRouteRecord } from "@/triplog/schema";

// The fixture network (src/nav/routing/__tests__/router.test.ts): 101 = 1–2 east, 102 = 2–4 east, 104 = 2–6 south,
// a grid of D = 0.0006° around (LAT0, LON0).
const FIXTURE = readFileSync(path.join(__dirname, "../../../nav/mapmatch/__fixtures__/net.graph.bin"));
const LON0 = 30.75;
const LAT0 = 51.52;
const D = 0.0006;
const at = (x: number, y: number) => ({ lat: LAT0 + y * D, lon: LON0 + x * D });

function harness(options: { graph?: boolean; store?: Map<string, unknown>; network?: "ladder" } = {}) {
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
      if (options.network === "ladder") return { key: "ladder", graph: Object.assign(ladder(), { setFrame: () => {} }), close: () => closed++ };
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
    store: options.store && {
      getJson: <T,>(key: string) => (options.store!.get(key) ?? null) as T | null,
      setJson: (key: string, value: unknown) => void options.store!.set(key, value),
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
  /** Run deferred slices one by one until `done` says so. */
  const flushUntil = (done: () => boolean) => {
    while (deferred.length && !done()) deferred.shift()!();
  };
  const moveTo = (c: Coordinate, more: Partial<PositionEstimate> = {}) => {
    position = { ...c, accuracyM: 5, source: "fused", trust: "TRUSTED", timestamp: clock, headingRad: Math.PI / 2, speedMps: 10, ...more };
    listeners.forEach((l) => l());
  };
  const move = (x: number, y: number, more: Partial<PositionEstimate> = {}) => moveTo(at(x, y), more);
  const tick = (ms: number) => (clock += ms);
  const pending = () => deferred.length;
  return { service, flush, flushUntil, pending, move, moveTo, tick, notes, routes, progress, counts: () => ({ points, maneuvers, opened, closed }) };
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

  test("map matching off-road: no new route while the filter says the dot is not on a road", () => {
    const h = harness();
    h.move(0.2, 0);
    h.service.start(at(1, -0.6));
    h.flush();
    for (let i = 1; i <= 12; i++) {
      h.tick(1000);
      h.move(1 + 0.25 * i, 0, { mapMatch: "offroad" });
    }
    expect(h.notes.some((n) => n.startsWith("route off at"))).toBe(true);
    expect(h.routes.map((r) => r.reason)).toEqual(["new"]);
    // Back on a road, and leaving the route is news again.
    h.tick(1000);
    h.move(4, 0, { mapMatch: "tracking" });
    h.flush();
    expect(h.routes.map((r) => r.reason)).toEqual(["new", "off-route"]);
  });

  test("a plan that goes off route again at once doubles the wait, and a plan that lasts clears it", () => {
    const h = harness();
    h.move(0.2, 0);
    h.service.start(at(1, -0.6));
    h.flush();
    /** Drive east off the route (or, with `beside`, creep along 84 m north of the road) until it re-plans, and say when. */
    let x = 1;
    const driveOff = (beside = false) => {
      for (let i = 0; i < 400; i++) {
        h.tick(1000);
        x += beside ? 0.002 : 0.25;
        h.move(x, beside ? 2 : 0);
        if (h.service.getSnapshot()?.replanning) {
          h.flush();
          return i + 1;
        }
      }
      return Infinity;
    };
    expect(driveOff()).toBeLessThanOrEqual(12);
    const plans = h.routes.length;
    // Each route that goes off within a minute of its plan doubles the wait: 10, 20, 40, 80 s, then 160 s at most.
    // The waits themselves outlast a minute, and must not end the streak.
    const waits = [10, 20, 40, 80, 160, 160].map(() => driveOff(true));
    expect(waits.map((w, i) => w >= [10, 20, 40, 80, 160, 160][i])).toEqual([true, true, true, true, true, true]);
    expect(waits[5]).toBeLessThan(175);
    expect(h.routes.length).toBe(plans + 6);
    // A route nobody leaves for over a minute: the streak is spent, and the wait is back to 10 s.
    h.tick(90_000);
    expect(driveOff()).toBeGreaterThanOrEqual(1);
    expect(driveOff()).toBeLessThanOrEqual(12);
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

  test("a restarted app picks the active route up again once it has a position; a stopped route stays stopped", () => {
    const store = new Map<string, unknown>();
    const before = harness({ store });
    before.move(0.5, 0);
    before.service.start({ ...at(2, 0), name: "east" });
    before.flush();
    // The app restarts: a new service, no position yet.
    const after = harness({ store });
    after.service.resume();
    expect(after.service.getSnapshot()).toBeNull();
    after.move(0.6, 0);
    after.flush();
    expect(after.service.getSnapshot()).toMatchObject({ status: "active", destination: { name: "east" } });
    expect(after.notes[0]).toMatch(/^route resumed after an app restart, to /);
    after.service.stop();
    const again = harness({ store });
    again.move(0.6, 0);
    again.service.resume();
    expect(again.service.getSnapshot()).toBeNull();
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

  describe("alternatives (the ladder: a north branch, a south one 0.2 km longer)", () => {
    const south = (c: Coordinate[]) => c.some((p) => p.lat < ladderAt(0, -350).lat);
    const start = () => {
      const h = harness({ network: "ladder" });
      h.moveTo(ladderAt(0, 0));
      h.service.start(ladderAt(2200, 0));
      return h;
    };

    test("the route is on its way before any alternative is searched; they come after, in slices of their own", () => {
      const h = start();
      h.flushUntil(() => h.service.getSnapshot()?.status === "active");
      const s = h.service.getSnapshot()!;
      expect(south(s.plan!.coordinates)).toBe(false);
      expect(s.alternatives).toBeUndefined();
      expect(h.pending()).toBeGreaterThan(0); // the alternatives search, queued behind the route
      h.flush();
      const alts = h.service.getSnapshot()!.alternatives!;
      expect(alts).toHaveLength(1);
      expect(south(alts[0].plan.coordinates)).toBe(true);
      expect(alts[0].deltaS).toBeGreaterThan(0);
      expect(alts[0].labelAt.lat).toBeLessThan(ladderAt(0, -350).lat);
      expect(h.notes.some((n) => /^route alternatives: 1 \(\+\d+ min/.test(n))).toBe(true);
    });

    test("choosing the alternative makes it the route (logged, reason alternative); the old route is the alternative", () => {
      const h = start();
      h.flush();
      const before = h.service.getSnapshot()!;
      h.service.chooseAlternative(0);
      const s = h.service.getSnapshot()!;
      expect(south(s.plan!.coordinates)).toBe(true);
      expect(s.planId).toBeGreaterThan(before.planId);
      expect(s.alternatives).toHaveLength(1);
      expect(s.alternatives![0].deltaS).toBeLessThan(0);
      expect(h.routes.map((r) => r.reason)).toEqual(["new", "alternative"]);
    });

    test("driving the alternative's road takes it instead of planning again", () => {
      const h = start();
      h.flush();
      for (const n of [-50, -120, -200, -280, -360, -400]) {
        h.tick(1000);
        h.moveTo(ladderAt(100, n), { headingRad: Math.PI });
      }
      for (const e of [200, 300, 400]) {
        h.tick(1000);
        h.moveTo(ladderAt(e, -400), { headingRad: Math.PI / 2 });
      }
      h.flush();
      const s = h.service.getSnapshot()!;
      expect(south(s.plan!.coordinates)).toBe(true);
      expect(h.notes.some((n) => n.startsWith("route alternative taken (taken)"))).toBe(true);
      expect(h.routes.map((r) => r.reason)).toEqual(["new", "alternative"]);
    });

    test("on the route and off every alternative, they go away", () => {
      const h = start();
      h.flush();
      // 10 m/s, a fix every 8 s: the south branch's guidance has to see the car drive 200 m off it.
      for (const n of [80, 160, 240, 300]) {
        h.tick(8000);
        h.moveTo(ladderAt(100, n), { headingRad: 0 });
      }
      for (const e of [180, 260, 340, 420]) {
        h.tick(8000);
        h.moveTo(ladderAt(e, 300), { headingRad: Math.PI / 2 });
      }
      expect(h.service.getSnapshot()!.alternatives).toBeUndefined();
      expect(h.service.getSnapshot()!.guidance).toMatchObject({ state: "on" });
    });

    test("stopping cancels an alternatives search still running", () => {
      const h = start();
      h.flushUntil(() => h.service.getSnapshot()?.status === "active");
      h.service.stop();
      h.flush();
      expect(h.service.getSnapshot()).toBeNull();
      expect(h.notes.some((n) => n.startsWith("route alternatives"))).toBe(false);
    });
  });
});
