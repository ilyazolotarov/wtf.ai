import type { Feature, FeatureCollection, LineString, Point, Polygon } from "geojson";

import { circlePolygon, destinationAtBearing } from "@/nav/geo";
import type { PositionEstimate } from "@/nav/position/types";
import type { MapMatchOverlay } from "@/services/navigation/navigator-service";
import type { AlternativeRoute } from "@/services/navigation/route-service";

/** GeoJSON for the map's sources (MapLibre takes [lon, lat]). Empty collections draw nothing. */

export function accuracyFeatures(position: PositionEstimate): FeatureCollection<Polygon> {
  return {
    type: "FeatureCollection",
    features: [circlePolygon(position, Math.max(5, position.accuracyM), 48)],
  };
}

/** Ground metres one screen point spans at `zoom` and latitude `latDeg` (MapLibre's 512-point tiles). */
export function metresPerPoint(latDeg: number, zoom: number): number {
  return (40_075_016.686 * Math.cos((latDeg * Math.PI) / 180)) / 2 ** (zoom + 9);
}

/** The camera, as MapLibre reports it: zoom, bearing (degrees clockwise from north) and tilt (degrees). */
export interface CameraView {
  zoom: number;
  bearingDeg: number;
  pitchDeg: number;
}

/**
 * A sector that looks the same on screen in every camera: `radiusPt` long and `halfAngleRad` each side of where
 * `headingRad` points on screen, drawn on the ground. A tilted map squashes the ground along the screen's vertical by
 * cos(tilt), so the sector is stretched that way first (perspective across a few dozen points is left out). The
 * heading cone, so the map's matches the lessons' (puck-style.ts).
 */
export function screenSectorFeatures(
  center: { lat: number; lon: number },
  headingRad: number,
  halfAngleRad: number,
  radiusPt: number,
  view: CameraView,
): FeatureCollection<Polygon> {
  const mpp = metresPerPoint(center.lat, view.zoom);
  const bearing = (view.bearingDeg * Math.PI) / 180;
  const squash = Math.max(0.1, Math.cos((view.pitchDeg * Math.PI) / 180));
  // Where the heading points on screen: its ahead part shrinks with the tilt, its sideways part doesn't.
  const axis = Math.atan2(Math.sin(headingRad - bearing), Math.cos(headingRad - bearing) * squash);
  const ring: [number, number][] = [[center.lon, center.lat]];
  const steps = Math.max(8, Math.round((halfAngleRad * 180) / Math.PI / 4));
  for (let i = 0; i <= steps; i++) {
    const s = axis - halfAngleRad + (2 * halfAngleRad * i) / steps;
    const across = radiusPt * Math.sin(s) * mpp;
    const ahead = (radiusPt * Math.cos(s) * mpp) / squash;
    const p = destinationAtBearing(center, bearing + Math.atan2(across, ahead), Math.hypot(across, ahead));
    ring.push([p.lon, p.lat]);
  }
  ring.push([center.lon, center.lat]);
  return { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } }] };
}

/** Sector ahead of a point, in metres: the placed car's arrow. */
export function sectorFeatures(
  position: { lat: number; lon: number },
  headingRad: number,
  halfAngleRad: number,
  radiusM: number,
): FeatureCollection<Polygon> {
  const ring: [number, number][] = [[position.lon, position.lat]];
  const steps = Math.max(8, Math.round((halfAngleRad * 180) / Math.PI / 4));
  for (let i = 0; i <= steps; i++) {
    const bearing = headingRad - halfAngleRad + (2 * halfAngleRad * i) / steps;
    const p = destinationAtBearing(position, bearing, radiusM);
    ring.push([p.lon, p.lat]);
  }
  ring.push([position.lon, position.lat]);
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [ring] },
      },
    ],
  };
}

export function pointFeatures(point: { lat: number; lon: number }): FeatureCollection<Point> {
  const feature: Feature<Point> = {
    type: "Feature",
    properties: {},
    geometry: { type: "Point", coordinates: [point.lon, point.lat] },
  };
  return { type: "FeatureCollection", features: [feature] };
}

/** Other roads the car may be on, weighted (MAPMATCH-SPEC §6.2). */
export function alternativeFeatures(points: { lat: number; lon: number; weight: number }[]): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: points.map((p) => ({
      type: "Feature",
      properties: { weight: p.weight },
      geometry: { type: "Point", coordinates: [p.lon, p.lat] },
    })),
  };
}

export function particleFeatures(overlay: MapMatchOverlay | null): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: (overlay?.particles ?? []).map(([lat, lon, w, off]) => ({
      type: "Feature",
      properties: { w, off },
      geometry: { type: "Point", coordinates: [lon, lat] },
    })),
  };
}

/** The filter's hypotheses: a ring of each one's spread, and its weight above it. */
export function hypothesisFeatures(overlay: MapMatchOverlay | null): {
  rings: FeatureCollection<Polygon>;
  labels: FeatureCollection<Point>;
} {
  const clusters = overlay?.clusters ?? [];
  return {
    rings: {
      type: "FeatureCollection",
      features: clusters.map((c) => circlePolygon(c, Math.max(3, c.spreadM), 32)),
    },
    labels: {
      type: "FeatureCollection",
      features: clusters.map((c) => ({
        type: "Feature",
        properties: { label: `${Math.round(c.weight * 100)}%` },
        geometry: {
          type: "Point",
          coordinates: (({ lat, lon }) => [lon, lat])(destinationAtBearing(c, 0, Math.max(3, c.spreadM))),
        },
      })),
    },
  };
}

export function routeFeatures(coordinates: [number, number][]): FeatureCollection<LineString> {
  if (coordinates.length < 2) return emptyLines();
  const feature: Feature<LineString> = {
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates },
  };
  return { type: "FeatureCollection", features: [feature] };
}

/** The alternatives' lines, each with its `index` for a tap to follow it. */
export function alternativeLineFeatures(alternatives: AlternativeRoute[] | undefined): FeatureCollection<LineString> {
  return {
    type: "FeatureCollection",
    features: (alternatives ?? []).map((a, index) => ({
      type: "Feature",
      properties: { index },
      geometry: { type: "LineString", coordinates: a.plan.coordinates.map((c) => [c.lon, c.lat]) },
    })),
  };
}

export function alternativeLabelFeatures(
  alternatives: AlternativeRoute[] | undefined,
  label: (deltaS: number) => string,
): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: (alternatives ?? []).map((a, index) => ({
      type: "Feature",
      properties: { index, label: label(a.deltaS) },
      geometry: { type: "Point", coordinates: [a.labelAt.lon, a.labelAt.lat] },
    })),
  };
}

export function emptyPolygons(): FeatureCollection<Polygon> {
  return { type: "FeatureCollection", features: [] };
}

export function emptyPoints(): FeatureCollection<Point> {
  return { type: "FeatureCollection", features: [] };
}

export function emptyLines(): FeatureCollection<LineString> {
  return { type: "FeatureCollection", features: [] };
}
