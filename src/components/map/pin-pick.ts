import type { Coordinate } from "@/nav/geo";

/**
 * What a dropped pin names, by the zoom it was dropped at (UI-SPEC §6). Where the map draws buildings (from z13, Liberty's
 * building layer): the building pressed, else the street under the finger, else the nearest house. Where it doesn't:
 * the settlement, down to z9; below that nothing ("Dropped pin"). The pin keeps its exact point either way: Route here
 * and I'm here use it.
 */
export const BUILDING_ZOOM = 13;
export const SETTLEMENT_ZOOM = 9;
/** Half the box searched for a street under the finger (pt). */
export const FINGER_PT = 24;

/** "building": a house or a street, as pressed; "settlement": the town or village. */
export type PinLevel = "building" | "settlement" | null;

export function pinLevel(zoom: number): PinLevel {
  if (zoom >= BUILDING_ZOOM) return "building";
  if (zoom >= SETTLEMENT_ZOOM) return "settlement";
  return null;
}

export interface StreetName {
  name: string;
  nameEn: string | null;
}

/** What the map knew where the pin was dropped. */
export interface PinPick {
  zoom: number;
  /** The named street drawn nearest the finger (where buildings are drawn), if any. */
  street: StreetName | null;
  /** Where buildings are drawn: one is right under the finger (else it pressed a road, a yard, a field). */
  onBuilding?: boolean;
}

export interface Pin extends Coordinate {
  pick?: PinPick;
}

/** Of the street features queried around `at`, the named one whose line passes nearest it. */
export function nearestStreet(features: GeoJSON.Feature[], at: Coordinate): StreetName | null {
  const kx = Math.cos((at.lat * Math.PI) / 180);
  let best: { street: StreetName; d: number } | null = null;
  for (const f of features) {
    const p = f.properties ?? {};
    const name = typeof p.name === "string" && p.name ? p.name : null;
    if (!name || !f.geometry) continue;
    const g = f.geometry;
    const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
    for (const line of lines) {
      for (let i = 0; i + 1 < line.length; i++) {
        const d = segmentDistance(at, line[i], line[i + 1], kx);
        if (!best || d < best.d) {
          const en = [p.name_en, p["name:en"]].find((v): v is string => typeof v === "string" && v !== "" && v !== name);
          best = { street: { name, nameEn: en ?? null }, d };
        }
      }
    }
  }
  return best?.street ?? null;
}

/** Distance (in degrees of latitude, scaled: only compared) from `at` to the segment a–b of [lon, lat]. */
function segmentDistance(at: Coordinate, a: number[], b: number[], kx: number): number {
  const ax = (a[0] - at.lon) * kx;
  const ay = a[1] - at.lat;
  const bx = (b[0] - at.lon) * kx;
  const by = b[1] - at.lat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
