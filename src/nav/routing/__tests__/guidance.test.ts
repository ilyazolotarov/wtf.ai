import { LocalFrame } from "@/nav/geo/local-frame";
import { RouteGuidance, type GuidancePosition } from "@/nav/routing/guidance";
import type { Maneuver } from "@/nav/routing/maneuvers";
import type { RoutePlan } from "@/nav/routing/router";

// A route 1000 m east, then left, 500 m north; 10 m/s throughout.
const frame = new LocalFrame({ lat: 51.5, lon: 31.3 });
const pt = (e: number, n: number) => frame.toCoordinate(e, n);
const PLAN: RoutePlan = {
  legs: [],
  lengthM: 1500,
  durationS: 150,
  coordinates: [pt(0, 0), pt(500, 0), pt(1000, 0), pt(1000, 250), pt(1000, 500)],
  offRoadM: { start: 0, end: 0 },
};
const maneuver = (kind: Maneuver["kind"], atM: number, e: number, n: number): Maneuver => ({ kind, atM, ...pt(e, n), turnRad: 0 });
const MANEUVERS = [maneuver("depart", 0, 0, 0), maneuver("left", 1000, 1000, 0), maneuver("arrive", 1500, 1000, 500)];

const EAST = Math.PI / 2;
/** Along the route at 10 m/s: east 1000 m, then north (3 m right of the line). */
const drive = (tS: number): GuidancePosition => {
  const d = 10 * tS;
  return d <= 1000 ? at(tS, d, -3) : at(tS, 1003, d - 1000, { headingRad: 0 });
};
const at = (tS: number, e: number, n: number, more: Partial<GuidancePosition> = {}): GuidancePosition => ({
  ...pt(e, n),
  tMs: tS * 1000,
  accuracyM: 5,
  headingRad: EAST,
  speedMps: 10,
  ...more,
});

describe("RouteGuidance", () => {
  test("follows the car along the route: progress, next maneuver, distance and time left", () => {
    const g = new RouteGuidance(PLAN, MANEUVERS);
    for (let t = 0; t <= 60; t++) g.update(at(t, 10 * t, 3));
    const s = g.step!;
    expect(s.state).toBe("on");
    expect(s.alongM).toBeCloseTo(600, -1);
    expect(s.offM).toBeCloseTo(3, 0);
    expect(MANEUVERS[s.nextIndex].kind).toBe("left");
    expect(s.toNextM).toBeCloseTo(400, -1);
    expect(s.remainingM).toBeCloseTo(900, -1);
    expect(s.remainingS).toBeCloseTo(90, -1);
    // On through the turn: past it by more than a few metres, the next is the arrival.
    for (let t = 61; t <= 104; t++) g.update(drive(t));
    expect(MANEUVERS[g.step!.nextIndex].kind).toBe("arrive");
    expect(g.step!.alongM).toBeCloseTo(1040, -1);
  });

  test("leaving the route: 'leaving' at once, 'off' after 4 s and 30 m", () => {
    const g = new RouteGuidance(PLAN, MANEUVERS);
    for (let t = 0; t <= 30; t++) g.update(at(t, 10 * t, 0));
    // A side road north from 300 m.
    expect(g.update(at(31, 300, 60, { headingRad: 0 })).state).toBe("leaving");
    expect(g.update(at(33, 300, 80, { headingRad: 0 })).state).toBe("leaving");
    expect(g.update(at(35, 300, 100, { headingRad: 0 })).state).toBe("off");
    // Back on it, it's followed again.
    expect(g.update(at(60, 400, 2)).state).toBe("on");
  });

  test("starting away from the route (a car park), it takes 200 m of driving away from it to be 'off'", () => {
    const g = new RouteGuidance(PLAN, MANEUVERS);
    // 60 m south of the start, driving east in a car park for 150 m: still on the way to the route.
    for (let t = 0; t <= 15; t++) expect(g.update(at(t, 10 * t, -60)).state).toBe("leaving");
    for (let t = 16; t <= 25; t++) g.update(at(t, 10 * t, -60));
    expect(g.step!.state).toBe("off");
  });

  test("stopped next to the route is never 'off' (no distance driven)", () => {
    const g = new RouteGuidance(PLAN, MANEUVERS);
    g.update(at(0, 100, 0));
    for (let t = 1; t < 60; t++) expect(g.update(at(t, 100, 60, { speedMps: 0 })).state).toBe("leaving");
  });

  test("while map matching can't tell the road, off-route waits ('unsure')", () => {
    const g = new RouteGuidance(PLAN, MANEUVERS);
    for (let t = 0; t <= 30; t++) g.update(at(t, 10 * t, 0));
    for (let t = 31; t <= 40; t++) expect(g.update(at(t, 300, 10 * (t - 25), { headingRad: 0, mapMatch: "multimodal" })).state).toBe("unsure");
  });

  test("the off-route distance grows with the position's uncertainty", () => {
    const g = new RouteGuidance(PLAN, MANEUVERS);
    g.update(at(0, 100, 0));
    for (let t = 1; t <= 10; t++) expect(g.update(at(t, 100 + 10 * t, 90, { accuracyM: 80 })).state).toBe("on");
  });

  test("driving the route the wrong way is off it", () => {
    const g = new RouteGuidance(PLAN, MANEUVERS);
    g.update(at(0, 500, 0));
    let state = "";
    for (let t = 1; t <= 6; t++) state = g.update(at(t, 500 - 10 * t, 0, { headingRad: -EAST })).state;
    expect(state).toBe("off");
  });

  test("arrives at the end and stays arrived", () => {
    const g = new RouteGuidance(PLAN, MANEUVERS);
    for (let t = 0; t <= 147; t++) expect(g.update(drive(t)).state).toBe("on");
    expect(g.update(drive(148)).state).toBe("arrived");
    expect(g.update(at(170, 1300, 480, { headingRad: EAST })).state).toBe("arrived");
  });

  test("never jumps ahead to a later pass over the same road", () => {
    // Out east 500 m and back west on the same road, then 500 m north from the start.
    const there: RoutePlan = { ...PLAN, lengthM: 1500, coordinates: [pt(0, 0), pt(500, 0), pt(500, 2), pt(0, 2), pt(0, 500)] };
    const g = new RouteGuidance(there, [MANEUVERS[0], { ...MANEUVERS[2], atM: 1500, ...pt(0, 500) }]);
    for (let t = 0; t <= 20; t++) g.update(at(t, 10 * t, 0));
    // Stopped for a while, heading unknown: still the first pass, not the way back.
    for (let t = 21; t <= 40; t++) expect(g.update(at(t, 200, 1, { speedMps: 0, headingRad: undefined })).alongM).toBeLessThan(300);
  });

  test("passing near the end early (a route that loops back) isn't arriving", () => {
    // East 1000 m, north 300 m, west 1000 m, south 280 m: the end is 20 m north of the start.
    const loop: RoutePlan = {
      ...PLAN,
      lengthM: 2580,
      coordinates: [pt(0, 0), pt(1000, 0), pt(1000, 300), pt(0, 300), pt(0, 20)],
    };
    const g = new RouteGuidance(loop, [MANEUVERS[0], { ...MANEUVERS[2], atM: 2580, ...pt(0, 20) }]);
    expect(g.update(at(0, 5, 0)).state).toBe("on");
    expect(g.update(at(1, 15, 0)).state).toBe("on");
    expect(g.update(at(250, 0, 30, { headingRad: Math.PI })).state).toBe("arrived");
  });

  test("a U-turn at the start is the first instruction until the car has driven off", () => {
    const uTurnFirst = [MANEUVERS[0], maneuver("u-turn", 0, 0, 0), MANEUVERS[1], MANEUVERS[2]];
    const g = new RouteGuidance(PLAN, uTurnFirst);
    expect(uTurnFirst[g.update(at(0, 0, 0, { speedMps: 0 })).nextIndex].kind).toBe("u-turn");
    expect(uTurnFirst[g.update(at(3, 30, 0)).nextIndex].kind).toBe("left");
  });

  test("a maneuver close after the next comes with it ('then')", () => {
    const close = [MANEUVERS[0], MANEUVERS[1], maneuver("right", 1080, 1000, 80), MANEUVERS[2]];
    const g = new RouteGuidance(PLAN, close);
    expect(g.update(at(0, 900, 0)).thenIndex).toBe(2);
    expect(new RouteGuidance(PLAN, MANEUVERS).update(at(0, 900, 0)).thenIndex).toBeNull();
  });
});
