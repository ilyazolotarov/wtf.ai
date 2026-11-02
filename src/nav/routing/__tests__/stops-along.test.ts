import { readFileSync } from "node:fs";
import path from "node:path";

import type { Coordinate } from "@/nav/geo";
import { LocalFrame } from "@/nav/geo/local-frame";
import { bufferByteSource } from "@/nav/mapmatch/graph/byte-source";
import { TiledRoadGraph } from "@/nav/mapmatch/graph/road-graph";
import { ALONG_CORRIDOR_M, placesAlong, RouteLine } from "@/nav/routing/along";
import { Announcer, type AnnouncerInput } from "@/nav/routing/announcer";
import { DetourSearch, detourMinutes } from "@/nav/routing/detour";
import { RouteGuidance } from "@/nav/routing/guidance";
import type { Maneuver } from "@/nav/routing/maneuvers";
import type { RoutePlan } from "@/nav/routing/router";
import { planTrip } from "@/nav/routing/trip";

// A straight road east, 2 km, with a stop at 1 km (STOPS-SPEC §5).
const LAT = 50;
const LON = 30;
const M_LON = 1 / (111_195 * Math.cos((LAT * Math.PI) / 180));
const east = (m: number, northM = 0): Coordinate => ({ lat: LAT + northM / 111_195, lon: LON + m * M_LON });

function straight(stopsAtM: number[] = [1000]): RoutePlan {
  const coordinates = Array.from({ length: 41 }, (_, i) => east(i * 50));
  return {
    legs: [],
    lengthM: 2000,
    durationS: 200,
    coordinates,
    offRoadM: { start: 0, end: 0 },
    stops: stopsAtM.map((m, i) => ({ key: `s${i + 1}`, atM: m, atS: m / 10, ...east(m), point: east(m, -40), side: "right" as const })),
  };
}

const maneuvers = (plan: RoutePlan): Maneuver[] => [
  { kind: "depart", atM: 0, ...east(0), turnRad: 0 },
  ...(plan.stops ?? []).map((s): Maneuver => ({ kind: "stop", atM: s.atM, lat: s.lat, lon: s.lon, turnRad: 0, side: "right", stop: s.key })),
  { kind: "arrive", atM: plan.lengthM, ...east(plan.lengthM), turnRad: 0 },
];

function drive(g: RouteGuidance, fromM: number, toM: number, stepM: number, t0 = 0, more: { northM?: number } = {}) {
  let t = t0;
  let last = null as ReturnType<RouteGuidance["update"]> | null;
  for (let m = fromM; m <= toM; m += stepM) {
    last = g.update({ ...east(m, more.northM ?? 0), tMs: t, accuracyM: 5, headingRad: Math.PI / 2, speedMps: 10 });
    t += (stepM / 10) * 1000;
  }
  return { step: last!, t };
}

describe("guidance at stops (STOPS-SPEC §5)", () => {
  test("the next stop's distance and time, then reached within 30 m; the destination's arrival only at the end", () => {
    const plan = straight();
    const g = new RouteGuidance(plan, maneuvers(plan));
    let { step, t } = drive(g, 0, 500, 10);
    expect(step).toMatchObject({ state: "on", nextStop: 0, reachedStops: [] });
    expect(step.toStopM).toBeCloseTo(500, -1);
    expect(step.toStopS).toBeCloseTo(50, 0);
    ({ step, t } = drive(g, 510, 990, 10, t));
    expect(step.reachedStops).toEqual([0]);
    expect(step.nextStop).toBeNull();
    expect(step.state).toBe("on");
    ({ step } = drive(g, 1000, 2000, 10, t));
    expect(step.state).toBe("arrived");
  });

  test("the time left counts each leg at its own pace", () => {
    const plan = { ...straight(), stops: [{ ...straight().stops![0], atS: 150 }] }; // the first km slow, the second fast
    const g = new RouteGuidance(plan, maneuvers(plan));
    const { step } = drive(g, 0, 500, 10);
    expect(step.remainingS).toBeCloseTo(200 - 75, 0);
    expect(step.toStopS).toBeCloseTo(75, 0);
  });

  test("reached at its place too: a forecourt off the road", () => {
    const plan = straight();
    const g = new RouteGuidance(plan, maneuvers(plan));
    const { t } = drive(g, 0, 940, 10);
    // Off the road, 40 m south: off the route but at the stop's place.
    const step = g.update({ ...east(1000, -40), tMs: t + 2000, accuracyM: 5, speedMps: 2 });
    expect(step.reachedStops).toEqual([0]);
  });

  test("passed on the route without coming within 30 m: a stop left behind", () => {
    const plan = straight();
    const g = new RouteGuidance(plan, maneuvers(plan));
    // Positions far apart (a jammed stretch): 960 m, then 1110 m.
    drive(g, 0, 960, 40);
    const step = g.update({ ...east(1110), tMs: 200_000, accuracyM: 5, headingRad: Math.PI / 2, speedMps: 10 });
    expect(step.passedStops).toEqual([0]);
    expect(step.reachedStops).toEqual([]);
  });

  test("the voice: the stop ahead and at it like a turn; 'you're at the stop' and 'stop passed' once each", () => {
    const plan = straight();
    const m = maneuvers(plan);
    const g = new RouteGuidance(plan, m);
    const a = new Announcer();
    const said: string[] = [];
    let t = 0;
    for (let x = 0; x <= 1000; x += 10) {
      const step = g.update({ ...east(x), tMs: t, accuracyM: 5, headingRad: Math.PI / 2, speedMps: 10 });
      t += 1000;
      const out = a.update({ planId: 1, maneuvers: m, guidance: step, speedMps: 10, atStop: step.reachedStops?.length ? "s1" : null });
      said.push(...out.map((o) => (o.kind === "maneuver" ? `${o.stage}-${o.maneuver.kind}-${o.maneuver.side}` : o.kind)));
    }
    expect(said).toEqual(["prepare-stop-right", "now-stop-right", "stop-reached"]);
    const again = a.update({ planId: 1, maneuvers: m, guidance: g.step!, speedMps: 0, atStop: "s1", passedStop: "s9" });
    expect(again.map((o) => o.kind)).toEqual(["stop-passed"]);
  });

  test("the voice: a stop taken back and missed again is said again; a re-plan made at a stop is not a new arrival", () => {
    const plan = straight();
    const m = maneuvers(plan);
    const g = new RouteGuidance(plan, m);
    const step = g.update({ ...east(0), tMs: 0, accuracyM: 5, headingRad: Math.PI / 2, speedMps: 10 });
    const a = new Announcer();
    const kinds = (input: Partial<AnnouncerInput>) =>
      a.update({ planId: 1, maneuvers: m, guidance: step, speedMps: 10, ...input }).map((o) => o.kind).filter((k) => k.startsWith("stop"));
    expect(kinds({ passedStop: "s1" })).toEqual(["stop-passed"]);
    expect(kinds({ passedStop: "s1" })).toEqual([]);
    // "Go back": the card goes, the stop is ahead again; missed again.
    expect(kinds({ planId: 2, planReason: "stop-back" })).toEqual([]);
    expect(kinds({ planId: 2, passedStop: "s1" })).toEqual(["stop-passed"]);
    expect(kinds({ planId: 2, atStop: "s2" })).toEqual(["stop-reached"]);
    // A stop added while standing at this one: planned again, still at it.
    expect(kinds({ planId: 3, planReason: "stops", atStop: "s2" })).toEqual([]);
  });
});

describe("places along the route (STOPS-SPEC §6.3)", () => {
  const plan = straight([]);
  const line = new RouteLine(plan);
  const place = (key: string, m: number, northM: number) => ({ key, ...east(m, northM) });
  const all = [place("a", 300, 20), place("b", 800, -100), place("c", 1200, 600), place("d", 50, 30), place("e", 1900, -450), place("f", 1500, 0)];
  const placesIn = (box: { south: number; west: number; north: number; east: number }) =>
    all.filter((p) => p.lat >= box.south && p.lat <= box.north && p.lon >= box.west && p.lon <= box.east);

  test("ahead of the car, within 500 m of the route, in order along it, with their side", () => {
    const r = placesAlong(line, 100, placesIn);
    expect(r.hits.map((h) => h.place.key)).toEqual(["a", "b", "f", "e"]);
    expect(r.hits.map((h) => h.side)).toEqual(["left", "right", null, "right"]);
    expect(r.hits[0].alongM).toBeCloseTo(300, -1);
    expect(r.hits[1].offM).toBeCloseTo(100, -1);
    expect(r.more).toBe(false);
  });

  test("a page at a time: further along after the first ones", () => {
    const first = placesAlong(line, 100, placesIn, { count: 2 });
    expect(first.hits.map((h) => h.place.key)).toEqual(["a", "b"]);
    expect(first.more).toBe(true);
    const next = placesAlong(line, first.hits[1].alongM + 1, placesIn, { count: 2 });
    expect(next.hits.map((h) => h.place.key)).toEqual(["f", "e"]);
  });

  test("the line's points and projection agree with the plan's metres", () => {
    expect(line.at(1000).point.lon).toBeCloseTo(east(1000).lon, 6);
    expect(line.at(1000).headingRad).toBeCloseTo(Math.PI / 2, 3);
    expect(line.project(east(700, 30), 0, ALONG_CORRIDOR_M)?.alongM).toBeCloseTo(700, -1);
    expect(line.project(east(700, 30), 800, ALONG_CORRIDOR_M)?.alongM).toBeCloseTo(800, -1);
    expect(line.project(east(700, 800), 0, ALONG_CORRIDOR_M)).toBeNull();
  });

  test("a plan made from the car: a place behind its start is behind the car, not at 0 m", () => {
    const behind = [place("back", -300, -60), place("beside", 0, 40)];
    const r = placesAlong(line, 0, (box) => behind.filter((p) => p.lat >= box.south && p.lat <= box.north && p.lon >= box.west && p.lon <= box.east));
    expect(r.hits.map((h) => h.place.key)).toEqual(["beside"]);
  });
});

// net.graph.bin (router.test.ts): 1 (0,0) — 2 (1,0) — 3 — 4 (3,0), 2 — 6 (1,−1) south.
const FIXTURE = readFileSync(path.join(__dirname, "../../mapmatch/__fixtures__/net.graph.bin"));
const LON0 = 30.75;
const LAT0 = 51.52;
const D = 0.0006;
const frame = new LocalFrame({ lat: LAT0, lon: LON0 });
const at = (x: number, y: number) => ({ lat: LAT0 + y * D, lon: LON0 + x * D });

describe("detours (STOPS-SPEC §6.3)", () => {
  test("a place beside the route costs little; one down a side road costs the way there and back", () => {
    const g = new TiledRoadGraph(bufferByteSource(new Uint8Array(FIXTURE)), frame);
    const r = planTrip(g, frame, { ...at(0.1, 0), headingRad: Math.PI / 2, speedMps: 10 }, [{ key: "destination", ...at(2.8, 0) }]);
    if (r.status !== "done") throw new Error(r.status);
    const line = new RouteLine(r.plan);
    const onIt = { key: "on", point: at(2, 0.05), alongM: line.project(at(2, 0.05), 0, 500)!.alongM };
    const side = { key: "side", point: at(1, -0.8), alongM: line.project(at(1, -0.8), 0, 500)!.alongM };
    const search = new DetourSearch(g, frame, line, 0, [onIt, side], { aroundM: 100 });
    let out = search.run(5);
    const results = [...out.results];
    while (!out.done) {
      out = search.run(5);
      results.push(...out.results);
    }
    expect(results.map((x) => x.key)).toEqual(["on", "side"]);
    expect(results[0].detourS!).toBeLessThan(30);
    expect(results[1].detourS!).toBeGreaterThan(results[0].detourS! + 10);
  });

  test("minutes: the nearest, at least 1, none under 30 s", () => {
    expect(detourMinutes(10)).toBe(0);
    expect(detourMinutes(31)).toBe(1);
    expect(detourMinutes(84)).toBe(1);
    expect(detourMinutes(100)).toBe(2);
  });
});
