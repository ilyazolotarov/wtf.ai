// Places along the route ahead (STOPS-SPEC §6.3): the route as a line with a grid of its segments, each place
// measured against the segments near it only; the side of the road it is on; the first few by distance along.

import { haversineM, type Coordinate } from "../geo";
import type { RoadSide, RoutePlan } from "./router";
import { sideOf } from "./trip";

/** Places up to this far from the route ahead. */
export const ALONG_CORRIDOR_M = 500;
/** Places listed at a time ("further along the route" adds as many again). */
export const ALONG_PAGE = 10;
/** The route ahead is read in stretches this long, each one box of the search file's cells. */
const CHUNK_M = 5000;
/** The grid's cells, m. */
const CELL_M = 500;
const M_PER_DEG = 111_195;

export interface Box {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface Projection {
  /** Along the route from its start, in the plan's metres. */
  alongM: number;
  /** From the route, m. */
  offM: number;
  side: RoadSide | null;
}

/** A plan's polyline in the plan's metres (as guidance counts them), with its segments filed by grid cell. */
export class RouteLine {
  /** Cumulative polyline length at each vertex, m (haversine). */
  private readonly cum: number[];
  /** Polyline metres per plan metre. */
  private readonly scale: number;
  private readonly kx: number;
  private readonly origin: Coordinate;
  private readonly cells = new Map<string, number[]>();

  constructor(readonly plan: RoutePlan) {
    const pts = plan.coordinates;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + haversineM(pts[i - 1], pts[i]));
    const total = this.cum[this.cum.length - 1];
    this.scale = plan.lengthM > 0 && total > 0 ? total / plan.lengthM : 1;
    this.origin = pts[0] ?? { lat: 0, lon: 0 };
    this.kx = Math.cos((this.origin.lat * Math.PI) / 180) * M_PER_DEG;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = this.xy(pts[i]);
      const [bx, by] = this.xy(pts[i + 1]);
      // Every cell the segment's box touches: segments are short, a box is a cell or a few.
      for (let cx = Math.floor(Math.min(ax, bx) / CELL_M); cx <= Math.floor(Math.max(ax, bx) / CELL_M); cx++) {
        for (let cy = Math.floor(Math.min(ay, by) / CELL_M); cy <= Math.floor(Math.max(ay, by) / CELL_M); cy++) {
          const key = `${cx},${cy}`;
          const list = this.cells.get(key);
          if (list) list.push(i);
          else this.cells.set(key, [i]);
        }
      }
    }
  }

  get lengthM(): number {
    return this.plan.lengthM;
  }

  private xy(p: Coordinate): [number, number] {
    return [(p.lon - this.origin.lon) * this.kx, (p.lat - this.origin.lat) * M_PER_DEG];
  }

  /** The point `alongM` (plan metres) along the route, and the heading there. */
  at(alongM: number): { point: Coordinate; headingRad: number } {
    const pts = this.plan.coordinates;
    const poly = Math.max(0, Math.min(this.cum[this.cum.length - 1], alongM * this.scale));
    let lo = 0;
    let hi = this.cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid] <= poly) lo = mid;
      else hi = mid - 1;
    }
    const i = Math.min(lo, pts.length - 2);
    if (i < 0) return { point: pts[0], headingRad: 0 };
    const a = pts[i];
    const b = pts[i + 1];
    const len = this.cum[i + 1] - this.cum[i];
    const t = len > 0 ? Math.max(0, Math.min(1, (poly - this.cum[i]) / len)) : 0;
    const k = Math.cos((a.lat * Math.PI) / 180);
    return {
      point: { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) },
      headingRad: Math.atan2((b.lon - a.lon) * k, b.lat - a.lat),
    };
  }

  /**
   * The closest point of the route at or after `fromM` (plan metres) within `maxOffM` of `p`; null: none. Measured
   * in `p`'s own frame against the segments filed near it. `ahead`: a place whose closest point of the route around
   * the car is behind it is none (the car passed it), not the point at the car.
   */
  project(p: Coordinate, fromM: number, maxOffM: number, { ahead = false }: { ahead?: boolean } = {}): Projection | null {
    const pts = this.plan.coordinates;
    const [px, py] = this.xy(p);
    // The grid's east–west scale is the route start's: reach half as far again for latitudes away from it.
    const reach = Math.ceil((maxOffM * 1.5) / CELL_M);
    const cx0 = Math.floor(px / CELL_M);
    const cy0 = Math.floor(py / CELL_M);
    const seen = new Set<number>();
    const carPoly = fromM * this.scale;
    // Ahead only: measured from a little behind the car, then dropped if its closest point is behind it.
    const fromPoly = ahead ? carPoly - 2 * maxOffM : carPoly;
    const k = Math.cos((p.lat * Math.PI) / 180) * M_PER_DEG;
    let best: { alongPoly: number; offM: number; i: number } | null = null;
    for (let cx = cx0 - reach; cx <= cx0 + reach; cx++) {
      for (let cy = cy0 - reach; cy <= cy0 + reach; cy++) {
        for (const i of this.cells.get(`${cx},${cy}`) ?? []) {
          if (seen.has(i)) continue;
          seen.add(i);
          if (this.cum[i + 1] < fromPoly) continue;
          const ax = (pts[i].lon - p.lon) * k;
          const ay = (pts[i].lat - p.lat) * M_PER_DEG;
          const dx = (pts[i + 1].lon - p.lon) * k - ax;
          const dy = (pts[i + 1].lat - p.lat) * M_PER_DEG - ay;
          const len2 = dx * dx + dy * dy;
          let t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
          // Not behind `fromM` on the segment it falls in.
          const segLen = this.cum[i + 1] - this.cum[i];
          if (segLen > 0 && this.cum[i] + t * segLen < fromPoly) t = (fromPoly - this.cum[i]) / segLen;
          const offM = Math.hypot(ax + t * dx, ay + t * dy);
          if (offM <= maxOffM && (!best || offM < best.offM)) best = { alongPoly: this.cum[i] + t * segLen, offM, i };
        }
      }
    }
    if (!best || (ahead && best.alongPoly < carPoly)) return null;
    return { alongM: best.alongPoly / this.scale, offM: best.offM, side: sideOf(pts[best.i], pts[best.i + 1], p) };
  }

  /** The box around the route between `fromM` and `toM` (plan metres), grown by `marginM`. */
  box(fromM: number, toM: number, marginM: number): Box {
    const pts = this.plan.coordinates;
    const fromPoly = fromM * this.scale;
    const toPoly = toM * this.scale;
    let south = Infinity;
    let west = Infinity;
    let north = -Infinity;
    let east = -Infinity;
    const add = (c: Coordinate) => {
      south = Math.min(south, c.lat);
      north = Math.max(north, c.lat);
      west = Math.min(west, c.lon);
      east = Math.max(east, c.lon);
    };
    add(this.at(fromM).point);
    add(this.at(toM).point);
    for (let i = 0; i < pts.length; i++) if (this.cum[i] > fromPoly && this.cum[i] < toPoly) add(pts[i]);
    const dLat = marginM / M_PER_DEG;
    const dLon = marginM / (Math.cos((((south + north) / 2) * Math.PI) / 180) * M_PER_DEG);
    return { south: south - dLat, west: west - dLon, north: north + dLat, east: east + dLon };
  }
}

export interface AlongHit<P> extends Projection {
  place: P;
}

/**
 * Places within `corridorM` of the route ahead of `fromM`, in order along it: those after the first `skip`, at most
 * `count`. `placesIn` reads a box of the search file. `more`: there may be others further along.
 */
export function placesAlong<P extends Coordinate & { key: string }>(
  line: RouteLine,
  fromM: number,
  placesIn: (box: Box) => P[],
  { skip = 0, count = ALONG_PAGE, corridorM = ALONG_CORRIDOR_M }: { skip?: number; count?: number; corridorM?: number } = {},
): { hits: AlongHit<P>[]; more: boolean } {
  const want = skip + count;
  const found = new Map<string, AlongHit<P>>();
  let chunkFrom = fromM;
  while (chunkFrom < line.lengthM) {
    const chunkTo = Math.min(line.lengthM, chunkFrom + CHUNK_M);
    for (const place of placesIn(line.box(chunkFrom, chunkTo, corridorM))) {
      if (found.has(place.key)) continue;
      const at = line.project(place, fromM, corridorM, { ahead: true });
      if (at) found.set(place.key, { place, ...at });
    }
    chunkFrom = chunkTo;
    // Places found so far that no later stretch can put ahead of: before this stretch's end, less the corridor.
    let settled = 0;
    for (const h of found.values()) if (h.alongM < chunkFrom - corridorM) settled++;
    if (settled > want) break;
  }
  const hits = [...found.values()].sort((a, b) => a.alongM - b.alongM);
  return { hits: hits.slice(skip, want), more: hits.length > want || chunkFrom < line.lengthM };
}
