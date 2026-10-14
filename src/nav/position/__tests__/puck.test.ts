import type { MapMatchEstimate, NavEstimate } from "@/nav/navigator";
import { DRAW_ON_ROAD_MPS, puckHypothesis } from "@/nav/position/puck";

type Cluster = MapMatchEstimate["clusters"][number];
const field: Cluster = { weight: 0.9, lat: 51.5, lon: 31.3, headingRad: 1.6, spreadM: 8, edge: null, particles: 400, road: { lat: 51.5003, lon: 31.3, headingRad: 1.57 } };
const estimate = (state: MapMatchEstimate["state"], speedMps: number, top: Cluster = field, mode: NavEstimate["mode"] = "dr") =>
  ({ mode, speedMps, mapMatch: { state, clusters: [top], particles: 500, updateMs: 1 } }) as unknown as NavEstimate;

describe("the dot while dead-reckoning on the map", () => {
  test("an off-road hypothesis at driving speed is drawn on the road it could be on", () => {
    expect(puckHypothesis(estimate("offroad", 12), true)).toMatchObject({ lat: 51.5003, lon: 31.3, headingRad: 1.57, weight: 0.9 });
  });

  test("at parking speed it stays where the filter has it: off the road is where cars park", () => {
    expect(puckHypothesis(estimate("offroad", DRAW_ON_ROAD_MPS - 0.5), true)).toMatchObject({ lat: 51.5, lon: 31.3 });
  });

  test("with no road in reach it stays too, and an on-road hypothesis is drawn as it is", () => {
    const { road: _, ...lost } = field;
    expect(puckHypothesis(estimate("offroad", 12, lost), true)).toMatchObject({ lat: 51.5, lon: 31.3 });
    expect(puckHypothesis(estimate("tracking", 12, { ...field, edge: 7 }), true)).toMatchObject({ lat: 51.5, lon: 31.3 });
  });

  test("with GNSS the EKF is the dot", () => {
    expect(puckHypothesis(estimate("offroad", 12), false)).toBeUndefined();
  });
});

describe("the dot while anchored (heading unknown)", () => {
  const onRoad = { ...field, edge: 7 };
  test("once the filter has found the road, its hypothesis is the dot, not the latest Wi-Fi/cell fix", () => {
    expect(puckHypothesis(estimate("tracking", 8, onRoad, "anchored"), false)).toMatchObject({ lat: 51.5, lon: 31.3 });
    expect(puckHypothesis(estimate("multimodal", 8, onRoad, "anchored"), false)).toMatchObject({ lat: 51.5, lon: 31.3 });
  });

  test("while it still searches every road around the fix, the fix stays the dot", () => {
    expect(puckHypothesis(estimate("init", 8, onRoad, "anchored"), false)).toBeUndefined();
  });
});

describe("the route tips which way the dot goes on a road", () => {
  // One road running north; the car somewhere on it, both directions alive (a jammed start, no turn yet).
  const north: Cluster = { weight: 0.3, lat: 50.432, lon: 30.516, headingRad: 0, spreadM: 5, edge: 7, particles: 150 };
  const south: Cluster = { ...north, weight: 0.7, headingRad: Math.PI, lat: 50.4318 };
  const clusters = (...c: Cluster[]) =>
    ({ mode: "anchored", speedMps: 15, mapMatch: { state: "multimodal", clusters: c, particles: 500, updateMs: 1 } }) as unknown as NavEstimate;
  const routeNorth = [
    { lat: 50.43, lon: 30.516 },
    { lat: 50.44, lon: 30.516 },
  ];

  test("a route north draws the northbound hypothesis though the other leans heavier", () => {
    expect(puckHypothesis(clusters(south, north), false, routeNorth)).toBe(north);
  });

  test("without a route, the heaviest; against a hypothesis more than four times likelier, the route gives way", () => {
    expect(puckHypothesis(clusters(south, north), false)).toBe(south);
    expect(puckHypothesis(clusters({ ...south, weight: 0.85 }, { ...north, weight: 0.15 }), false, routeNorth)).toMatchObject({ headingRad: Math.PI });
  });

  test("behind the route's start (where the car stood) a hypothesis heading away from it counts as against it", () => {
    const behind = (c: Cluster) => ({ ...c, lat: 50.43 - 66 / 111_320 });
    expect(puckHypothesis(clusters(behind(south), behind(north)), false, routeNorth)).toMatchObject({ headingRad: 0 });
  });

  test("a route elsewhere changes nothing", () => {
    const far = routeNorth.map((p) => ({ ...p, lon: p.lon + 0.01 }));
    expect(puckHypothesis(clusters(south, north), false, far)).toBe(south);
  });
});
