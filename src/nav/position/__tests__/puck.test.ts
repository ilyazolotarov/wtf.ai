import type { MapMatchEstimate, NavEstimate } from "@/nav/navigator";
import { DRAW_ON_ROAD_MPS, puckHypothesis, steadyDot, type DrawnDot } from "@/nav/position/puck";

type Cluster = MapMatchEstimate["clusters"][number];
const field: Cluster = { weight: 0.9, lat: 51.5, lon: 31.3, headingRad: 1.6, spreadM: 8, edge: null, particles: 400, road: { lat: 51.5003, lon: 31.3, headingRad: 1.57 } };
// An on-road hypothesis has no road of its own to be drawn on (the navigator snaps only off-road ones).
const { road: _road, ...onRoadBase } = field;
const onRoadCluster: Cluster = { ...onRoadBase, edge: 7 };
const estimate = (state: MapMatchEstimate["state"], speedMps: number, top: Cluster = field, mode: NavEstimate["mode"] = "dr") =>
  ({ mode, speedMps, mapMatch: { state, clusters: [top], particles: 500, updateMs: 1 } }) as unknown as NavEstimate;

describe("the dot while dead-reckoning on the map", () => {
  test("an off-road hypothesis at driving speed is drawn on the road it could be on", () => {
    expect(puckHypothesis(estimate("offroad", 12), true)).toMatchObject({ lat: 51.5003, lon: 31.3, headingRad: 1.57, weight: 0.9 });
  });

  // 2026-10-15: the state flickered between offroad and multimodal around half the weight off-road.
  test("so it is whatever the state: off-road weight under half doesn't move it off its road", () => {
    expect(puckHypothesis(estimate("multimodal", 12), true)).toMatchObject({ lat: 51.5003, lon: 31.3 });
  });

  test("at parking speed it stays where the filter has it: off the road is where cars park", () => {
    expect(puckHypothesis(estimate("offroad", DRAW_ON_ROAD_MPS - 0.5), true)).toMatchObject({ lat: 51.5, lon: 31.3 });
  });

  test("with no road in reach it stays too, and an on-road hypothesis is drawn as it is", () => {
    const { road: _, ...lost } = field;
    expect(puckHypothesis(estimate("offroad", 12, lost), true)).toMatchObject({ lat: 51.5, lon: 31.3 });
    expect(puckHypothesis(estimate("tracking", 12, onRoadCluster), true)).toMatchObject({ lat: 51.5, lon: 31.3 });
  });

  test("with GNSS the EKF is the dot", () => {
    expect(puckHypothesis(estimate("offroad", 12), false)).toBeUndefined();
  });
});

describe("the dot while anchored (heading unknown)", () => {
  const onRoad = onRoadCluster;
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

describe("the car's own heading tips which way the dot goes", () => {
  // Mid-turn at a T-junction: right-turn and left-turn particles on the same cross street, travelling opposite ways.
  const right: Cluster = { weight: 0.45, lat: 50.432, lon: 30.516, headingRad: 0.3, spreadM: 5, edge: 7, particles: 150 };
  const left: Cluster = { ...right, weight: 0.55, headingRad: 0.3 + Math.PI };
  const turning = (headingRad: number, headingSigmaRad: number) =>
    ({ mode: "dr", speedMps: 6, headingRad, headingSigmaRad, mapMatch: { state: "multimodal", clusters: [left, right], particles: 500, updateMs: 1 } }) as unknown as NavEstimate;

  test("the navigator turning right (gyro) draws the right-turn hypothesis though the other leans heavier", () => {
    // Half-way through the turn from 288° to 17°.
    expect(puckHypothesis(turning(-0.6, 0.05), true)).toBe(right);
  });

  test("a heading the navigator isn't sure of is no cue", () => {
    expect(puckHypothesis(turning(-0.6, 1), true)).toBe(left);
  });
});

describe("the dot keeps steady along its road", () => {
  const north = (m: number) => ({ lat: 50.45 + m / 111_320, lon: 30.52, headingRad: 0 });
  const last = (m: number, tUs = 0): DrawnDot => ({ ...north(m), tUs });

  test("a hypothesis a few metres behind where the dot has driven to doesn't pull it back", () => {
    // 1 s at 10 m/s from 0: the dot is at 10 m; the hypothesis at 4 m (the cloud resampled back).
    const d = steadyDot(north(4), last(0), 10, 1_000_000);
    expect((d.lat - 50.45) * 111_320).toBeCloseTo(9, 0); // back 1 m/s at most: 10 − 1
  });

  test("ahead, it catches up at 8 m/s faster than it drove, held at most 15 m behind the hypothesis", () => {
    const d = steadyDot(north(40), last(0), 10, 1_000_000);
    expect((d.lat - 50.45) * 111_320).toBeCloseTo(25, 0); // 18 m by the rate, but never more than 15 m behind it
  });

  test("round a turn it glides to the hypothesis at 25 m/s instead of jumping", () => {
    // Standing at 0, the hypothesis 40 m east on a road east: 0.4 s later the dot is 10 m toward it.
    const east = { lat: 50.45, lon: 30.52 + 40 / (111_320 * Math.cos((50.45 * Math.PI) / 180)), headingRad: Math.PI / 2 };
    const d = steadyDot(east, last(0), 0, 400_000);
    expect((d.lon - 30.52) * 111_320 * Math.cos((50.45 * Math.PI) / 180)).toBeCloseTo(10, 0);
    // Within reach, it is there.
    expect(steadyDot(east, last(0), 0, 2_000_000)).toMatchObject({ lon: east.lon });
  });

  test("across its road it glides at 25 m/s too", () => {
    // The hypothesis 20 m to the side, on the dot's road heading: 0.2 s later 5 m across.
    const side = { lat: 50.45, lon: 30.52 + 20 / (111_320 * Math.cos((50.45 * Math.PI) / 180)), headingRad: 0 };
    const d = steadyDot(side, last(0), 0, 200_000);
    expect((d.lon - 30.52) * 111_320 * Math.cos((50.45 * Math.PI) / 180)).toBeCloseTo(5, 0);
  });

  test("a hypothesis far away is drawn as it is", () => {
    expect(steadyDot(north(200), last(0), 10, 1_000_000)).toMatchObject({ lat: north(200).lat });
  });
});
