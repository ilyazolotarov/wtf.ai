import type { Feature, FeatureCollection } from "geojson";

import { circlePolygon } from "../geo";
import type { ReplayResult } from "./replay";

/**
 * Replay result as GeoJSON: the fused track (split by mode), uncertainty circles every
 * `circleEveryS`, and every GNSS fix with its outcome and accuracy.
 */
export function replayToGeoJson(result: ReplayResult, circleEveryS = 15): FeatureCollection {
  const features: Feature[] = [];

  // One line per run of the same mode; consecutive runs share their joining point.
  const segments: { mode: string; coords: [number, number][] }[] = [];
  let nextCircle = -Infinity;
  for (const p of result.track) {
    const current = segments.at(-1);
    const point: [number, number] = [p.lon, p.lat];
    if (current?.mode === p.mode) current.coords.push(point);
    else segments.push({ mode: p.mode, coords: current ? [current.coords[current.coords.length - 1], point] : [point] });
    if (p.tS >= nextCircle) {
      nextCircle = p.tS + circleEveryS;
      const circle = circlePolygon(p, Math.max(1, p.accuracyM), 32);
      circle.properties = { kind: "accuracy", mode: p.mode, tS: Math.round(p.tS), accuracyM: Math.round(p.accuracyM) };
      features.push(circle);
    }
  }
  for (const s of segments) {
    if (s.coords.length < 2) continue;
    features.push({
      type: "Feature",
      properties: { kind: "track", mode: s.mode },
      geometry: { type: "LineString", coordinates: s.coords },
    });
  }

  for (const f of result.fixes) {
    features.push({
      type: "Feature",
      properties: {
        kind: "fix",
        status: f.status,
        satellite: f.satellite,
        tS: Math.round(f.tS * 10) / 10,
        hAccM: Math.round(f.fix.hAccM),
        errorM: f.errorM === undefined ? null : Math.round(f.errorM),
      },
      geometry: { type: "Point", coordinates: [f.fix.lon, f.fix.lat] },
    });
  }
  return { type: "FeatureCollection", features };
}
