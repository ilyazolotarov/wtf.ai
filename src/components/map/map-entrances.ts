// Building entrances on the map (SEARCH-SPEC §5): only those around the view, cut from the search file, never the whole
// region's. The region's file as one GeoJSON source cost MapLibre about 300 MB a map for Ukraine's 118,000 points
// (iOS simulator, 2026-11-01: 504 MB with it, 200 MB without), twice with the car's screen on; iPhones were warned at
// 1 GB and ended in the background.
import type { SearchIndex } from "@/nav/search/search-index";

/** The entrances show from this zoom (`EntranceLayers`). */
export const ENTRANCE_MINZOOM = 16;
/** Zoomed out further, the area isn't cut again: what was sent stays, nothing is drawn. */
const AREA_FROM_ZOOM = ENTRANCE_MINZOOM - 1;
/** The area is the view grown by this share of its size on each side: the view moves this far before it's cut again. */
const AREA_MARGIN = 0.5;
/**
 * A view counts as no taller than twice this (degrees: ~3.3 km, its area ~6.7 km) about its middle: a tilted one reaches
 * far, where the entrances are too small to draw.
 */
const MAX_HALF_DEG = 0.015;

/** [west, south, east, north], degrees, as MapLibre's `bounds`. */
export type Box = [number, number, number, number];

export type EntranceFeatures = { type: "FeatureCollection"; features: unknown[] };

/** The view, no larger than `MAX_HALF_DEG` about its middle. */
function capped([w, s, e, n]: Box): Box {
  const lat = (s + n) / 2;
  const lon = (w + e) / 2;
  const halfLat = Math.min((n - s) / 2, MAX_HALF_DEG);
  const halfLon = Math.min((e - w) / 2, MAX_HALF_DEG / Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return [lon - halfLon, lat - halfLat, lon + halfLon, lat + halfLat];
}

const holds = (a: Box, b: Box) => a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3];

/**
 * The area whose entrances the map holds: `was` while it still holds the view (or the map is zoomed out past where
 * they show), else the view grown by `AREA_MARGIN`. The same object back when nothing changed: as state, no render.
 */
export function entranceArea(was: Box | null, view: Box | null, zoom: number): Box | null {
  if (!view || !view.every(Number.isFinite) || !Number.isFinite(zoom) || zoom < AREA_FROM_ZOOM) return was;
  const v = capped(view);
  if (was && holds(was, v)) return was;
  const dx = (v[2] - v[0]) * AREA_MARGIN;
  const dy = (v[3] - v[1]) * AREA_MARGIN;
  return [v[0] - dx, v[1] - dy, v[2] + dx, v[3] + dy];
}

/** The search file's entrances in the area as points with their numbers (`r`, "" without one); null without either. */
export function entranceFeatures(index: SearchIndex | null, area: Box | null): EntranceFeatures | null {
  if (!index || !area) return null;
  return {
    type: "FeatureCollection",
    features: index.entrancesIn(...area).map((e) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [e.lon, e.lat] },
      properties: { r: e.ref ?? "" },
    })),
  };
}
