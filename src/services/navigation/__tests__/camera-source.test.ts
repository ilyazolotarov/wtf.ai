import { LocalFrame } from "@/nav/geo/local-frame";
import { EdgeFlag, RoadClass } from "@/nav/mapmatch/graph/format";
import { MemoryRoadGraph } from "@/nav/mapmatch/graph/memory-graph";
import type { PositionEstimate } from "@/nav/position/types";
import { CameraIndex } from "@/nav/speed/cameras";
import { CameraSource } from "@/services/navigation/camera-source";
import { RoadReader, type LimitGraph } from "@/services/navigation/road-reader";

// A 60 road north 3 km. The source's reader starts its frame at the first position: the drives start at the memory
// graph's origin, so the two frames are the same.
const origin = { lat: 50.45, lon: 30.52 };
const frame = new LocalFrame(origin);
const at = (e: number, n: number) => frame.toCoordinate(e, n);
const graph = new MemoryRoadGraph(frame, [
  { cls: RoadClass.primary, flags: EdgeFlag.attributes | EdgeFlag.urban, maxspeedKph: 60, points: [at(0, 0), at(0, 3000)] },
]);
const road = graph.edgesNear(0, 0, 5)[0].edge.id;

function source(cameras: CameraIndex | null) {
  const notes: string[] = [];
  const open = (): LimitGraph => ({ key: "kyiv:1", graph: Object.assign(graph, { setFrame: () => {} }), close: () => {} });
  const s = new CameraSource({
    reader: new RoadReader({ open, activeKey: () => "kyiv:1" }),
    cameras: () => (cameras ? { key: "maps:1", index: cameras } : null),
    note: (t) => notes.push(t),
  });
  return { s, notes };
}

const position = (n: number, extra: Partial<PositionEstimate> = {}): PositionEstimate => ({
  ...at(0, n),
  headingRad: 0,
  speedMps: 15,
  accuracyM: 5,
  source: "gnss",
  trust: "TRUSTED",
  timestamp: 0,
  ...extra,
});

/** On a pole 4 m off the road, north-bound traffic; its limit is the road's. */
const CAMERAS = new CameraIndex([{ id: 0, ...at(4, 1500), bearingRad: 0, listed: true }]);

describe("CameraSource", () => {
  test("a trusted GNSS drive: the camera 30 s ahead, counting down to it, then passed", () => {
    const { s, notes } = source(CAMERAS);
    const seen: (number | null)[] = [];
    // 15 m/s, a fix a second.
    for (let t = 0; t <= 110; t++) seen.push(s.at(position(15 * t), t * 1000)?.distanceM ?? null);
    // Within 450 m at 1050 m driven (70 s), shown a second later.
    expect(seen[70]).toBeNull();
    expect(seen[71]).toBeCloseTo(435, 0);
    expect(seen[99]).toBeCloseTo(15, 0);
    expect(seen[101]).toBeNull();
    expect(notes).toEqual(["camera ahead #0 in 435 m, limit 60", "camera passed #0"]);
  });

  test("creeping on GNSS too slow for a course keeps the card, and the camera isn't new when the car speeds up", () => {
    const { s, notes } = source(CAMERAS);
    let n = 0;
    let t = 0;
    const step = (mps: number) => s.at(position((n += mps), { speedMps: mps }), (t += 1000));
    s.at(position(0), 0);
    while (n < 1200) step(15);
    // 2 m/s for 40 s: no course, so no road ahead to look along.
    for (let k = 0; k < 40; k++) expect(step(2)?.id).toBe(0);
    while (n < 1450) expect(step(15)?.id).toBe(0);
    expect(notes).toEqual(["camera ahead #0 in 435 m, limit 60"]);
  });

  test("map matching's roads, the way along them, decide", () => {
    const { s } = source(CAMERAS);
    const mm = (n: number, dir: 1 | -1) => ({ key: "kyiv:1", weights: [{ edge: road, dir, alongM: n, weight: 1 }] });
    // Dead-reckoned, the dot a little behind: the particles say where, and which way. (The first position, without
    // roads, sets the reader's frame on the graph's.)
    const dr = (n: number) => position(n, { source: "dr" });
    s.at(dr(0), -1000);
    s.at(dr(1180), 0, mm(1200, 1));
    expect(s.at(dr(1195), 1000, mm(1215, 1))?.distanceM).toBeCloseTo(285, 0);
    // The other way along the road: the camera checks the north-bound traffic only.
    const other = source(CAMERAS).s;
    other.at(dr(0), -1000);
    other.at(dr(1800), 0, mm(1800, -1));
    expect(other.at(dr(1785), 1000, mm(1785, -1))).toBeNull();
  });

  test("no cameras for a dot it can't stand behind, nor without the cameras file", () => {
    const { s } = source(CAMERAS);
    s.at(position(1300, { source: "dr" }), 0);
    expect(s.at(position(1315, { source: "dr" }), 1000)).toBeNull();
    const none = source(null).s;
    none.at(position(1300), 0);
    expect(none.at(position(1315), 1000)).toBeNull();
  });
});
