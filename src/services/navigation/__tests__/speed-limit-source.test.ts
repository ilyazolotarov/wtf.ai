import { LocalFrame } from "@/nav/geo/local-frame";
import { EdgeFlag, RoadClass } from "@/nav/mapmatch/graph/format";
import { MemoryRoadGraph } from "@/nav/mapmatch/graph/memory-graph";
import type { PositionEstimate } from "@/nav/position/types";
import { RoadReader, type LimitGraph } from "@/services/navigation/road-reader";
import { SpeedLimitSource } from "@/services/navigation/speed-limit-source";

// A 60 road north–south, a 30 street west–east 200 m north. The source's reader starts its frame at the first position:
// the tests start at the memory graph's origin, so the two frames are the same.
const origin = { lat: 50.45, lon: 30.52 };
const frame = new LocalFrame(origin);
const at = (e: number, n: number) => frame.toCoordinate(e, n);
const A = EdgeFlag.attributes | EdgeFlag.urban;
const graph = new MemoryRoadGraph(frame, [
  { cls: RoadClass.primary, flags: A, maxspeedKph: 60, points: [at(0, -500), at(0, 200), at(0, 500)] },
  { cls: RoadClass.residential, flags: A, maxspeedKph: 30, points: [at(-500, 200), at(0, 200), at(500, 200)] },
]);
const road60 = graph.edgesNear(0, 0, 5)[0].edge.id;
const street30 = graph.edgesNear(-200, 200, 5)[0].edge.id;

function source(key: () => string | null = () => "kyiv:1") {
  const notes: string[] = [];
  let opened = 0;
  const open = (): LimitGraph => {
    opened++;
    return { key: key()!, graph: Object.assign(graph, { setFrame: () => {} }), close: () => {} };
  };
  const s = new SpeedLimitSource({ reader: new RoadReader({ open, activeKey: key }), note: (t) => notes.push(t) });
  return { s, notes, opened: () => opened };
}

const position = (e: number, n: number, extra: Partial<PositionEstimate> = {}): PositionEstimate => ({
  ...at(e, n),
  headingRad: 0,
  speedMps: 15,
  accuracyM: 5,
  source: "gnss",
  trust: "TRUSTED",
  timestamp: 0,
  ...extra,
});

describe("SpeedLimitSource", () => {
  test("a trusted GNSS fix: the road under it, after the sign's moment", () => {
    const { s, notes } = source();
    expect(s.at(position(0, 0), 0)).toBeNull();
    expect(s.at(position(1, 20), 1000)?.kph).toBe(60);
    expect(notes).toEqual(["speed limit none", "speed limit 60 (OSM)"]);
  });

  test("map matching's roads decide, wherever the dot is drawn", () => {
    const { s } = source();
    const roads = (w60: number, w30: number) => ({ key: "kyiv:1", weights: [{ edge: road60, weight: w60 }, { edge: street30, weight: w30 }] });
    const dr = (n: number) => position(0, n, { source: "dr" });
    s.at(dr(0), 0, roads(0.9, 0.1));
    expect(s.at(dr(10), 1000, roads(0.9, 0.1))?.kph).toBe(60);
    // Torn between the two: the sign goes once that holds.
    s.at(dr(20), 2000, roads(0.5, 0.5));
    expect(s.at(dr(30), 4000, roads(0.5, 0.5))).toBeNull();
    // Another graph file's road ids mean nothing here.
    expect(s.at(dr(40), 6000, { key: "kyiv:0", weights: [{ edge: road60, weight: 1 }] })).toBeNull();
  });

  test("no sign for a dot it can't stand behind: dead reckoning without map matching, a refused fix", () => {
    const { s } = source();
    s.at(position(0, 0, { source: "dr" }), 0);
    expect(s.at(position(0, 10, { source: "dr" }), 1500)).toBeNull();
    s.at(position(0, 0, { trust: "UNTRUSTED" }), 2000);
    expect(s.at(position(0, 10, { trust: "UNTRUSTED" }), 3500)).toBeNull();
  });

  test("another map installed: the reader opens again; none: no limit", () => {
    let key: string | null = "kyiv:1";
    const { s, opened } = source(() => key);
    s.at(position(0, 0), 0);
    key = "kyiv:2";
    s.at(position(0, 10), 1000);
    expect(opened()).toBe(2);
    key = null;
    s.at(position(0, 20), 2000);
    expect(s.at(position(0, 30), 5000)).toBeNull();
  });

  // A main road tagged 110 into a town, whose untagged street goes on from the sign (a node where the road only goes
  // on); 1 km on, a junction with a 70 road straight on and a 50 street to the right. Driven north at 110 km/h, a fix
  // a second.
  describe("the limit where the car will be once it has held", () => {
    const T = EdgeFlag.attributes;
    const roads = new MemoryRoadGraph(frame, [
      { cls: RoadClass.primary, flags: T, maxspeedKph: 110, points: [at(0, -3000), at(0, 0)] },
      { cls: RoadClass.primary, flags: A, points: [at(0, 0), at(0, 1000)] },
      { cls: RoadClass.primary, flags: A, maxspeedKph: 70, points: [at(0, 1000), at(0, 2000)] },
      { cls: RoadClass.residential, flags: A, points: [at(0, 1000), at(800, 1000)] },
    ]);
    const mph110 = 110 / 3.6;
    const onRoads = () => {
      const open = (): LimitGraph => ({ key: "kyiv:1", graph: Object.assign(roads, { setFrame: () => {} }), close: () => {} });
      const s = new SpeedLimitSource({ reader: new RoadReader({ open, activeKey: () => "kyiv:1" }), note: () => {} });
      // The reader's frame where the graph's is (the first position's).
      s.at(position(0, 0, { speedMps: 0 }), -60_000);
      s.reset();
      return s;
    };
    /** Where (n, m) the shown limit first is `kph`, driving north from `fromN` at `mps`. */
    const changesAt = (s: SpeedLimitSource, fromN: number, kph: number, mps = mph110) => {
      for (let t = 0; t < 120; t++) {
        const n = fromN + t * mps;
        if (s.at(position(0, n, { speedMps: mps }), t * 1000)?.kph === kph) return n;
      }
      return null;
    };

    test("a town's limit shows at its sign, not 60 m past it", () => {
      const s = onRoads();
      const n = changesAt(s, -600, 50)!;
      expect(n).toBeGreaterThan(-35);
      expect(n).toBeLessThan(35);
    });

    test("leaving the town, the next road's limit shows where it starts", () => {
      // Driven south from the junction: the 110 begins at the sign.
      const s = onRoads();
      let shownAt: number | null = null;
      for (let t = 0; t < 60 && shownAt === null; t++) {
        const n = 900 - t * 20;
        if (s.at(position(0, n, { speedMps: 20, headingRad: Math.PI }), t * 1000)?.kph === 110) shownAt = n;
      }
      expect(shownAt).not.toBeNull();
      expect(shownAt!).toBeLessThan(30);
      expect(shownAt!).toBeGreaterThan(-30);
    });

    test("not past a junction, where the car may turn: the road's own limit until it is on the next", () => {
      const s = onRoads();
      expect(changesAt(s, 200, 50)).toBeLessThan(250);
      const n = changesAt(s, 200, 70)!;
      expect(n).toBeGreaterThan(1000);
    });
  });
});
