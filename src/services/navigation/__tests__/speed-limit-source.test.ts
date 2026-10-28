import { LocalFrame } from "@/nav/geo/local-frame";
import { EdgeFlag, RoadClass } from "@/nav/mapmatch/graph/format";
import { MemoryRoadGraph } from "@/nav/mapmatch/graph/memory-graph";
import type { PositionEstimate } from "@/nav/position/types";
import { SpeedLimitSource, type LimitGraph } from "@/services/navigation/speed-limit-source";

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
  const s = new SpeedLimitSource({ open, activeKey: key, note: (t) => notes.push(t) });
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
});
