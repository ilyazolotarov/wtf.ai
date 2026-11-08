import { haversineM } from "@/nav/geo";
import { LocalFrame } from "@/nav/geo/local-frame";
import { EdgeFlag, Oneway, RoadClass } from "@/nav/mapmatch/graph/format";
import { MemoryRoadGraph } from "@/nav/mapmatch/graph/memory-graph";

import { roadLine, roadUnder, spotOnLine, straightOn } from "../road-follow";
import { RouteDrive } from "../route-drive";

const frame = new LocalFrame({ lat: 50.45, lon: 30.52 });
const at = (e: number, n: number) => frame.toCoordinate(e, n);
const rad = (deg: number) => (deg * Math.PI) / 180;
/** The turning bulb at a dead end: arcs of 6 m through 60°, 300° and 60°. */
const BULB_M = (7 * Math.PI * 6) / 3;

// An avenue north 1 km; at 400 m a street right (east) and one 20° left of straight on (north-north-west) — the
// avenue bends 30° right there; at its end a dead end. A one-way street south 300 m east of it; a driveway beside the
// avenue's start.
const graph = new MemoryRoadGraph(frame, [
  { cls: RoadClass.primary, points: [at(0, 0), at(0, 400), at(300, 920)] },
  { cls: RoadClass.residential, points: [at(0, 400), at(600, 400)] },
  { cls: RoadClass.residential, points: [at(0, 400), at(-137, 776)] },
  { cls: RoadClass.residential, oneway: Oneway.forward, points: [at(300, 1000), at(300, 0)] },
  { cls: RoadClass.service, flags: EdgeFlag.minorService, points: [at(10, 0), at(10, 200)] },
]);
const edgeAt = (e: number, n: number) => graph.edgesNear(e, n, 2)[0].edge.id;

describe("the road a car without a route follows", () => {
  test("the road under the car, the way it heads; a driveway beside it only counts as farther", () => {
    expect(roadUnder(graph, frame, at(5, 100), 0)).toMatchObject({ edge: edgeAt(0, 100), dir: 1 });
    expect(roadUnder(graph, frame, at(5, 100), Math.PI)).toMatchObject({ edge: edgeAt(0, 100), dir: -1 });
    expect(roadUnder(graph, frame, at(5, 100))).toMatchObject({ edge: edgeAt(0, 100), dir: 1 });
    expect(roadUnder(graph, frame, at(500, 2000), 0)).toBeNull();
  });

  test("never the wrong way along a one-way: the road beside it, or none", () => {
    // Heading north on the one-way south: the nearest road the right way is the avenue 300 m off: too far.
    expect(roadUnder(graph, frame, at(300, 100), 0)).toBeNull();
    expect(roadUnder(graph, frame, at(300, 100), Math.PI)).toMatchObject({ edge: edgeAt(300, 100), dir: 1 });
    // No heading: the way it allows.
    expect(roadUnder(graph, frame, at(300, 100))).toMatchObject({ dir: 1 });
  });

  test("straight on at a junction: the least turn, whether the road or a side street", () => {
    // From the south: the side street turns 20° left, the avenue 30° right, the street east 90°.
    const x = straightOn(graph, edgeAt(0, 100), 1)!;
    expect(x.edge).toBe(edgeAt(-68, 588));
    expect(Math.abs(x.turnRad)).toBeCloseTo(rad(20), 1);
  });

  test("the line along the road, straight on, back round a bulb at a dead end, as long as asked", () => {
    const line = roadLine(graph, { edge: edgeAt(0, 100), dir: 1, alongM: 100 }, 1000);
    expect(line.ends).toBe(false);
    expect(haversineM(line.points[0], at(0, 100))).toBeLessThan(0.5);
    // On along the side street to its dead end (300 + 400 m), round the bulb past it (44 m), then back.
    expect(line.points.some((p) => haversineM(p, at(-137, 776)) < 0.5)).toBe(true);
    const drive = new RouteDrive(line.points);
    expect(drive.lengthM).toBeCloseTo(300 + 400 + BULB_M + 400, -1);
    // The bulb turns the car a half turn left, on a road's radius.
    let turned = 0;
    let fastest = 0;
    for (let t = 0; t < 300 && !drive.point().arrived; t += 0.05) {
      drive.step(0.05);
      turned += drive.yawRate() * 0.05;
      fastest = Math.max(fastest, Math.abs(drive.yawRate()));
    }
    // 20° left onto the side street, then the bulb.
    expect(turned).toBeCloseTo(Math.PI + rad(20), 1);
    expect(fastest).toBeLessThan(1.2);
    expect(line.stretches.map((s) => s.edge)).toEqual([edgeAt(0, 100), edgeAt(-68, 588), edgeAt(-68, 588)]);
    expect(line.stretches.map((s) => s.dir)).toEqual([1, 1, -1]);
  });

  test("a one-way's end where no way goes on: the road ends", () => {
    // At the one-way's southern end nothing goes on, and back is against it.
    const line = roadLine(graph, { edge: edgeAt(300, 500), dir: 1, alongM: 500 }, 3000);
    expect(line.ends).toBe(true);
    expect(haversineM(line.points.at(-1)!, at(300, 0))).toBeLessThan(0.5);
  });

  test("where along the line the car is, on the roads", () => {
    const line = roadLine(graph, { edge: edgeAt(0, 100), dir: 1, alongM: 100 }, 1000);
    const drive = new RouteDrive(line.points);
    const alongTo = (i: number) => drive.alongTo(i);
    expect(spotOnLine(graph, line, 200, alongTo)).toMatchObject({ edge: edgeAt(0, 100), dir: 1 });
    expect(spotOnLine(graph, line, 200, alongTo).alongM).toBeCloseTo(300, 0);
    const back = spotOnLine(graph, line, 900, alongTo);
    expect(back).toMatchObject({ edge: edgeAt(-68, 588), dir: -1 });
    // 300 m to the junction, 400 m up the side street, round the bulb, 156 m back down it.
    expect(back.alongM).toBeCloseTo(400 - (900 - 700 - BULB_M), 0);
  });
});
