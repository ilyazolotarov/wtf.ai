import { bearingRad, circlePolygon, haversineM } from "@/nav/geo";

const kyiv = { lat: 50.4501, lon: 30.5234 };
const lviv = { lat: 49.8397, lon: 24.0297 };

describe("geospatial helpers", () => {
  test("haversine distance is symmetric and plausible for Kyiv to Lviv", () => {
    const distance = haversineM(kyiv, lviv);
    expect(distance).toBeGreaterThan(400_000);
    expect(distance).toBeLessThan(600_000);
    expect(haversineM(kyiv, lviv)).toBeCloseTo(haversineM(lviv, kyiv), 6);
  });

  test("bearing points generally west from Kyiv toward Lviv", () => {
    expect(bearingRad(kyiv, lviv)).toBeLessThan(0);
  });

  test("circle polygon is closed and includes the requested vertex count", () => {
    const polygon = circlePolygon(kyiv, 120, 24);
    const ring = polygon.geometry.coordinates[0];
    expect(ring).toHaveLength(25);
    expect(ring[0]).toEqual(ring[24]);
  });
});
