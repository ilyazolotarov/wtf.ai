// A synthetic road graph file (format 1, src/nav/mapmatch/graph/format.ts), in memory: a lat/lon grid of two-way
// roads with a hierarchy (trunk every 60 km, primary every 30, secondary every 10, tertiary every 3, residential
// between, with some service lanes, one-ways and gaps). Its size is configurable, so route benchmarks run on a
// country-sized graph without one on disk (`npm run route:bench`).

import {
  COORD_SCALE, EDGE_BYTES, GRAPH_FORMAT, GRAPH_MAGIC, HEADER_BYTES, NODE_BYTES, Oneway, REF_BYTES, RoadClass,
  TILE_HEADER_BYTES, VERTEX_BYTES, graphId,
} from "../../src/nav/mapmatch/graph/format";
import { tileXY } from "../../src/nav/mapmatch/graph/road-graph";

export interface SyntheticOptions {
  /** Centre of the grid. */
  centre?: { lat: number; lon: number };
  widthKm?: number;
  heightKm?: number;
  /** Distance between grid lines, m. */
  spacingM?: number;
  zoom?: number;
  seed?: number;
}

export interface SyntheticGraph {
  bytes: Uint8Array;
  nodes: number;
  edges: number;
  /** Grid node positions, for picking route ends: node (col, row) is `at(col, row)`. */
  cols: number;
  rows: number;
  at(col: number, row: number): { lat: number; lon: number };
}

const M_PER_DEG = 111_320;

function hash(a: number, b: number, seed: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + seed, 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

interface GEdge {
  from: number;
  to: number;
  cls: number;
  oneway: number;
  flags: number;
  lengthM: number;
  vertices: number[];
  wayId: number;
}

export function buildSyntheticGraph(options: SyntheticOptions = {}): SyntheticGraph {
  const centre = options.centre ?? { lat: 49.0, lon: 31.5 };
  const spacingM = options.spacingM ?? 500;
  const cols = Math.max(2, Math.round(((options.widthKm ?? 250) * 1000) / spacingM));
  const rows = Math.max(2, Math.round(((options.heightKm ?? 150) * 1000) / spacingM));
  const zoom = options.zoom ?? 12;
  const seed = options.seed ?? 1;
  const dLat = spacingM / M_PER_DEG;
  const dLon = spacingM / (M_PER_DEG * Math.cos((centre.lat * Math.PI) / 180));
  const lat0 = centre.lat - (rows * dLat) / 2;
  const lon0 = centre.lon - (cols * dLon) / 2;
  const lonAt = (c: number) => lon0 + c * dLon;
  const latAt = (r: number) => lat0 + r * dLat;
  const e6 = (deg: number) => Math.round(deg / COORD_SCALE);

  // Tiles: nodes by tile, local indices in creation order.
  const tileOf = new Int32Array(cols * rows);
  const localOf = new Uint32Array(cols * rows);
  const tileKeys = new Map<number, number>(); // zoom-xy key → compact tile slot
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const xyOf: [number, number][] = new Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const [fx, fy] = tileXY(lonAt(c), latAt(r), zoom);
      const x = Math.floor(fx), y = Math.floor(fy);
      xyOf[r * cols + c] = [x, y];
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  const nx = maxX - minX + 1;
  const ny = maxY - minY + 1;
  const tileNodes: number[][] = Array.from({ length: nx * ny }, () => []);
  for (let i = 0; i < cols * rows; i++) {
    const [x, y] = xyOf[i];
    const t = (y - minY) * nx + (x - minX);
    tileOf[i] = t;
    localOf[i] = tileNodes[t].length;
    tileNodes[t].push(i);
  }
  void tileKeys;

  // Edges: east and north of each node, owned by the tile of their `from` node.
  const edges: GEdge[] = [];
  // Spacing of each class's lines, like Ukraine's: M roads (trunk) far apart, H (primary), P (secondary), T (tertiary).
  const every = (km: number) => Math.max(1, Math.round((km * 1000) / spacingM));
  const classOf = (line: number, along: number): number => {
    const l = line % 100_000;
    if (l % every(60) === 0) return RoadClass.trunk;
    if (l % every(30) === 0) return RoadClass.primary;
    if (l % every(10) === 0) return RoadClass.secondary;
    if (l % every(3) === 0) return RoadClass.tertiary;
    const h = hash(line, along, seed);
    return h < 0.08 ? RoadClass.service : h < 0.2 ? RoadClass.unclassified : RoadClass.residential;
  };
  const addEdge = (a: number, b: number, line: number, along: number, horizontal: boolean) => {
    const cls = classOf(line, along);
    const h = hash(a, b, seed + 7);
    // A few gaps in the minor roads (never in the hierarchy).
    if (cls >= RoadClass.unclassified && h < 0.04) return;
    const c0 = a % cols, r0 = Math.floor(a / cols), c1 = b % cols, r1 = Math.floor(b / cols);
    const lon1 = lonAt(c0), lat1 = latAt(r0), lon2 = lonAt(c1), lat2 = latAt(r1);
    // One bent vertex in the middle: edges aren't straight lines.
    const bend = (hash(b, a, seed + 3) - 0.5) * 0.2;
    const mid = [(lon1 + lon2) / 2 + (horizontal ? 0 : bend * dLon), (lat1 + lat2) / 2 + (horizontal ? bend * dLat : 0)];
    const vertices = [e6(lon1), e6(lat1), e6(mid[0]), e6(mid[1]), e6(lon2), e6(lat2)];
    const lengthM = spacingM * (1 + Math.abs(bend) * 0.3);
    const oneway = cls >= RoadClass.residential && h > 0.96 ? Oneway.forward : Oneway.none;
    edges.push({ from: a, to: b, cls, oneway, flags: 0, lengthM, vertices, wayId: (line % 100_000) * 4096 + (line >= 100_000 ? 2048 : 0) + (along % 2048) });
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (c + 1 < cols) addEdge(i, i + 1, r, c, true);
      if (r + 1 < rows) addEdge(i, i + cols, c + 100_000, r, false);
    }
  }

  // Per tile: owned edges (local index), node refs, spatial index (edges crossing the tile).
  const tileEdges: GEdge[][] = Array.from({ length: nx * ny }, () => []);
  const edgeLocal: number[] = [];
  for (const [k, e] of edges.entries()) {
    const t = tileOf[e.from];
    edgeLocal[k] = tileEdges[t].length;
    tileEdges[t].push(e);
  }
  const nodeRefs: { tile: number; local: number; end: 0 | 1 }[][] = Array.from({ length: cols * rows }, () => []);
  const spatial: { tile: number; local: number }[][] = Array.from({ length: nx * ny }, () => []);
  for (const [k, e] of edges.entries()) {
    const ref = { tile: tileOf[e.from], local: edgeLocal[k] };
    nodeRefs[e.from].push({ ...ref, end: 0 });
    nodeRefs[e.to].push({ ...ref, end: 1 });
    spatial[tileOf[e.from]].push(ref);
    if (tileOf[e.to] !== tileOf[e.from]) spatial[tileOf[e.to]].push(ref);
  }

  // Serialise.
  const blobs: Uint8Array[] = [];
  for (let t = 0; t < nx * ny; t++) {
    const nodeList = tileNodes[t];
    if (!nodeList.length) { blobs.push(new Uint8Array(0)); continue; }
    const owned = tileEdges[t];
    const refs = nodeList.flatMap((n) => nodeRefs[n]);
    const nVerts = owned.reduce((s, e) => s + e.vertices.length / 2, 0);
    const sp = spatial[t];
    const size = TILE_HEADER_BYTES + nodeList.length * NODE_BYTES + refs.length * REF_BYTES + owned.length * EDGE_BYTES + nVerts * VERTEX_BYTES + sp.length * 8;
    const buf = new ArrayBuffer(size);
    const v = new DataView(buf);
    [nodeList.length, refs.length, owned.length, nVerts, 0, sp.length].forEach((n, i) => v.setUint32(4 * i, n, true));
    let at = TILE_HEADER_BYTES;
    let refIndex = 0;
    for (const n of nodeList) {
      const c = n % cols, r = Math.floor(n / cols);
      v.setInt32(at, e6(lonAt(c)), true);
      v.setInt32(at + 4, e6(latAt(r)), true);
      v.setUint32(at + 8, refIndex, true);
      v.setUint16(at + 12, nodeRefs[n].length, true);
      v.setUint16(at + 14, 0, true);
      refIndex += nodeRefs[n].length;
      at += NODE_BYTES;
    }
    for (const n of nodeList) {
      for (const ref of nodeRefs[n]) {
        v.setUint32(at, ref.tile, true);
        v.setUint16(at + 4, ref.local, true);
        v.setUint16(at + 6, ref.end, true);
        at += REF_BYTES;
      }
    }
    let vertex = 0;
    for (const e of owned) {
      v.setUint16(at, localOf[e.from], true);
      v.setUint8(at + 2, e.cls);
      v.setUint8(at + 3, e.oneway);
      v.setUint16(at + 4, e.flags, true);
      v.setUint16(at + 6, e.vertices.length / 2, true);
      v.setUint32(at + 8, tileOf[e.to], true);
      v.setUint16(at + 12, localOf[e.to], true);
      v.setFloat32(at + 16, e.lengthM, true);
      v.setUint32(at + 20, vertex, true);
      v.setUint32(at + 24, e.wayId, true);
      vertex += e.vertices.length / 2;
      at += EDGE_BYTES;
    }
    for (const e of owned) for (const x of e.vertices) { v.setInt32(at, x, true); at += 4; }
    for (const s of sp) {
      v.setUint32(at, s.tile, true);
      v.setUint16(at + 4, s.local, true);
      at += 8;
    }
    blobs.push(new Uint8Array(buf));
  }

  const dirOffset = HEADER_BYTES;
  const dataOffset = dirOffset + 4 * (nx * ny + 1);
  const total = dataOffset + blobs.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(total);
  const hv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = GRAPH_MAGIC.charCodeAt(i);
  hv.setUint16(4, GRAPH_FORMAT, true);
  hv.setUint16(6, zoom, true);
  hv.setUint32(8, minX, true);
  hv.setUint32(12, minY, true);
  hv.setUint32(16, nx, true);
  hv.setUint32(20, ny, true);
  hv.setUint32(24, cols * rows, true);
  hv.setUint32(28, edges.length, true);
  hv.setUint32(32, dirOffset, true);
  hv.setUint32(36, dataOffset, true);
  out.set(new TextEncoder().encode("synthetic"), 40);
  let offset = 0;
  for (const [t, b] of blobs.entries()) {
    hv.setUint32(dirOffset + 4 * t, offset, true);
    out.set(b, dataOffset + offset);
    offset += b.length;
  }
  hv.setUint32(dirOffset + 4 * blobs.length, offset, true);

  void graphId;
  return { bytes: out, nodes: cols * rows, edges: edges.length, cols, rows, at: (c, r) => ({ lat: latAt(r), lon: lonAt(c) }) };
}
