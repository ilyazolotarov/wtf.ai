// Is the car inside the active offline region, and if not, which region is it in (SPEC §3.8,
// UI-SPEC §6)? Regions carry a simplified outline in index.json (`tools/tiles` region_outline);
// releases built before it have only bounds, which overlap between oblasts.

import type { Coordinate } from "@/nav/geo";

export interface RegionShape {
  region: string;
  /** [minLon, minLat, maxLon, maxLat] */
  bounds: [number, number, number, number];
  /** Outer rings of [lon, lat]; absent in older catalogs. */
  outline?: [number, number][][];
}

/** Outside by less than this (m) still counts as inside: no prompt at a border crossing's first metres. */
export const OUTSIDE_MARGIN_M = 1_000;
/** Coarser fixes than this can't place the car in a region. */
export const REGION_CHECK_MAX_ACCURACY_M = 5_000;

/**
 * The point to check and the margin to allow, from the published position; null when it can't
 * tell. Telling an oblast needs far less than navigation does: a Wi-Fi or cell fix indoors
 * ("APPROXIMATE", trust NO_FIX) or dead reckoning is enough. Only a position suspected of
 * spoofing (UNTRUSTED) is ignored: it may be anywhere.
 */
export function regionCheckPoint(position: {
  lat: number;
  lon: number;
  accuracyM: number;
  trust: string;
}): { at: Coordinate; marginM: number } | null {
  if (position.trust === "UNTRUSTED") return null;
  if (!Number.isFinite(position.accuracyM) || position.accuracyM > REGION_CHECK_MAX_ACCURACY_M) return null;
  return { at: { lat: position.lat, lon: position.lon }, marginM: Math.max(OUTSIDE_MARGIN_M, position.accuracyM) };
}

const M_PER_DEG = 111_195;

/** Ray casting on one ring. */
function inRing(ring: [number, number][], lon: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance (m) from a point to a ring's edges, in a local equirectangular frame. */
function ringDistanceM(ring: [number, number][], p: Coordinate): number {
  const kx = Math.cos((p.lat * Math.PI) / 180) * M_PER_DEG;
  let best = Infinity;
  for (let i = 1; i < ring.length; i++) {
    const ax = (ring[i - 1][0] - p.lon) * kx;
    const ay = (ring[i - 1][1] - p.lat) * M_PER_DEG;
    const bx = (ring[i][0] - p.lon) * kx;
    const by = (ring[i][1] - p.lat) * M_PER_DEG;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

function inBox(b: RegionShape["bounds"], p: Coordinate, marginM: number): boolean {
  const mLat = marginM / M_PER_DEG;
  const mLon = marginM / (M_PER_DEG * Math.cos((p.lat * Math.PI) / 180));
  return p.lon >= b[0] - mLon && p.lon <= b[2] + mLon && p.lat >= b[1] - mLat && p.lat <= b[3] + mLat;
}

/** Inside the region, or outside it by less than `marginM`. */
export function regionContains(region: RegionShape, p: Coordinate, marginM = 0): boolean {
  if (!inBox(region.bounds, p, marginM)) return false;
  const rings = region.outline;
  if (!rings?.length) return true; // bounds only
  if (rings.some((ring) => inRing(ring, p.lon, p.lat))) return true;
  return marginM > 0 && rings.some((ring) => ringDistanceM(ring, p) < marginM);
}

const area = (r: RegionShape) => (r.bounds[2] - r.bounds[0]) * (r.bounds[3] - r.bounds[1]);

/** The smallest region that has the point (an oblast before all of Ukraine); null for none. */
export function smallestRegionAt<R extends RegionShape>(regions: R[], p: Coordinate): R | null {
  let best: R | null = null;
  for (const r of regions) {
    if (regionContains(r, p) && (!best || area(r) < area(best))) best = r;
  }
  return best;
}

export type RegionAdvice<R> =
  | { kind: "inside" }
  /** Another downloaded region has the car: switching needs no download. */
  | { kind: "switch"; region: R }
  /** A region from the catalog has it. */
  | { kind: "download"; region: R }
  /** Outside the active region, and no known region has the car (outside Ukraine, or no catalog yet). */
  | { kind: "outside" };

/**
 * What to tell a driver at `p` with `active` as the map: nothing while inside it (with the
 * margin); else the installed region to switch to, or the catalog region to download.
 */
export function adviseRegion<R extends RegionShape>(
  active: R,
  installed: R[],
  catalog: R[],
  p: Coordinate,
  marginM = OUTSIDE_MARGIN_M,
): RegionAdvice<R> {
  if (regionContains(active, p, marginM)) return { kind: "inside" };
  const have = smallestRegionAt(
    installed.filter((r) => r.region !== active.region),
    p,
  );
  if (have) return { kind: "switch", region: have };
  const get = smallestRegionAt(catalog, p);
  return get ? { kind: "download", region: get } : { kind: "outside" };
}
