import { haversineM } from "@/nav/geo";
import { hypothesisFeatures, pointFeatures, routeFeatures, sectorFeatures } from "@/components/map/map-features";

const car = { lat: 50.45, lon: 30.52 };

describe("map features", () => {
  test("GeoJSON takes [lon, lat]", () => {
    expect(pointFeatures(car).features[0].geometry.coordinates).toEqual([30.52, 50.45]);
  });

  test("a sector is a closed ring from the car out to its radius", () => {
    const ring = sectorFeatures(car, 0, (28 * Math.PI) / 180, 45).features[0].geometry.coordinates[0];
    expect(ring[0]).toEqual([car.lon, car.lat]);
    expect(ring[ring.length - 1]).toEqual(ring[0]);
    for (const [lon, lat] of ring.slice(1, -1)) expect(haversineM(car, { lat, lon })).toBeCloseTo(45, 0);
  });

  test("a route of one point draws nothing", () => {
    expect(routeFeatures([[30.52, 50.45]]).features).toHaveLength(0);
    expect(routeFeatures([[30.52, 50.45], [30.53, 50.46]]).features).toHaveLength(1);
  });

  test("hypotheses: a ring and a weight label each, none without an overlay", () => {
    expect(hypothesisFeatures(null).rings.features).toHaveLength(0);
    const { rings, labels } = hypothesisFeatures({
      particles: [],
      clusters: [{ lat: car.lat, lon: car.lon, spreadM: 20, weight: 0.734 }],
    } as never);
    expect(rings.features).toHaveLength(1);
    expect(labels.features[0].properties).toEqual({ label: "73%" });
  });
});
