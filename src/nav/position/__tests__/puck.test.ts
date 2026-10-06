import type { MapMatchEstimate, NavEstimate } from "@/nav/navigator";
import { DRAW_ON_ROAD_MPS, puckHypothesis } from "@/nav/position/puck";

type Cluster = MapMatchEstimate["clusters"][number];
const field: Cluster = { weight: 0.9, lat: 51.5, lon: 31.3, headingRad: 1.6, spreadM: 8, edge: null, particles: 400, road: { lat: 51.5003, lon: 31.3, headingRad: 1.57 } };
const estimate = (state: MapMatchEstimate["state"], speedMps: number, top: Cluster = field) =>
  ({ speedMps, mapMatch: { state, clusters: [top], particles: 500, updateMs: 1 } }) as unknown as NavEstimate;

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
