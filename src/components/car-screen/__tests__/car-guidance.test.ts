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
    expect(carRoute(null, t)).toBeNull();
  });

  test("planning, and a plan without progress on it yet, say so", () => {
    expect(carRoute(route(undefined, { status: "planning", plan: undefined }), t)).toMatchObject({ status: "planning", message: en.planningRoute, steps: [] });
    expect(carRoute(route(undefined), t)).toMatchObject({ status: "planning" });
  });

  test("a failed plan says why", () => {
    expect(carRoute(route(undefined, { status: "failed", failure: "no-route" }), t)).toMatchObject({ status: "failed", message: en.routeNoRoute });
    expect(carRoute(route(undefined, { status: "failed" }), t)).toMatchObject({ status: "failed", message: en.routeCancelled });
  });

  test("the next maneuver with the distance to it, its time at the plan's pace, and what is left", () => {
    const r = carRoute(route(step({})), t)!;
    expect(r).toMatchObject({
      status: "active",
      destinationName: "Kyiv",
      replanning: false,
      remainingM: 10_000,
      remainingS: 900,
      remainingShown: 10,
      remainingUnit: "km1",
    });
    expect(r.steps).toEqual([
      { kind: "left", exit: null, instruction: "Turn left", distanceM: 400, timeS: 36, shownDistance: 400, shownUnit: "m" },
    ]);
  });

  test("the maneuver after it when it follows closely, measured from the car as the trip's estimates are", () => {
    const r = carRoute(route(step({ thenIndex: 2 })), t)!;
    expect(r.steps.map((s) => [s.instruction, s.distanceM, s.timeS, s.shownDistance, s.exit])).toEqual([
      ["Turn left", 400, 36, 400, null],
      ["At the roundabout, exit 2", 500, 45, 500, 2],
    ]);
  });

  test("planning again keeps the route, flagged", () => {
    expect(carRoute(route(step({}), { replanning: true }), t)).toMatchObject({ status: "active", replanning: true });
  });

  test("arrival", () => {
    expect(carRoute(route(step({ state: "arrived", nextIndex: 3, toNextM: 0, remainingM: 0, remainingS: 0 })), t)).toMatchObject({
      status: "arrived",
      message: en.arrived,
      steps: [],
    });
  });
});
