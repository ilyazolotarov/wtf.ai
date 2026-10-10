import { haversineM } from "@/nav/geo";
import { hypothesisFeatures, metresPerPoint, pointFeatures, routeFeatures, screenSectorFeatures, sectorFeatures } from "@/components/map/map-features";

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

  describe("the heading cone looks the same on screen in every camera", () => {
    const flat = { zoom: 17, bearingDeg: 0, pitchDeg: 0 };
    const arc = (view: typeof flat, headingRad: number) =>
      screenSectorFeatures(car, headingRad, (28 * Math.PI) / 180, 34, view).features[0].geometry.coordinates[0].slice(1, -1);
    const metres = (view: typeof flat) => 34 * metresPerPoint(car.lat, view.zoom);

    test("flat: its radius is the points at that zoom, all round the arc", () => {
      for (const [lon, lat] of arc(flat, 0)) expect(haversineM(car, { lat, lon })).toBeCloseTo(metres(flat), 1);
      // One zoom step in: half the metres, the same on screen.
      expect(metres({ ...flat, zoom: 18 })).toBeCloseTo(metres(flat) / 2, 6);
    });

    test("tilted 60°, heading up the screen: twice as long on the ground, as wide", () => {
      const tilted = { ...flat, pitchDeg: 60 };
      const [flatTip, tiltTip] = [arc(flat, 0), arc(tilted, 0)].map((a) => a[Math.floor(a.length / 2)]);
      expect(haversineM(car, { lat: tiltTip[1], lon: tiltTip[0] })).toBeCloseTo(2 * metres(flat), 0);
      const width = (a: number[][]) => haversineM({ lat: a[0][1], lon: a[0][0] }, { lat: a[a.length - 1][1], lon: a[a.length - 1][0] });
      expect(haversineM(car, { lat: flatTip[1], lon: flatTip[0] })).toBeCloseTo(metres(flat), 0);
      // The arc's ends sit at cos(28°) ahead, sin(28°) across: across is the same, ahead doubles.
      expect(width(arc(tilted, 0))).toBeCloseTo(width(arc(flat, 0)), 0);
    });

    test("a turned map turns it with the heading: heading east on an east-up map is heading north on a north-up one", () => {
      const east = arc({ ...flat, bearingDeg: 90 }, Math.PI / 2);
      const north = arc(flat, 0);
      const length = (a: number[][]) => a.map(([lon, lat]) => haversineM(car, { lat, lon }));
      expect(length(east).map((m) => Math.round(m))).toEqual(length(north).map((m) => Math.round(m)));
    });
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
