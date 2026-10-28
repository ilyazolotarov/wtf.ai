import { LocalFrame } from "@/nav/geo/local-frame";
import { EdgeFlag, Oneway, RoadClass } from "@/nav/mapmatch/graph/format";
import { MemoryRoadGraph } from "@/nav/mapmatch/graph/memory-graph";
import type { EdgeId } from "@/nav/mapmatch/graph/road-graph";
import type { SpeedCamera } from "@/nav/speed/cameras";
import { camerasAhead, camerasOnRoads, routeNext, startsFrom, type CameraOnRoad, type RoadPosition } from "@/nav/speed/road-ahead";

const frame = new LocalFrame({ lat: 50.45, lon: 30.52 });
const at = (e: number, n: number) => frame.toCoordinate(e, n);
const A = EdgeFlag.attributes | EdgeFlag.urban;
const rad = (deg: number) => (deg * Math.PI) / 180;

// An avenue north 2 km with a street off to the right at 600 m and a branch 30° left at 1200 m; apart, a dual
// carriageway at 1 km east: one-way north on its west side, one-way south 20 m east of it.
const graph = new MemoryRoadGraph(frame, [
  { cls: RoadClass.primary, flags: A, points: [at(0, 0), at(0, 600), at(0, 1200), at(0, 2000)] },
  { cls: RoadClass.residential, flags: A, points: [at(0, 600), at(800, 600)] },
  { cls: RoadClass.secondary, flags: A, points: [at(0, 1200), at(-500, 1200 + 866)] },
  { cls: RoadClass.trunk, flags: A, oneway: Oneway.forward, points: [at(1000, 0), at(1000, 1000)] },
  { cls: RoadClass.trunk, flags: A, oneway: Oneway.forward, points: [at(1020, 1000), at(1020, 0)] },
]);

const camera = (id: number, e: number, n: number, bearingDeg?: number): SpeedCamera => ({
  id,
  ...at(e, n),
  ...(bearingDeg !== undefined ? { bearingRad: rad(bearingDeg) } : {}),
  listed: true,
});

function onRoads(cameras: SpeedCamera[]): Map<EdgeId, CameraOnRoad[]> {
  const out = new Map<EdgeId, CameraOnRoad[]>();
  for (const r of camerasOnRoads(graph, frame, cameras)) out.set(r.edge, [...(out.get(r.edge) ?? []), r]);
  return out;
}

/** The car at (e, n) on the road there, heading `headingDeg`. */
function car(e: number, n: number, headingDeg: number, weight = 1): RoadPosition {
  const near = graph.edgesNear(e, n, 5)[0];
  const along = Math.cos(near.headingRad - rad(headingDeg)) > 0;
  return { edge: near.edge.id, dir: along ? 1 : -1, alongM: near.alongM, weight };
}

const ahead = (starts: RoadPosition[], cameras: SpeedCamera[], route?: ReturnType<typeof routeNext>) =>
  camerasAhead(graph, starts, onRoads(cameras), 1000, route).map((s) => ({ id: s.camera.id, m: Math.round(s.distanceM), share: s.share }));

describe("the cameras on the road ahead", () => {
  test("ahead and facing the car's traffic, at its distance along the road; behind it or facing the other way, none", () => {
    // On a pole 5 m off the avenue: north-bound traffic, south-bound, and one behind the car.
    const cams = [camera(1, 5, 400, 0), camera(2, 5, 450, 180), camera(3, 0, 50, 0)];
    expect(ahead([car(0, 100, 0)], cams)).toEqual([{ id: 1, m: 300, share: 1 }]);
    expect(ahead([car(0, 500, 180)], cams)).toEqual([{ id: 2, m: 50, share: 1 }]);
  });

  test("a camera without a direction checks both ways", () => {
    const cams = [camera(4, 0, 400)];
    expect(ahead([car(0, 100, 0)], cams)).toEqual([{ id: 4, m: 300, share: 1 }]);
    expect(ahead([car(0, 1000, 180)], cams)).toEqual([{ id: 4, m: 600, share: 1 }]);
  });

  test("straight on at a junction, not into the street off it; on a route, the route's way", () => {
    const street = camera(5, 300, 603, 90);
    expect(ahead([car(0, 100, 0)], [street])).toEqual([]);
    const legs = [car(0, 100, 0), car(300, 600, 90)].map(({ edge, dir }) => ({ edge, dir }));
    expect(ahead([car(0, 100, 0)], [street], routeNext(legs))).toEqual([{ id: 5, m: 800, share: 1 }]);
  });

  test("both ways of a fork, each at its own distance", () => {
    const cams = [camera(6, -250, 1200 + 433, 330), camera(7, 0, 1500, 0)];
    expect(ahead([car(0, 1000, 0)], cams)).toEqual([
      { id: 7, m: 500, share: 1 },
      { id: 6, m: 700, share: 1 },
    ]);
  });

  test("between one-way carriageways a camera checks only the side its direction says", () => {
    const cams = [camera(8, 1010, 500, 180)];
    expect(ahead([car(1000, 100, 0)], cams)).toEqual([]);
    expect(ahead([car(1020, 900, 180)], cams)).toEqual([{ id: 8, m: 400, share: 1 }]);
  });

  test("seen from several positions the car may be in: their shares add up, the heaviest's distance", () => {
    const cams = [camera(9, 0, 400, 0)];
    const [seen] = ahead([car(0, 100, 0, 0.3), car(0, 150, 0, 0.6)], cams);
    expect(seen).toMatchObject({ id: 9, m: 250 });
    expect(seen.share).toBeCloseTo(0.9, 9);
  });

  test("the positions to look from: on a road with a direction, heaviest first, shares of the whole", () => {
    const starts = startsFrom([
      { edge: 1, dir: 1, alongM: 10, weight: 2 },
      { edge: null, weight: 1.5 },
      { edge: 2, weight: 0.5 },
      { edge: 3, dir: -1, alongM: 5, weight: 1 },
    ]);
    expect(starts).toEqual([
      { edge: 1, dir: 1, alongM: 10, weight: 0.4 },
      { edge: 3, dir: -1, alongM: 5, weight: 0.2 },
    ]);
  });
});
