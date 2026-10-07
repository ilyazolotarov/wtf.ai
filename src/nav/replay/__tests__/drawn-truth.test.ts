import { readFileSync } from "node:fs";
import path from "node:path";

import { haversineM } from "@/nav/geo";
import { LocalFrame } from "@/nav/geo/local-frame";
import { bufferByteSource } from "@/nav/mapmatch/graph/byte-source";
import { TiledRoadGraph } from "@/nav/mapmatch/graph/road-graph";
import { drawnTruthTrack, drawPath, isDetour, OFF_PATH_M, scoreDrawn } from "@/nav/replay/drawn-truth";
import type { GnssFix, ObdSpeedSample } from "@/nav/types";
import type { TripLog } from "@/triplog/trip-log-reader";

// The fixture's long road (tools/tiles tests/test_graph.py): 60 —160— 61 —161— 63 due east at 51.53 N from
// 30.75 E, 61 at 30.775 E, and the one-way 162 from 61 north to 62 (51.534 N).
const FIXTURE = readFileSync(path.join(__dirname, "../../mapmatch/__fixtures__/net.graph.bin"));
const frame = new LocalFrame({ lat: 51.53, lon: 30.77 });
const graph = () => new TiledRoadGraph(bufferByteSource(new Uint8Array(FIXTURE)), frame);
const NODE_61 = { lat: 51.53, lon: 30.775 };
const START_US = 1_000_000_000;

const near = (p: [number, number][], c: { lat: number; lon: number }) => Math.min(...p.map(([lat, lon]) => haversineM({ lat, lon }, c)));

describe("drawPath", () => {
  test("a road route far longer than the line between its clicks is a way the map lacks, not one driven", () => {
    // gaz9bc: two clicks 12 m apart at a yard's entrance, joined by the roads only 733 m round.
    expect(isDetour(733, 12)).toBe(true);
    // A route round a junction (the next test: 1260 m for 1070 m), a hairpin, a short way round a block.
    expect(isDetour(1260, 1070)).toBe(false);
    expect(isDetour(90, 20)).toBe(false);
    expect(isDetour(400, 150)).toBe(false);
  });

  test("between two clicks it follows the roads, round the junction", () => {
    // On 160 west of 61, then on 162 north of it.
    const { path: p, legs } = drawPath(graph(), frame, [
      { lat: 51.5301, lon: 30.76 },
      { lat: 51.532, lon: 30.7751 },
    ]);
    expect(legs).toHaveLength(1);
    expect(legs[0].kind).toBe("road");
    // 15 thousandths of a degree east (1037 m), then 2 thousandths north (222 m).
    expect(legs[0].lengthM).toBeGreaterThan(1250);
    expect(legs[0].lengthM).toBeLessThan(1270);
    expect(near(p, NODE_61)).toBeLessThan(1);
    // The ends are on the roads, not where the clicks were.
    expect(haversineM({ lat: p[0][0], lon: p[0][1] }, { lat: 51.53, lon: 30.76 })).toBeLessThan(1);
  });

  test("against a one-way too: the car went where it went", () => {
    // 162 runs north only: from it, south and west along 160.
    const { legs } = drawPath(graph(), frame, [
      { lat: 51.532, lon: 30.7751 },
      { lat: 51.5301, lon: 30.76 },
    ]);
    expect(legs[0].kind).toBe("road");
    expect(legs[0].lengthM).toBeGreaterThan(1250);
    expect(legs[0].lengthM).toBeLessThan(1270);
  });

  test("straight where asked, or where a click is off the roads", () => {
    const { path: p, legs } = drawPath(graph(), frame, [
      { lat: 51.5301, lon: 30.76 },
      { lat: 51.5301, lon: 30.765, straight: true },
      { lat: 51.527, lon: 30.765 }, // 330 m south of the road: a field
    ]);
    expect(legs.map((l) => [l.kind, l.reason])).toEqual([
      ["straight", "asked"],
      ["straight", "off the roads"],
    ]);
    // The middle point leaves by a stretch asked along the roads, so it is on its road (11 m from the click); the
    // field point is where it was clicked.
    expect(near(p, { lat: 51.53, lon: 30.765 })).toBeLessThan(0.5);
    expect(p.at(-1)).toEqual([51.527, 30.765]);
  });

  // 1 m of latitude, and of longitude along 51.53 N.
  const latM = 1 / 111_195;
  const lonM = 1 / (111_195 * Math.cos((51.53 * Math.PI) / 180));

  test("a car park: clicks off the roads in a row are joined straight, and to the road nearest them", () => {
    const { path: p, legs, straightM } = drawPath(graph(), frame, [
      { lat: 51.53, lon: 30.76 },
      { lat: 51.53, lon: 30.765 },
      { lat: 51.53 - 22 * latM, lon: 30.765 + 10 * lonM }, // 22 m south of the road: a car park the map lacks
      { lat: 51.53 - 22 * latM, lon: 30.765 + 50 * lonM },
      { lat: 51.53, lon: 30.77 },
    ]);
    expect(legs.map((l) => [l.kind, l.reason])).toEqual([["road", undefined], ["road", undefined], ["straight", "off the roads"], ["road", undefined]]);
    // Drawn where clicked, not on the road beside them.
    expect(near(p, { lat: 51.53 - 22 * latM, lon: 30.765 + 10 * lonM })).toBeLessThan(0.5);
    expect(near(p, { lat: 51.53 - 22 * latM, lon: 30.765 + 50 * lonM })).toBeLessThan(0.5);
    // Off the road at 30.765 + 10 m, 22 m south, 40 m along, 22 m back north: one straight stretch for the timing.
    expect(straightM).toHaveLength(1);
    expect(straightM![0][1] - straightM![0][0]).toBeGreaterThan(84);
    expect(straightM![0][1] - straightM![0][0]).toBeLessThan(86);
  });

  test("a click alone beside the road on the way is on it; at the drive's end, where it parked, as clicked", () => {
    const { path: p, legs, straightM } = drawPath(graph(), frame, [
      { lat: 51.53, lon: 30.76 },
      { lat: 51.53 - 17 * latM, lon: 30.765 },
      { lat: 51.53, lon: 30.77 },
      { lat: 51.53 - 17 * latM, lon: 30.772 },
    ]);
    expect(legs.every((l) => l.kind === "road")).toBe(true);
    expect(near(p, { lat: 51.53, lon: 30.765 })).toBeLessThan(0.5);
    expect(near(p, { lat: 51.53 - 17 * latM, lon: 30.765 })).toBeGreaterThan(16);
    expect(p.at(-1)).toEqual([51.53 - 17 * latM, 30.772]);
    expect(straightM).toHaveLength(1);
    expect(straightM![0][1] - straightM![0][0]).toBeCloseTo(17, 0);
  });
});

/** A drive along a straight path at a constant true speed: OBD reads `obdScale` × it (`obdScale2` from halfway). */
function drive(o: { metres: number; speedMps: number; obdScale: number; obdScale2?: number; parkedS: number; fixesAtS?: number[]; pathAt(m: number): { lat: number; lon: number } }): TripLog {
  const driveS = o.metres / o.speedMps;
  const obdSpeed: ObdSpeedSample[] = [];
  const total = 2 * o.parkedS + driveS;
  for (let t = 0; t <= total + 1e-9; t += 0.1) {
    const moving = t > o.parkedS && t < o.parkedS + driveS;
    const scale = o.obdScale2 !== undefined && t > o.parkedS + driveS / 2 ? o.obdScale2 : o.obdScale;
    const v = moving ? o.speedMps * scale : 0;
    obdSpeed.push({ tUs: START_US + Math.round(t * 1e6), speedMps: v, rawKph: Math.round(v * 3.6) });
  }
  const gnss: GnssFix[] = (o.fixesAtS ?? []).map((t) => ({
    tUs: START_US + t * 1e6,
    ...o.pathAt(Math.max(0, Math.min(o.metres, (t - o.parkedS) * o.speedMps))),
    hAccM: 5,
    speedMps: o.speedMps,
    speedAccMps: 0.3,
    courseRad: Math.PI / 2,
    courseAccRad: 0.05,
  }));
  return {
    startUs: START_US, info: {}, imu: [], mag: [], obdSpeed, gnss, engine: [], rpm: [], events: [], timeSync: [], messages: [], navEstimate: [], navMapMatch: [], navRoute: [], navRoutePoints: [], navRouteManeuvers: [], navRouteProgress: [], truncated: false,
  };
}

describe("drawnTruthTrack", () => {
  // 2 km due east along 51.53 N.
  const lonPerM = 1 / (111_195 * Math.cos((51.53 * Math.PI) / 180));
  const pathAt = (m: number) => ({ lat: 51.53, lon: 30.76 + m * lonPerM });
  const truth = { path: [[51.53, 30.76], [51.53, pathAt(1000).lon], [51.53, pathAt(2000).lon]] as [number, number][] };
  const truthAt = (track: ReturnType<typeof drawnTruthTrack>, t: number) => {
    const p = track.points.find((x) => Math.abs(x[0] - t) < 1e-6)!;
    return { lat: p[1], lon: p[2] };
  };

  test("the drive's ends fix the odometer's scale: parked, then along the path, then parked at its end", () => {
    const trip = drive({ metres: 2000, speedMps: 10, obdScale: 1.03, parkedS: 20, pathAt });
    const track = drawnTruthTrack(trip, truth);
    expect(track.pathM).toBeCloseTo(2000, -1);
    expect(track.odometerM).toBeCloseTo(2060, -1);
    expect(track.anchors).toBe(0);
    expect(haversineM(truthAt(track, 10), pathAt(0))).toBeLessThan(1);
    expect(haversineM(truthAt(track, 20 + 100), pathAt(1000))).toBeLessThan(2);
    expect(haversineM(truthAt(track, 20 + 200 + 10), pathAt(2000))).toBeLessThan(1);
  });

  test("a car park drawn as a zigzag, three times what was driven there, doesn't push the car ahead on the road", () => {
    // 100 m in the car park, then 2 km of road: drawn 300 m back and forth south of the road's start, then the road.
    const yard = { lat: 51.53 - 100 / 111_195, lon: 30.76 };
    const road = truth.path;
    const zigzag = { path: [[yard.lat, yard.lon], road[0], [yard.lat, yard.lon], ...road] as [number, number][], straightM: [[0, 300]] as [number, number][] };
    const trip = drive({ metres: 2100, speedMps: 10, obdScale: 1, parkedS: 20, pathAt });
    // 1100 m driven: 1000 m along the road.
    const at = (track: ReturnType<typeof drawnTruthTrack>) => haversineM(truthAt(track, 20 + 110), pathAt(1000));
    expect(at(drawnTruthTrack(trip, zigzag))).toBeLessThan(20);
    expect(at(drawnTruthTrack(trip, { ...zigzag, straightM: [] }))).toBeGreaterThan(80);
  });

  test("a clean fix near the path pins the timing where the odometer was wrong", () => {
    // OBD reads 20 % high for the first half and 20 % low for the second: the ends agree, the middle doesn't.
    const odometerOnly = drawnTruthTrack(drive({ metres: 2000, speedMps: 10, obdScale: 1.2, obdScale2: 0.8, parkedS: 20, pathAt }), truth);
    expect(haversineM(truthAt(odometerOnly, 20 + 50), pathAt(500))).toBeGreaterThan(80);
    const pinned = drawnTruthTrack(drive({ metres: 2000, speedMps: 10, obdScale: 1.2, obdScale2: 0.8, parkedS: 20, fixesAtS: [20 + 50], pathAt }), truth);
    expect(pinned.anchors).toBe(1);
    expect(haversineM(truthAt(pinned, 20 + 50), pathAt(500))).toBeLessThan(2);
  });
});

describe("scoreDrawn", () => {
  const lonPerM = 1 / (111_195 * Math.cos((51.53 * Math.PI) / 180));
  const pathAt = (m: number) => ({ lat: 51.53, lon: 30.76 + m * lonPerM });
  const trip = drive({ metres: 2000, speedMps: 10, obdScale: 1, parkedS: 20, pathAt });
  const truth = drawnTruthTrack(trip, { path: [[51.53, 30.76], [51.53, pathAt(2000).lon]] });
  const shown = (northM: number, lagM = 0) =>
    truth.points.map(([t, , , s]) => ({ t, ...pathAt(Math.max(0, s - lagM)), acc: 10, lat: 51.53 + northM / 111_195 }));

  test("a dot on the path scores zero, one on a road beside it the whole drive", () => {
    const on = scoreDrawn(trip, truth, shown(0));
    expect(on.movingS).toBeGreaterThan(190);
    expect(on.offPathS).toBe(0);
    expect(on.errorMaxM).toBeLessThan(1);
    const beside = scoreDrawn(trip, truth, shown(60));
    expect(beside.offPathS).toBe(beside.movingS);
    expect(beside.offPathMedianM).toBeGreaterThan(OFF_PATH_M);
    expect(beside.endErrorM).toBeCloseTo(60, 0);
  });

  test("a dot behind on the right road is on the path, and off in time", () => {
    const late = scoreDrawn(trip, truth, shown(0, 150));
    expect(late.offPathS).toBe(0);
    expect(late.errorMedianM).toBeCloseTo(150, -1);
  });
});
