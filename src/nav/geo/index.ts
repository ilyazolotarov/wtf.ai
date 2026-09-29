import type { Feature, Polygon } from "geojson";

export interface Coordinate {
  lat: number;
  lon: number;
}

const EARTH_RADIUS_M = 6_371_000;

export function haversineM(a: Coordinate, b: Coordinate): number {
  const latitudeDelta = toRadians(b.lat - a.lat);
  const longitudeDelta = toRadians(b.lon - a.lon);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(a.lat)) *
      Math.cos(toRadians(b.lat)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(haversine));
}

export function bearingRad(a: Coordinate, b: Coordinate): number {
  const latitudeA = toRadians(a.lat);
  const latitudeB = toRadians(b.lat);
  const longitudeDelta = toRadians(b.lon - a.lon);
  return Math.atan2(
    Math.sin(longitudeDelta) * Math.cos(latitudeB),
    Math.cos(latitudeA) * Math.sin(latitudeB) -
      Math.sin(latitudeA) * Math.cos(latitudeB) * Math.cos(longitudeDelta),
  );
}

export function destinationAtBearing(
  start: Coordinate,
  bearing: number,
  distanceM: number,
): Coordinate {
  const angularDistance = distanceM / EARTH_RADIUS_M;
  const latitude = toRadians(start.lat);
  const longitude = toRadians(start.lon);
  const destinationLatitude = Math.asin(
    Math.sin(latitude) * Math.cos(angularDistance) +
      Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const destinationLongitude =
    longitude +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
      Math.cos(angularDistance) -
        Math.sin(latitude) * Math.sin(destinationLatitude),
    );
  return {
    lat: toDegrees(destinationLatitude),
    lon: toDegrees(destinationLongitude),
  };
}

export function circlePolygon(
  center: Coordinate,
  radiusM: number,
  steps = 48,
): Feature<Polygon> {
  const ring: [number, number][] = [];
  const safeSteps = Math.max(8, Math.floor(steps));

  for (let step = 0; step <= safeSteps; step += 1) {
    const point = destinationAtBearing(
      center,
      (step / safeSteps) * Math.PI * 2,
      radiusM,
    );
    ring.push([point.lon, point.lat]);
  }

  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}
