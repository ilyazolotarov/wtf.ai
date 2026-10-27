// What Android Auto's screen shows of the route (car-guidance.ts, docs/ANDROID-AUTO-SPEC.md §4).

import { en } from "@/i18n/en";
import type { GuidanceStep } from "@/nav/routing/guidance";
import type { Maneuver } from "@/nav/routing/maneuvers";
import type { RoutePlan } from "@/nav/routing/router";
import type { RouteSnapshot } from "@/services/navigation/route-service";

import { carDistance, carRoute } from "../car-guidance";

const t = (key: keyof typeof en) => en[key];
const m = (kind: Maneuver["kind"], atM: number, exit?: number): Maneuver => ({ kind, atM, lat: 50.45, lon: 30.52, turnRad: 0, exit });

const plan = {
  legs: [],
  lengthM: 12_300,
  durationS: 1080,
  coordinates: [
    { lat: 50.4, lon: 30.5 },
    { lat: 50.45, lon: 30.52 },
  ],
  offRoadM: { start: 0, end: 0 },
} as unknown as RoutePlan;

const step = (patch: Partial<GuidanceStep>): GuidanceStep => ({
  state: "on",
  alongM: 0,
  offM: 0,
  remainingM: 10_000,
  remainingS: 900,
  nextIndex: 1,
  toNextM: 400,
  thenIndex: null,
  passedIndex: 0,
  progressAt: { lat: 50.4, lon: 30.5 },
  ...patch,
});

const route = (guidance: GuidanceStep | undefined, patch: Partial<RouteSnapshot> = {}): RouteSnapshot => ({
  destination: { lat: 50.45, lon: 30.52, name: "Kyiv" },
  status: "active",
  planId: 3,
  plan,
  maneuvers: [m("depart", 0), m("left", 2700), m("roundabout", 2800, 2), m("arrive", 12_300)],
  guidance,
  replanning: false,
  ...patch,
});

describe("car distance", () => {
  test("rounded as the phone's banner rounds it", () => {
    expect(carDistance(123)).toEqual({ shown: 120, unit: "m" });
    expect(carDistance(437)).toEqual({ shown: 450, unit: "m" });
    expect(carDistance(2_345)).toEqual({ shown: 2.3, unit: "km1" });
    expect(carDistance(123_456)).toEqual({ shown: 123, unit: "km" });
    expect(carDistance(-5)).toEqual({ shown: 0, unit: "m" });
  });
});

describe("car route", () => {
  test("none without a route", () => {
    expect(carRoute(null, t, "en")).toBeNull();
  });

  test("planning says so", () => {
    expect(carRoute(route(undefined, { status: "planning", plan: undefined }), t, "en")).toMatchObject({ status: "planning", message: en.planningRoute, steps: [] });
  });

  test("a plan without progress on it yet (an alternative taken at a stop) shows from its start, as the phone's banner", () => {
    const r = carRoute(route(undefined), t, "en")!;
    expect(r).toMatchObject({ status: "active", message: null, remainingM: 12_300, remainingS: 1080, remainingShown: 12.3, remainingUnit: "km1" });
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]).toMatchObject({ instruction: "Turn left", distanceM: 2700, shownDistance: 2.7, shownUnit: "km1" });
    expect(r.steps[0].timeS).toBeCloseTo(237.1, 1);
  });

  test("a failed plan says why", () => {
    expect(carRoute(route(undefined, { status: "failed", failure: "no-route" }), t, "en")).toMatchObject({ status: "failed", message: en.routeNoRoute });
    expect(carRoute(route(undefined, { status: "failed" }), t, "en")).toMatchObject({ status: "failed", message: en.routeCancelled });
  });

  test("CarPlay's failures name no phone screen (Apple's guidelines); Android Auto's keep the phone's words", () => {
    const noMap = route(undefined, { status: "failed", failure: "no-road-graph" });
    expect(carRoute(noMap, t, "en")).toMatchObject({ message: en.routeNoRoadGraph });
    expect(carRoute(noMap, t, "en", [], true)).toMatchObject({ message: en.carPlayNoRoadGraph });
    expect(carRoute(route(undefined, { status: "failed", failure: "no-route" }), t, "en", [], true)).toMatchObject({ message: en.routeNoRoute });
  });

  test("the next maneuver with the distance to it, its time at the plan's pace, and what is left", () => {
    const r = carRoute(route(step({})), t, "en")!;
    expect(r).toMatchObject({
      status: "active",
      destinationName: "Kyiv",
      destinationLat: 50.45,
      destinationLon: 30.52,
      replanning: false,
      remainingM: 10_000,
      remainingS: 900,
      remainingShown: 10,
      remainingUnit: "km1",
    });
    expect(r.steps).toEqual([
      {
        id: "left:@50.45000,30.52000",
        kind: "left",
        exit: null,
        instruction: "Turn left",
        distanceM: 400,
        timeS: 36,
        shownDistance: 400,
        shownUnit: "m",
        distanceText: "400 m",
      },
    ]);
  });

  test("the distance written in the app's language, for the notification", () => {
    const r = carRoute(route(step({ toNextM: 1_234 })), t, "uk")!;
    expect(r.steps[0].distanceText).toBe("1,2 км");
  });

  test("a maneuver keeps its id across plans, and two at one place differ", () => {
    const a = carRoute(route(step({ thenIndex: 2 })), t, "en")!;
    const b = carRoute(route(step({ thenIndex: 2 }), { planId: 4, maneuvers: [m("depart", 0), m("left", 900), m("roundabout", 1000, 2), m("arrive", 9000)] }), t, "en")!;
    expect(b.steps.map((s) => s.id)).toEqual(a.steps.map((s) => s.id));
    expect(a.steps[0].id).not.toBe(a.steps[1].id);
  });

  test("the maneuver after it when it follows closely, measured from the car as the trip's estimates are", () => {
    const r = carRoute(route(step({ thenIndex: 2 })), t, "en")!;
    expect(r.steps.map((s) => [s.instruction, s.distanceM, s.timeS, s.shownDistance, s.exit])).toEqual([
      ["Turn left", 400, 36, 400, null],
      ["At the roundabout, exit 2", 500, 45, 500, 2],
    ]);
  });

  test("planning again keeps the route, flagged, and says so", () => {
    expect(carRoute(route(step({}), { replanning: true }), t, "en")).toMatchObject({ status: "active", replanning: true, message: en.planningRoute });
  });

  test("arrival", () => {
    expect(carRoute(route(step({ state: "arrived", nextIndex: 3, toNextM: 0, remainingM: 0, remainingS: 0 })), t, "en")).toMatchObject({
      status: "arrived",
      message: en.arrived,
      steps: [],
    });
  });

  test("the other ways to choose from, timed against the route, each with its own time and distance", () => {
    const slower = { plan: { ...plan, lengthM: 13_100, durationS: 1260 }, deltaS: 180, labelAt: { lat: 50.4, lon: 30.5 } };
    const same = { plan: { ...plan, lengthM: 12_900, durationS: 1100 }, deltaS: 20, labelAt: { lat: 50.4, lon: 30.5 } };
    const r = carRoute(route(step({}), { alternatives: [slower, same] }), t, "en")!;
    expect(r.detail).toBe("18 min · 12.3 km");
    expect(r.alternatives).toEqual([
      { index: 0, title: "+3 min", detail: "21 min · 13.1 km" },
      { index: 1, title: "Same time", detail: "18 min · 12.9 km" },
    ]);
  });

  test("each way by the street it goes by, how it compares after it", () => {
    const slower = { plan: { ...plan, lengthM: 13_100, durationS: 1260 }, deltaS: 180, labelAt: { lat: 50.4, lon: 30.5 } };
    const other = { plan, deltaS: -60, labelAt: { lat: 50.4, lon: 30.5 } };
    const r = carRoute(route(step({}), { alternatives: [slower, other] }), t, "en", ["Khreshchatyk Street", "Naberezhne Highway", null])!;
    expect(r.title).toBe("Khreshchatyk Street");
    expect(r.detail).toBe("This route · 18 min · 12.3 km");
    expect(r.alternatives).toEqual([
      { index: 0, title: "Naberezhne Highway", detail: "+3 min · 21 min · 13.1 km" },
      { index: 1, title: "−1 min", detail: "18 min · 12.3 km" },
    ]);
  });

  test("none to choose while planning again or once arrived", () => {
    const alternatives = [{ plan, deltaS: 180, labelAt: { lat: 50.4, lon: 30.5 } }];
    expect(carRoute(route(step({}), { alternatives, replanning: true }), t, "en")!.alternatives).toEqual([]);
    const arrived = step({ state: "arrived", nextIndex: 3, toNextM: 0, remainingM: 0, remainingS: 0 });
    expect(carRoute(route(arrived, { alternatives }), t, "en")!.alternatives).toEqual([]);
  });
});
