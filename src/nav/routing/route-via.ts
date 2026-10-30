// What sets a route apart from the others to the same destination (ROUTING-SPEC §8.7): the street most of its own
// stretch, the part no other route shares, runs along. The road graph has no names; `nameAt` gives the street of a
// point (the search index's nearest house), and the points of a route's own stretch vote.

import type { Coordinate } from "@/nav/geo";

/** A point of a route further than this from every other route is on its own stretch. */
export const VIA_APART_M = 40;
/** Points along a route this far apart. */
export const VIA_STEP_M = 75;
/** At most this many of a route's own points are asked for a name (each a scan of the region's houses). */
export const VIA_ASKED = 12;

const M_PER_DEG = 111_195;

/** Metres east and north of `origin`: flat enough within a city. */
function local(origin: Coordinate) {
  const kx = Math.cos((origin.lat * Math.PI) / 180) * M_PER_DEG;
  return (p: Coordinate): [number, number] => [(p.lon - origin.lon) * kx, (p.lat - origin.lat) * M_PER_DEG];
}

/** Points every `stepM` along a line, its first included. */
export function alongEvery(line: Coordinate[], stepM: number): Coordinate[] {
  if (line.length === 0) return [];
  const xy = local(line[0]);
  const out: Coordinate[] = [line[0]];
  let carried = 0;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = xy(line[i - 1]);
    const [bx, by] = xy(line[i]);
    const len = Math.hypot(bx - ax, by - ay);
    let at = stepM - carried;
    while (at <= len) {
      const f = at / len;
      out.push({ lat: line[i - 1].lat + (line[i].lat - line[i - 1].lat) * f, lon: line[i - 1].lon + (line[i].lon - line[i - 1].lon) * f });
      at += stepM;
    }
    carried = len - (at - stepM);
  }
  return out;
}

/** The grid's cells, m: a point is measured only against the segments passing within `apartM` of its cell. */
const CELL_M = 100;

/**
 * Whether each point is further than `apartM` from every line. The lines' segments are filed by the grid cells they
 * pass near, so a point is measured against those around it alone: against every vertex, a 200 km route and two
 * alternatives took 20 s of the phone's JS thread. The grid is one flat frame, its east–west scale the first point's;
 * a point is measured in its own frame, as before. The cells reach half as far again: the grid's east–west scale is
 * off by the ratio of the two latitudes' cosines (under 20 % across Ukraine).
 */
function apartFrom(points: Coordinate[], lines: Coordinate[][], apartM: number): boolean[] {
  if (points.length === 0) return [];
  const origin = points[0];
  const xy = local(origin);
  const cosOrigin = Math.cos((origin.lat * Math.PI) / 180);
  const reach = apartM * 1.5;
  const cells = new Map<string, number[][]>();
  for (const line of lines) {
    const flat = line.map(xy);
    // A line of one point is a segment from it to itself.
    for (let i = flat.length > 1 ? 1 : 0; i < flat.length; i++) {
      const [ax, ay] = flat[Math.max(0, i - 1)];
      const [bx, by] = flat[i];
      const segment = [ax, ay, bx, by];
      const x0 = Math.floor((Math.min(ax, bx) - reach) / CELL_M);
      const x1 = Math.floor((Math.max(ax, bx) + reach) / CELL_M);
      const y0 = Math.floor((Math.min(ay, by) - reach) / CELL_M);
      const y1 = Math.floor((Math.max(ay, by) + reach) / CELL_M);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const key = `${cx},${cy}`;
          const list = cells.get(key);
          if (list) list.push(segment);
          else cells.set(key, [segment]);
        }
      }
    }
  }
  return points.map((p) => {
    const [px, py] = xy(p);
    // East–west in the point's own frame, as `local(p)` would have it.
    const k = Math.cos((p.lat * Math.PI) / 180) / cosOrigin;
    for (const segment of cells.get(`${Math.floor(px / CELL_M)},${Math.floor(py / CELL_M)}`) ?? []) {
      const ax = (segment[0] - px) * k;
      const ay = segment[1] - py;
      const dx = (segment[2] - px) * k - ax;
      const dy = segment[3] - py - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      if (Math.hypot(ax + t * dx, ay + t * dy) <= apartM) return false;
    }
    return true;
  });
}

/**
 * Each route's street where it goes its own way: the name most of its own points have (null: none named, or no stretch
 * of its own). The routes in the order given (the route followed first, then its alternatives).
 */
export function viaNames(routes: Coordinate[][], nameAt: (at: Coordinate) => string | null): (string | null)[] {
  return routes.map((route, i) => {
    const along = alongEvery(route, VIA_STEP_M);
    const apart = apartFrom(along, routes.filter((_, j) => j !== i), VIA_APART_M);
    const own = along.filter((_, k) => apart[k]);
    // Spread over the whole stretch, not its first metres.
    const asked = own.length <= VIA_ASKED ? own : Array.from({ length: VIA_ASKED }, (_, k) => own[Math.floor(((k + 0.5) * own.length) / VIA_ASKED)]);
    const votes = new Map<string, number>();
    for (const p of asked) {
      const name = nameAt(p);
      if (name) votes.set(name, (votes.get(name) ?? 0) + 1);
    }
    let best: string | null = null;
    for (const [name, n] of votes) if (best === null || n > (votes.get(best) ?? 0)) best = name;
    return best;
  });
}
