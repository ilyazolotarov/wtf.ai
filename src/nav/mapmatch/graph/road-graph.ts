// Road graph reader (MAPMATCH-SPEC §5): the particle filter's only view of the road network.
// Reads a tiled `<region>.graph.bin` by random access and decodes only the tiles it is asked
// about, so the Ukraine file costs about what an oblast's does. Pure TS: the same code runs in
// the app (FileHandle source) and in Node (fs source, replay).

import type { Coordinate } from "../../geo";
import type { LocalFrame } from "../../geo/local-frame";
import type { ByteSource } from "./byte-source";
import {
  COORD_SCALE, EDGE_BYTES, GRAPH_FORMAT, GRAPH_MAGIC, HEADER_BYTES, NODE_BYTES, Oneway, REF_BYTES,
  RESTRICTION_BYTES, RestrictionKind, TILE_HEADER_BYTES, VERTEX_BYTES, graphId, idIndex, idTile,
} from "./format";

export type EdgeId = number;
export type NodeId = number;

export interface RoadEdge {
  readonly id: EdgeId;
  readonly wayId: number;
  readonly from: NodeId;
  readonly to: NodeId;
  /** Length of the unsimplified OSM geometry, m. Travel along the edge uses `cum`. */
  readonly lengthM: number;
  readonly cls: number;
  /** `Oneway`, relative to the geometry direction (the OSM way's). */
  readonly oneway: number;
  readonly flags: number;
  /** Vertices in degrees: [lon0, lat0, lon1, lat1, …], from `from` to `to`. */
  readonly lonLat: Float64Array;
  /** The same vertices in the graph's local frame: [e0, n0, e1, n1, …] (m). */
  readonly xy: Float64Array;
  /** Distance along the geometry at each vertex (m); the last is the geometry's length. */
  readonly cum: Float64Array;
  /** Memoised `startHeading` / `endHeading` (routing asks for them at every junction it passes). */
  startHeadingRad?: number;
  endHeadingRad?: number;
}

export interface RoadNode {
  readonly id: NodeId;
  readonly lat: number;
  readonly lon: number;
  readonly e: number;
  readonly n: number;
  readonly flags: number;
  /** Every edge touching the node; end 0: the edge starts here, 1: it ends here. */
  readonly edges: readonly { edge: EdgeId; end: 0 | 1 }[];
}

export interface NearEdge {
  edge: RoadEdge;
  distanceM: number;
  /** Distance along the geometry to the closest point, m. */
  alongM: number;
  e: number;
  n: number;
  /** Geometry direction at the closest point, clockwise from north. */
  headingRad: number;
}

/** A way to leave a node after arriving along an edge. */
export interface Exit {
  edge: EdgeId;
  /** +1: along the edge's geometry, −1: against it. */
  dir: 1 | -1;
  /** Heading change from arrival to departure, clockwise (right turn) positive, in (−π, π]. */
  turnRad: number;
  againstOneway: boolean;
  /** Forbidden by a turn restriction: `no_*` for this pair, or another exit is `only_*`. */
  restricted: boolean;
  /** Back along the arrival edge. */
  uTurn: boolean;
}

export interface RoadGraph {
  edgesNear(e: number, n: number, radiusM: number): NearEdge[];
  edge(id: EdgeId): RoadEdge;
  node(id: NodeId): RoadNode;
  /** Exits at the node reached by travelling along `via` in direction `dir`. */
  exits(via: EdgeId, dir: 1 | -1): Exit[];
  /** Non-empty tiles around (e, n). */
  tilesAround(e: number, n: number, radiusM: number): number[];
  /** Tiles to keep decoded (the working set); replaces the previous set. */
  pin(tiles: Iterable<number>): void;
}

export interface GraphInfo {
  format: number;
  zoom: number;
  x0: number;
  y0: number;
  nx: number;
  ny: number;
  nodes: number;
  edges: number;
  /** OSM extract date, YYYY-MM-DD. */
  osmDate: string;
  /** Build time, unix seconds. */
  builtAt: number;
  sizeBytes: number;
}

export interface GraphStats {
  tileLoads: number;
  bytesRead: number;
  cachedTiles: number;
}

if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) throw new Error("road graph reader needs a little-endian platform");

const TWO_PI = 2 * Math.PI;
const wrap = (a: number) => {
  const w = a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI);
  return w === -Math.PI ? Math.PI : w;
};

interface Restriction {
  kind: number;
  from: EdgeId;
  to: EdgeId;
}

/** One decoded tile: typed views over its blob (records are 4-byte aligned). */
class Tile {
  readonly nodeCount: number;
  readonly edgeCount: number;
  private readonly nI32: Int32Array;
  private readonly nU32: Uint32Array;
  private readonly nU16: Uint16Array;
  private readonly iU32: Uint32Array;
  private readonly iU16: Uint16Array;
  private readonly eU8: Uint8Array;
  private readonly eU16: Uint16Array;
  private readonly eU32: Uint32Array;
  private readonly eF32: Float32Array;
  private readonly vI32: Int32Array;
  private readonly rU8: Uint8Array;
  private readonly rU16: Uint16Array;
  private readonly rU32: Uint32Array;
  private readonly rCount: number;
  private readonly sU32: Uint32Array;
  private readonly sU16: Uint16Array;
  readonly spatialCount: number;
  edgeCache: (RoadEdge | undefined)[] = [];
  nodeCache: (RoadNode | undefined)[] = [];
  private restrictions: Map<number, Restriction[]> | null = null;

  constructor(
    readonly index: number,
    buffer: ArrayBufferLike,
  ) {
    const counts = new Uint32Array(buffer, 0, 6);
    const [nN, nI, nE, nV, nR, nS] = counts;
    let at = TILE_HEADER_BYTES;
    this.nI32 = new Int32Array(buffer, at, nN * 4);
    this.nU32 = new Uint32Array(buffer, at, nN * 4);
    this.nU16 = new Uint16Array(buffer, at, nN * 8);
    at += nN * NODE_BYTES;
    this.iU32 = new Uint32Array(buffer, at, nI * 2);
    this.iU16 = new Uint16Array(buffer, at, nI * 4);
    at += nI * REF_BYTES;
    this.eU8 = new Uint8Array(buffer, at, nE * 28);
    this.eU16 = new Uint16Array(buffer, at, nE * 14);
    this.eU32 = new Uint32Array(buffer, at, nE * 7);
    this.eF32 = new Float32Array(buffer, at, nE * 7);
    at += nE * EDGE_BYTES;
    this.vI32 = new Int32Array(buffer, at, nV * 2);
    at += nV * VERTEX_BYTES;
    this.rU8 = new Uint8Array(buffer, at, nR * 20);
    this.rU16 = new Uint16Array(buffer, at, nR * 10);
    this.rU32 = new Uint32Array(buffer, at, nR * 5);
    at += nR * RESTRICTION_BYTES;
    this.sU32 = new Uint32Array(buffer, at, nS * 2);
    this.sU16 = new Uint16Array(buffer, at, nS * 4);
    this.nodeCount = nN;
    this.edgeCount = nE;
    this.rCount = nR;
    this.spatialCount = nS;
  }

  nodeLon(k: number) {
    return this.nI32[4 * k] * COORD_SCALE;
  }
  nodeLat(k: number) {
    return this.nI32[4 * k + 1] * COORD_SCALE;
  }
  nodeFlags(k: number) {
    return this.nU16[8 * k + 7];
  }
  nodeEdges(k: number): { edge: EdgeId; end: 0 | 1 }[] {
    const first = this.nU32[4 * k + 2];
    const count = this.nU16[8 * k + 6];
    const out: { edge: EdgeId; end: 0 | 1 }[] = [];
    for (let j = first; j < first + count; j++) {
      out.push({ edge: graphId(this.iU32[2 * j], this.iU16[4 * j + 2]), end: this.iU16[4 * j + 3] ? 1 : 0 });
    }
    return out;
  }

  edgeRecord(k: number) {
    const geom = this.eU32[7 * k + 5];
    const nvert = this.eU16[14 * k + 3];
    const lonLat = new Float64Array(2 * nvert);
    for (let j = 0; j < 2 * nvert; j++) lonLat[j] = this.vI32[2 * geom + j] * COORD_SCALE;
    return {
      from: graphId(this.index, this.eU16[14 * k]),
      cls: this.eU8[28 * k + 2],
      oneway: this.eU8[28 * k + 3],
      flags: this.eU16[14 * k + 2],
      to: graphId(this.eU32[7 * k + 2], this.eU16[14 * k + 6]),
      lengthM: this.eF32[7 * k + 4],
      wayId: this.eU32[7 * k + 6],
      lonLat,
    };
  }

  spatial(j: number): EdgeId {
    return graphId(this.sU32[2 * j], this.sU16[4 * j + 2]);
  }

  restrictionsAt(nodeLocal: number): Restriction[] {
    if (!this.restrictions) {
      this.restrictions = new Map();
      for (let j = 0; j < this.rCount; j++) {
        const via = this.rU16[10 * j];
        const r = {
          kind: this.rU8[20 * j + 2],
          from: graphId(this.rU32[5 * j + 1], this.rU16[10 * j + 4]),
          to: graphId(this.rU32[5 * j + 3], this.rU16[10 * j + 8]),
        };
        const list = this.restrictions.get(via);
        if (list) list.push(r);
        else this.restrictions.set(via, [r]);
      }
    }
    return this.restrictions.get(nodeLocal) ?? [];
  }
}

export interface TiledRoadGraphOptions {
  /** Decoded tiles kept (LRU); pinned tiles are never evicted. */
  cacheTiles?: number;
}

export class TiledRoadGraph implements RoadGraph {
  readonly info: GraphInfo;
  private readonly directory: Uint32Array;
  private readonly dataOffset: number;
  private readonly cache = new Map<number, Tile>();
  private readonly cacheTiles: number;
  private pinned = new Set<number>();
  private frame: LocalFrame;
  readonly stats: GraphStats = { tileLoads: 0, bytesRead: 0, cachedTiles: 0 };

  constructor(
    private readonly source: ByteSource,
    frame: LocalFrame,
    options: TiledRoadGraphOptions = {},
  ) {
    const header = aligned(source.read(0, HEADER_BYTES));
    const view = new DataView(header);
    const magic = String.fromCharCode(...new Uint8Array(header, 0, 4));
    const format = view.getUint16(4, true);
    if (magic !== GRAPH_MAGIC || format !== GRAPH_FORMAT) {
      throw new Error(`not a format-${GRAPH_FORMAT} road graph (magic ${JSON.stringify(magic)}, format ${format})`);
    }
    const nx = view.getUint32(16, true);
    const ny = view.getUint32(20, true);
    const dirOffset = view.getUint32(32, true);
    this.dataOffset = view.getUint32(36, true);
    const date = new Uint8Array(header, 40, 16);
    this.info = {
      format,
      zoom: view.getUint16(6, true),
      x0: view.getUint32(8, true),
      y0: view.getUint32(12, true),
      nx,
      ny,
      nodes: view.getUint32(24, true),
      edges: view.getUint32(28, true),
      osmDate: String.fromCharCode(...date.subarray(0, date.indexOf(0) < 0 ? 16 : date.indexOf(0))),
      builtAt: view.getUint32(56, true),
      sizeBytes: source.size,
    };
    this.directory = new Uint32Array(aligned(source.read(dirOffset, 4 * (nx * ny + 1))));
    this.stats.bytesRead = HEADER_BYTES + this.directory.byteLength;
    this.cacheTiles = options.cacheTiles ?? 128;
    this.frame = frame;
  }

  /** The navigator's local frame; on re-anchoring, decoded geometry is projected again. */
  setFrame(frame: LocalFrame): void {
    this.frame = frame;
    for (const tile of this.cache.values()) {
      tile.edgeCache = [];
      tile.nodeCache = [];
    }
  }

  /** Tiles that must stay decoded (the particle filter's working set, §5). Replaces the previous set. */
  pin(tiles: Iterable<number>): void {
    this.pinned = new Set(tiles);
  }

  /** Non-empty tiles overlapping the square of half-side `radiusM` around (e, n). */
  tilesAround(e: number, n: number, radiusM: number): number[] {
    const sw = this.frame.toCoordinate(e - radiusM, n - radiusM);
    const ne = this.frame.toCoordinate(e + radiusM, n + radiusM);
    return this.tilesInBounds(sw.lon, sw.lat, ne.lon, ne.lat);
  }

  /** Non-empty tiles overlapping a lon/lat box. */
  tilesInBounds(minLon: number, minLat: number, maxLon: number, maxLat: number): number[] {
    const { x0, y0, nx, ny, zoom } = this.info;
    const [ax, ay] = tileXY(minLon, maxLat, zoom);
    const [bx, by] = tileXY(maxLon, minLat, zoom);
    const out: number[] = [];
    for (let y = Math.max(Math.floor(ay), y0); y <= Math.min(Math.floor(by), y0 + ny - 1); y++) {
      for (let x = Math.max(Math.floor(ax), x0); x <= Math.min(Math.floor(bx), x0 + nx - 1); x++) {
        const t = (y - y0) * nx + (x - x0);
        if (this.directory[t + 1] > this.directory[t]) out.push(t);
      }
    }
    return out;
  }

  /** Tile index containing a coordinate, or −1 outside the graph's range. */
  tileAt(c: Coordinate): number {
    const { x0, y0, nx, ny, zoom } = this.info;
    const [fx, fy] = tileXY(c.lon, c.lat, zoom);
    const x = Math.floor(fx) - x0;
    const y = Math.floor(fy) - y0;
    return x < 0 || y < 0 || x >= nx || y >= ny ? -1 : y * nx + x;
  }

  /** Every edge whose geometry crosses any of the tiles (each once). */
  edgesInTiles(tiles: Iterable<number>): RoadEdge[] {
    const seen = new Set<EdgeId>();
    const out: RoadEdge[] = [];
    for (const t of tiles) {
      const tile = this.tile(t);
      if (!tile) continue;
      for (let j = 0; j < tile.spatialCount; j++) {
        const id = tile.spatial(j);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(this.edge(id));
      }
    }
    return out;
  }

  edgesNear(e: number, n: number, radiusM: number): NearEdge[] {
    const out: NearEdge[] = [];
    for (const edge of this.edgesInTiles(this.tilesAround(e, n, radiusM))) {
      const near = closestPoint(edge, e, n);
      if (near.distanceM <= radiusM) out.push(near);
    }
    return out.sort((a, b) => a.distanceM - b.distanceM);
  }

  edge(id: EdgeId): RoadEdge {
    const tile = this.tileOrThrow(idTile(id));
    const k = idIndex(id);
    const cached = tile.edgeCache[k];
    if (cached) return cached;
    if (k >= tile.edgeCount) throw new RangeError(`no edge ${id}`);
    const r = tile.edgeRecord(k);
    const nv = r.lonLat.length / 2;
    const xy = new Float64Array(2 * nv);
    const cum = new Float64Array(nv);
    for (let j = 0; j < nv; j++) {
      const [x, y] = this.frame.toEnu({ lon: r.lonLat[2 * j], lat: r.lonLat[2 * j + 1] });
      xy[2 * j] = x;
      xy[2 * j + 1] = y;
      if (j > 0) cum[j] = cum[j - 1] + Math.hypot(x - xy[2 * j - 2], y - xy[2 * j - 1]);
    }
    const edge: RoadEdge = { id, ...r, xy, cum };
    tile.edgeCache[k] = edge;
    return edge;
  }

  node(id: NodeId): RoadNode {
    const tile = this.tileOrThrow(idTile(id));
    const k = idIndex(id);
    const cached = tile.nodeCache[k];
    if (cached) return cached;
    if (k >= tile.nodeCount) throw new RangeError(`no node ${id}`);
    const lat = tile.nodeLat(k);
    const lon = tile.nodeLon(k);
    const [e, n] = this.frame.toEnu({ lat, lon });
    const node: RoadNode = { id, lat, lon, e, n, flags: tile.nodeFlags(k), edges: tile.nodeEdges(k) };
    tile.nodeCache[k] = node;
    return node;
  }

  exits(via: EdgeId, dir: 1 | -1): Exit[] {
    const arrival = this.edge(via);
    const nodeId = dir === 1 ? arrival.to : arrival.from;
    const node = this.node(nodeId);
    const headingIn = dir === 1 ? endHeading(arrival) : wrap(startHeading(arrival) + Math.PI);
    const all = this.tileOrThrow(idTile(nodeId)).restrictionsAt(idIndex(nodeId));
    const restrictions = all.length ? all.filter((r) => r.from === via) : all;
    const only = restrictions.length ? restrictions.filter((r) => r.kind === RestrictionKind.only) : restrictions;
    return node.edges.map(({ edge: id, end }) => {
      const out = this.edge(id);
      const exitDir: 1 | -1 = end === 0 ? 1 : -1;
      const headingOut = exitDir === 1 ? startHeading(out) : wrap(endHeading(out) + Math.PI);
      const restricted = restrictions.length
        ? only.length
          ? !only.some((r) => r.to === id)
          : restrictions.some((r) => r.kind === RestrictionKind.no && r.to === id)
        : false;
      return {
        edge: id,
        dir: exitDir,
        turnRad: wrap(headingOut - headingIn),
        againstOneway: out.oneway === (exitDir === 1 ? Oneway.backward : Oneway.forward),
        restricted,
        uTurn: id === via,
      };
    });
  }

  private tileOrThrow(index: number): Tile {
    const tile = this.tile(index);
    if (!tile) throw new RangeError(`empty or missing tile ${index}`);
    return tile;
  }

  private tile(index: number): Tile | null {
    const hit = this.cache.get(index);
    if (hit) {
      this.cache.delete(index);
      this.cache.set(index, hit);
      return hit;
    }
    if (index < 0 || index >= this.directory.length - 1) return null;
    const start = this.directory[index];
    const length = this.directory[index + 1] - start;
    if (length === 0) return null;
    const tile = new Tile(index, aligned(this.source.read(this.dataOffset + start, length)));
    this.stats.tileLoads++;
    this.stats.bytesRead += length;
    this.cache.set(index, tile);
    if (this.cache.size > this.cacheTiles) {
      for (const key of this.cache.keys()) {
        if (this.cache.size <= this.cacheTiles) break;
        if (key !== index && !this.pinned.has(key)) this.cache.delete(key);
      }
    }
    this.stats.cachedTiles = this.cache.size;
    return tile;
  }
}

/** A buffer the typed views can start at offset 0 of. */
function aligned(bytes: Uint8Array): ArrayBufferLike {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
}

/** Fractional Web Mercator tile coordinates. */
export function tileXY(lon: number, lat: number, zoom: number): [number, number] {
  const n = 2 ** zoom;
  const phi = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n];
}

function segmentHeading(xy: Float64Array, i: number): number {
  return Math.atan2(xy[2 * i + 2] - xy[2 * i], xy[2 * i + 3] - xy[2 * i + 1]);
}

/** Heading of the first non-degenerate segment, in geometry direction. */
function startHeading(edge: RoadEdge): number {
  if (edge.startHeadingRad !== undefined) return edge.startHeadingRad;
  const segs = edge.cum.length - 1;
  let heading = 0;
  for (let i = 0; i < segs; i++) {
    if (edge.cum[i + 1] > edge.cum[i]) {
      heading = segmentHeading(edge.xy, i);
      break;
    }
  }
  return (edge.startHeadingRad = heading);
}

/** Heading of the last non-degenerate segment, in geometry direction. */
function endHeading(edge: RoadEdge): number {
  if (edge.endHeadingRad !== undefined) return edge.endHeadingRad;
  let heading = 0;
  for (let i = edge.cum.length - 2; i >= 0; i--) {
    if (edge.cum[i + 1] > edge.cum[i]) {
      heading = segmentHeading(edge.xy, i);
      break;
    }
  }
  return (edge.endHeadingRad = heading);
}

export function closestPoint(edge: RoadEdge, e: number, n: number): NearEdge {
  const { xy, cum } = edge;
  let best: NearEdge = { edge, distanceM: Infinity, alongM: 0, e: xy[0], n: xy[1], headingRad: startHeading(edge) };
  for (let i = 0; i + 1 < cum.length; i++) {
    const ax = xy[2 * i], ay = xy[2 * i + 1];
    const dx = xy[2 * i + 2] - ax, dy = xy[2 * i + 3] - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((e - ax) * dx + (n - ay) * dy) / len2)) : 0;
    const px = ax + t * dx, py = ay + t * dy;
    const d = Math.hypot(e - px, n - py);
    if (d < best.distanceM) {
      best = { edge, distanceM: d, alongM: cum[i] + t * Math.sqrt(len2), e: px, n: py, headingRad: len2 > 0 ? Math.atan2(dx, dy) : best.headingRad };
    }
  }
  return best;
}
