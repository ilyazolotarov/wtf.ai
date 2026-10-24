import { en } from "@/i18n/en";
import { MANEUVER_KINDS, type Maneuver } from "@/nav/routing/maneuvers";
import type { GuidanceStep } from "@/nav/routing/guidance";
import type { RoutePlan } from "@/nav/routing/router";
import type { RouteSnapshot } from "@/services/navigation/route-service";

import { carGuidance, MANEUVER_SYMBOL } from "../car-guidance";

const t = (key: keyof typeof en) => en[key];
const m = (kind: Maneuver["kind"], atM: number, exit?: number): Maneuver => ({ kind, atM, lat: 50.45, lon: 30.52, turnRad: 0, exit });

const plan = {
  legs: [],
  lengthM: 12_300,
  durationS: 1080,
  coordinates: [{ lat: 50.4, lon: 30.5 }, { lat: 50.45, lon: 30.52 }],
  offRoadM: { start: 0, end: 0 },
} as RoutePlan;

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

const route = (guidance: GuidanceStep, patch: Partial<RouteSnapshot> = {}): RouteSnapshot => ({
  destination: { lat: 50.45, lon: 30.52, name: "Kyiv" },
  status: "active",
  planId: 3,
  plan,
  maneuvers: [m("depart", 0), m("left", 2700), m("roundabout", 2800, 2), m("arrive", 12_300)],
  guidance,
  replanning: false,
  ...patch,
});

describe("car guidance", () => {
  test("nothing on the car's screen without a route being followed", () => {
    expect(carGuidance(null, t, "en")).toBeNull();
    expect(carGuidance(route(step({}), { status: "planning" }), t, "en")).toBeNull();
    expect(carGuidance(route(step({}), { status: "failed", plan: undefined }), t, "en")).toBeNull();
  });

  test("the next maneuver with the distance to it, and its time at the plan's pace", () => {
    const g = carGuidance(route(step({})), t, "en")!;
    expect(g.trip).toEqual({
      originLat: 50.4,
      originLon: 30.5,
      destinationLat: 50.45,
      destinationLon: 30.52,
      destinationName: "Kyiv",
      summary: "18 min · 12.3 km",
    });
    expect(g.maneuvers).toEqual([{ instruction: "Turn left", symbol: "arrow.turn.up.left", distanceM: 400, timeS: 36 }]);
    expect(g.estimates).toEqual({ toNextM: 400, toNextS: 36, remainingM: 10_000, remainingS: 900 });
    expect(g.arrived).toBe(false);
  });

  test("the maneuver after it when it follows closely, measured from the first", () => {
    const g = carGuidance(route(step({ thenIndex: 2 })), t, "en")!;
    expect(g.maneuvers.map((x) => [x.instruction, x.distanceM])).toEqual([
      ["Turn left", 400],
      ["At the roundabout, exit 2", 100],
    ]);
  });

  test("keys: the trip by destination, the maneuvers by plan and index", () => {
    const a = carGuidance(route(step({ toNextM: 400 })), t, "en")!;
    const closer = carGuidance(route(step({ toNextM: 300 })), t, "en")!;
    const replanned = carGuidance(route(step({}), { planId: 4 }), t, "en")!;
    const next = carGuidance(route(step({ nextIndex: 2 })), t, "en")!;
    expect(closer.maneuversKey).toBe(a.maneuversKey);
    expect(replanned.tripKey).toBe(a.tripKey);
    expect(replanned.maneuversKey).not.toBe(a.maneuversKey);
    expect(next.maneuversKey).not.toBe(a.maneuversKey);
  });

  test("arrival", () => {
    expect(carGuidance(route(step({ state: "arrived", nextIndex: 3, toNextM: 0 })), t, "en")!.arrived).toBe(true);
  });

  test("a symbol for every maneuver", () => {
    for (const kind of MANEUVER_KINDS) expect(MANEUVER_SYMBOL[kind]).toMatch(/^[a-z0-9.]+$/);
  });
});
