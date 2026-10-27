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

/** How far a point is from a line, m. */
export function distanceToLineM(p: Coordinate, line: Coordinate[]): number {
  const xy = local(p);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = xy(line[i - 1]);
    const [bx, by] = xy(line[i]);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return line.length === 1 ? Math.hypot(...xy(line[0])) : best;
}

/**
 * Each route's street where it goes its own way: the name most of its own points have (null: none named, or no stretch
 * of its own). The routes in the order given (the route followed first, then its alternatives).
 */
export function viaNames(routes: Coordinate[][], nameAt: (at: Coordinate) => string | null): (string | null)[] {
  return routes.map((route, i) => {
    const others = routes.filter((_, j) => j !== i);
    const own = alongEvery(route, VIA_STEP_M).filter((p) => others.every((o) => distanceToLineM(p, o) > VIA_APART_M));
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
