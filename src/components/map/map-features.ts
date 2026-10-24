import type { Feature, FeatureCollection, LineString, Point, Polygon } from "geojson";

import { bearingRad, circlePolygon, destinationAtBearing, haversineM } from "@/nav/geo";
import type { PositionEstimate } from "@/nav/position/types";
import type { MapMatchOverlay } from "@/services/navigation/navigator-service";
import type { AlternativeRoute } from "@/services/navigation/route-service";

import { MAP_CAR, PUCK_OUTER } from "./puck-style";

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

/**
 * The zoom that shows a circle of `radiusM` at most `maxRadiusPt` across its radius, never closer than `zoom`: in
 * half steps down, so a circle that changes a little doesn't nudge the camera on every fix. Not below `minZoom`.
 */
export function fitCircleZoom(latDeg: number, radiusM: number, maxRadiusPt: number, zoom: number, minZoom = 9): number {
  if (!(radiusM > 0) || !(maxRadiusPt > 0)) return zoom;
  const fit = Math.log2((maxRadiusPt * 40_075_016.686 * Math.cos((latDeg * Math.PI) / 180)) / radiusM) - 9;
  return fit >= zoom ? zoom : Math.max(minZoom, Math.floor(fit * 2) / 2);
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

/**
 * How much the map's car is drawn larger than its footprint's points (`MAP_CAR`): `size` at its zoom, growing at
 * `growth` of the map's rate as it is zoomed in, never below `minSize`, nor shorter on the ground than a real car
 * (`minLengthM`).
 */
export function carScale(latDeg: number, zoom: number): number {
  const { size, atZoom, growth, minSize, minLengthM, footprint } = MAP_CAR;
  return Math.max(minSize, size * 2 ** (growth * (zoom - atZoom)), minLengthM / (footprint.h * metresPerPoint(latDeg, zoom)));
}

/** Points the car's ring and edge reach past its footprint (MAP_CAR: 0.7 + 0.6 pt at size 2), per unit of `carScale`. */
const CAR_EDGE_PT = 0.65;

/** How far the map may stretch the car's image before a denser one is drawn instead. */
const CAR_STRETCH = 1.15;

/**
 * The car's image to draw at `size` times its own on a screen of `pixelRatio` pixels per point: its own (1x–3x, the
 * screen's), or the least dense of the near images (`MAP_CAR.near`) that it would not stretch past `CAR_STRETCH`. The
 * near images are registered at a pixel a point, so `size` is divided by their density.
 */
export function carImage(size: number, pixelRatio: number): { suffix: string; size: number } {
  const need = size * pixelRatio;
  if (need <= pixelRatio * CAR_STRETCH) return { suffix: "", size };
  const density = MAP_CAR.near.find((d) => need <= d * CAR_STRETCH) ?? MAP_CAR.near[MAP_CAR.near.length - 1];
  return { suffix: `-x${density}`, size: size / density };
}

/**
 * The car on the map at `center`, sized for `zoom` on a screen of `pixelRatio`: a point with its heading (`deg`,
 * clockwise from north), its image (`image`, the suffix to `MAP_CAR.image`) and that image's `size` (the car's own drawn
 * at `MAP_CAR.size`).
 */
export function carFeatures(center: { lat: number; lon: number }, headingRad: number, zoom: number, pixelRatio: number): FeatureCollection<Point> {
  const scale = carScale(center.lat, zoom);
  const image = carImage(scale / MAP_CAR.size, pixelRatio);
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {
          deg: (headingRad * 180) / Math.PI,
          image: image.suffix,
          size: image.size,
        },
        geometry: { type: "Point", coordinates: [center.lon, center.lat] },
      },
    ],
  };
}

/** Points the dot must clear the car's outline by before it shows again (`dotOnCar`), so it doesn't flicker at the edge. */
const DOT_OFF_CAR_PT = 8;

/**
 * The dot is on the car (UI-SPEC §6.1): standing, its disc touches the car's outline on screen at `zoom`; once on (`was`),
 * until it is `DOT_OFF_CAR_PT` clear of it. The map then hides the dot, so the car shows.
 */
export function dotOnCar(
  dot: { lat: number; lon: number; speedMps?: number },
  car: { lat: number; lon: number; headingRad: number },
  zoom: number,
  standingMps: number,
  was: boolean,
): boolean {
  if ((dot.speedMps ?? 0) >= standingMps) return false;
  const mpp = metresPerPoint(car.lat, zoom);
  const scale = carScale(car.lat, zoom);
  const { footprint } = MAP_CAR;
  // The dot in the car's frame, points.
  const d = haversineM(car, dot) / mpp;
  const b = bearingRad(car, dot) - car.headingRad;
  const across = Math.abs(d * Math.sin(b)) - (footprint.w / 2 + CAR_EDGE_PT) * scale;
  const along = Math.abs(d * Math.cos(b)) - (footprint.h / 2 + CAR_EDGE_PT) * scale;
  const gap = Math.hypot(Math.max(0, across), Math.max(0, along));
  return gap <= PUCK_OUTER + (was ? DOT_OFF_CAR_PT : 0);
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
