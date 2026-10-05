import { readFileSync } from "node:fs";
import path from "node:path";

import { LocalFrame } from "@/nav/geo/local-frame";
import { bufferByteSource } from "@/nav/mapmatch/graph/byte-source";
import { TiledRoadGraph } from "@/nav/mapmatch/graph/road-graph";
import { crossedRoad } from "@/nav/mapmatch/road-crossing";

// The fixture (tools/tiles tests/test_graph.py): the long primary road 160 runs due east from node 60 (the origin
// here) to node 61, 1.73 km on, where 162 leaves it; the primary bridge 102 runs east 1.11 km south of it.
const FIXTURE = readFileSync(path.join(__dirname, "../__fixtures__/net.graph.bin"));
const ORIGIN = { lat: 51.53, lon: 30.75 };
const graph = () => new TiledRoadGraph(bufferByteSource(new Uint8Array(FIXTURE)), new LocalFrame(ORIGIN));
const way = (hit: ReturnType<typeof crossedRoad>) => hit && hit.edge.wayId;

describe("crossedRoad", () => {
  test("straight over the road far from a junction: crossed", () => {
    const g = graph();
    expect(way(crossedRoad(g, 800, -10, 800, 10))).toBe(160);
    // At a shallow angle too.
    expect(way(crossedRoad(g, 790, -6, 830, 6))).toBe(160);
  });

  test("at a junction, along the road, or onto it: not crossed", () => {
    const g = graph();
    const junction = new LocalFrame(ORIGIN).toEnu({ lat: 51.53, lon: 30.775 })[0];
    expect(crossedRoad(g, junction + 10, -10, junction + 10, 10)).toBeNull();
    // Lane offset or noise either side of the centre line.
    expect(crossedRoad(g, 800, -2, 810, 2)).toBeNull();
    // Ends on the road (turning onto it), or starts there (leaving it).
    expect(crossedRoad(g, 800, -10, 800, 2)).toBeNull();
    expect(crossedRoad(g, 800, -2, 800, 10)).toBeNull();
  });

  test("under or over a bridge: not crossed", () => {
    const g = graph();
    const [e, n] = new LocalFrame(ORIGIN).toEnu({ lat: 51.52, lon: 30.7512 });
    expect(crossedRoad(g, e, n - 10, e, n + 10)).toBeNull();
  });
});
