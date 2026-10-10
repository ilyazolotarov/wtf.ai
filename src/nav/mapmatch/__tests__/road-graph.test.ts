import { readFileSync } from "node:fs";
import path from "node:path";

import { LocalFrame } from "@/nav/geo/local-frame";
import { bufferByteSource } from "@/nav/mapmatch/graph/byte-source";
import { EdgeFlag, NodeFlag, Oneway, RoadClass, idTile } from "@/nav/mapmatch/graph/format";
import { TiledRoadGraph, type RoadEdge } from "@/nav/mapmatch/graph/road-graph";

// net.graph.bin is written by tools/tiles (tests/test_graph.py, `ts_fixture_bytes`): a grid of
// D = 0.0006° around (LAT0, LON0) plus a long road 60 —160— 61 —161— 63 at LAT0 + 0.01 with a
// one-way branch 162 north from 61. See the diagram there.
const FIXTURE = readFileSync(path.join(__dirname, "../__fixtures__/net.graph.bin"));
const LON0 = 30.75;
const LAT0 = 51.52;
const D = 0.0006;
const FAR_LAT = LAT0 + 0.01;

const frame = new LocalFrame({ lat: LAT0, lon: LON0 });
const open = (cacheTiles?: number) => new TiledRoadGraph(bufferByteSource(new Uint8Array(FIXTURE)), frame, { cacheTiles });
const grid = (x: number, y: number) => frame.toEnu({ lon: LON0 + x * D, lat: LAT0 + y * D });
const DX = grid(1, 0)[0]; // metres per D east
const deg = (rad: number) => (rad * 180) / Math.PI;

function byWay(graph: TiledRoadGraph): Map<number, RoadEdge[]> {
  const out = new Map<number, RoadEdge[]>();
  for (const e of graph.edgesInTiles(graph.tilesInBounds(-180, -85, 180, 85))) {
    out.set(e.wayId, [...(out.get(e.wayId) ?? []), e]);
  }
  return out;
}

describe("TiledRoadGraph", () => {
  test("opens by reading only the header and directory", () => {
    const g = open();
    expect(g.info).toMatchObject({ format: 1, zoom: 14, nodes: 25, edges: 20, osmDate: "2026-10-01", builtAt: 1_790_000_000 });
    expect(g.stats.tileLoads).toBe(0);
    expect(g.stats.bytesRead).toBe(64 + 4 * (g.info.nx * g.info.ny + 1));
  });

  test("rejects a file that isn't a graph", () => {
    const bad = new Uint8Array(FIXTURE);
    bad[0] = 0x58;
    expect(() => new TiledRoadGraph(bufferByteSource(bad), frame)).toThrow(/road graph/);
  });

  test("decodes edges: attributes, geometry, lengths", () => {
    const ways = byWay(open());
    expect([...ways.keys()].sort((a, b) => a - b)).toEqual([101, 102, 103, 104, 105, 106, 107, 108, 109, 160, 161, 162, 170, 171, 172, 173, 174, 175]);
    const [e102] = ways.get(102)!;
    expect(e102).toMatchObject({ cls: RoadClass.primary, oneway: Oneway.none, flags: EdgeFlag.bridge | EdgeFlag.attributes });
    expect(e102.lonLat.length).toBe(4); // 2-3-4 is straight: simplified to its ends
    expect(e102.lengthM).toBeCloseTo(2 * DX, 0);
    expect(e102.cum[1]).toBeCloseTo(2 * DX, 0);
    const [x2, y2] = grid(1, 0);
    expect(e102.xy[0]).toBeCloseTo(x2, 1);
    expect(e102.xy[1]).toBeCloseTo(y2, 1);
    expect(ways.get(105)![0].oneway).toBe(Oneway.backward);
    expect(ways.get(106)!.map((e) => e.flags & EdgeFlag.roundabout)).toEqual([EdgeFlag.roundabout, EdgeFlag.roundabout]);
    expect(ways.get(108)![0].flags & EdgeFlag.minorService).toBeTruthy();
  });

  test("nodes list every incident edge and carry flags", () => {
    const g = open();
    const ways = byWay(g);
    const n2 = g.node(ways.get(101)![0].to);
    expect(n2.edges.map((r) => g.edge(r.edge).wayId).sort()).toEqual([101, 102, 103, 104]);
    expect(n2.flags).toBe(0);
    const n4 = g.node(ways.get(102)![0].to);
    expect(n4.flags & NodeFlag.boundary).toBeTruthy();
    expect(g.node(ways.get(101)![0].from).flags & NodeFlag.deadEnd).toBeTruthy();
  });

  test("edgesNear: distance, position along the edge and heading", () => {
    const g = open();
    const [x, y] = grid(1.5, 0);
    const near = g.edgesNear(x, y + 5, 30);
    expect(near[0].edge.wayId).toBe(102);
    expect(near[0].distanceM).toBeCloseTo(5, 1);
    expect(near[0].alongM).toBeCloseTo(0.5 * DX, 0);
    expect(deg(near[0].headingRad)).toBeCloseTo(90, 0);
    expect(near.every((n) => n.distanceM <= 30)).toBe(true);
    expect(near.map((n) => n.distanceM)).toEqual([...near.map((n) => n.distanceM)].sort((a, b) => a - b));
  });

  test("exits: turn angles, U-turn and turn restrictions (no_left_turn 101 → 103)", () => {
    const g = open();
    const ways = byWay(g);
    const exits = g.exits(ways.get(101)![0].id, 1);
    const at = (way: number) => exits.find((x) => g.edge(x.edge).wayId === way)!;
    expect(exits).toHaveLength(4);
    expect(at(101)).toMatchObject({ uTurn: true, dir: -1, restricted: false });
    expect(Math.abs(deg(at(101).turnRad))).toBeCloseTo(180, 0);
    expect(at(102)).toMatchObject({ dir: 1, restricted: false, uTurn: false });
    expect(deg(at(102).turnRad)).toBeCloseTo(0, 0);
    expect(at(103)).toMatchObject({ dir: -1, restricted: true }); // left, north to node 5
    expect(deg(at(103).turnRad)).toBeCloseTo(-90, 0);
    expect(at(104)).toMatchObject({ dir: 1, restricted: false }); // right, south to node 6
    expect(deg(at(104).turnRad)).toBeCloseTo(90, 0);
  });

  test("exits: only_straight_on 103 → 104 restricts every other exit", () => {
    const g = open();
    const ways = byWay(g);
    const exits = g.exits(ways.get(103)![0].id, 1);
    const restricted = Object.fromEntries(exits.map((x) => [g.edge(x.edge).wayId, x.restricted]));
    expect(restricted).toEqual({ 101: true, 102: true, 103: true, 104: false });
  });

  test("exits: one-way against the geometry, and roundabout direction", () => {
    const g = open();
    const ways = byWay(g);
    // At node 4: 105 is oneway=-1 (8 → 4), so leaving 4 along its geometry is against it.
    const at4 = g.exits(ways.get(102)![0].id, 1);
    expect(at4.find((x) => g.edge(x.edge).wayId === 105)).toMatchObject({ dir: 1, againstOneway: true });
    // Entering the roundabout at 11 from 13: only 11 → 10 is the right way round.
    const at11 = g.exits(ways.get(107)![0].id, 1);
    const ring = at11.filter((x) => g.edge(x.edge).wayId === 106);
    expect(ring.map((x) => [x.dir, x.againstOneway]).sort()).toEqual([[-1, true], [1, false]]);
  });

  test("edges cross tiles: references, exits and spatial lists", () => {
    const g = open();
    const ways = byWay(g);
    const [e160] = ways.get(160)!;
    const n61 = g.node(e160.to);
    expect(idTile(n61.id)).not.toBe(idTile(e160.id));
    expect(n61.lon).toBeCloseTo(LON0 + 0.025, 5);
    const exits = g.exits(e160.id, 1);
    const at = (way: number) => exits.find((x) => g.edge(x.edge).wayId === way)!;
    expect(deg(at(161).turnRad)).toBeCloseTo(0, 0);
    expect(deg(at(162).turnRad)).toBeCloseTo(-90, 0);
    expect(at(162).againstOneway).toBe(false);
    // The middle of 160 lies in a tile other than its home tile; the spatial list there finds it.
    const mid = { lon: LON0 + 0.0125, lat: FAR_LAT };
    expect(g.tileAt(mid)).not.toBe(idTile(e160.id));
    const [mx, my] = frame.toEnu(mid);
    expect(g.edgesNear(mx, my, 10)[0].edge.wayId).toBe(160);
  });

  test("LRU cache keeps pinned tiles and evicts the rest", () => {
    const g = open(1);
    const ways = byWay(g); // touches every tile
    expect(g.stats.cachedTiles).toBe(1);
    const home = idTile(ways.get(160)![0].id);
    g.pin([home]);
    const loads = g.stats.tileLoads;
    g.edge(ways.get(160)![0].id);
    g.edgesInTiles(g.tilesInBounds(-180, -85, 180, 85));
    const before = g.stats.tileLoads;
    g.edge(ways.get(160)![0].id); // pinned: no reload
    expect(g.stats.tileLoads).toBe(before);
    expect(before).toBeGreaterThan(loads);
  });

  test("setFrame re-projects decoded geometry", () => {
    const g = open();
    const id = byWay(g).get(102)![0].id;
    const x0 = g.edge(id).xy[0];
    g.setFrame(new LocalFrame({ lat: LAT0, lon: LON0 + D }));
    expect(g.edge(id).xy[0]).toBeCloseTo(x0 - DX, 1);
  });
});
