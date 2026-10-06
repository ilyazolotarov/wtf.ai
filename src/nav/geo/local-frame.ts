import type { Coordinate } from "./index";

const EARTH_RADIUS_M = 6_371_000;
const DEG = Math.PI / 180;

/**
 * Local east/north tangent plane around an origin (SPEC §3.4). Equirectangular, so keep
 * positions within a few km of the origin: the scale error is ~0.08 % at 5 km.
 */
export class LocalFrame {
  readonly origin: Coordinate;
  private readonly cosLat: number;

  constructor(origin: Coordinate) {
    this.origin = { lat: origin.lat, lon: origin.lon };
    this.cosLat = Math.cos(origin.lat * DEG);
  }

  /** [east, north] in metres. */
  toEnu(c: Coordinate): [number, number] {
    return [
      (c.lon - this.origin.lon) * DEG * EARTH_RADIUS_M * this.cosLat,
      (c.lat - this.origin.lat) * DEG * EARTH_RADIUS_M,
    ];
  }

  /** `toEnu` of packed [lon0, lat0, lon1, lat1, …] into `out` as [e0, n0, e1, n1, …], without allocating. */
  toEnuArray(lonLat: ArrayLike<number>, out: Float64Array): void {
    const { lon, lat } = this.origin;
    const cosLat = this.cosLat;
    // The same operations in the same order as `toEnu`: bit-identical results.
    for (let i = 0; i + 1 < lonLat.length; i += 2) {
      out[i] = (lonLat[i] - lon) * DEG * EARTH_RADIUS_M * cosLat;
      out[i + 1] = (lonLat[i + 1] - lat) * DEG * EARTH_RADIUS_M;
    }
  }

  toCoordinate(east: number, north: number): Coordinate {
    return {
      lat: this.origin.lat + north / (EARTH_RADIUS_M * DEG),
      lon: this.origin.lon + east / (EARTH_RADIUS_M * DEG * this.cosLat),
    };
  }
}
