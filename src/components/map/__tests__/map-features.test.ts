import { destinationAtBearing, haversineM } from "@/nav/geo";
import { carFeatures, carImage, carScale, dotOnCar, fitCircleZoom, hypothesisFeatures, metresPerPoint, pointFeatures, routeFeatures, screenSectorFeatures, sectorFeatures } from "@/components/map/map-features";

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

  describe("a wide circle fits the screen", () => {
    test("a small one keeps the camera's zoom", () => {
      expect(fitCircleZoom(car.lat, 30, 140, 17)).toBe(17);
    });

    test("a cell fix's kilometres zoom out until the radius fits, in half steps", () => {
      const zoom = fitCircleZoom(car.lat, 2000, 140, 17);
      expect(zoom).toBeLessThan(17);
      expect(zoom * 2).toBe(Math.round(zoom * 2));
      expect(2000 / metresPerPoint(car.lat, zoom)).toBeLessThanOrEqual(140);
      // Half a step closer would not fit.
      expect(2000 / metresPerPoint(car.lat, zoom + 0.5)).toBeGreaterThan(140);
    });

    test("never further out than the floor", () => {
      expect(fitCircleZoom(car.lat, 500_000, 140, 17)).toBe(9);
    });
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

  test("the parked car: a point with its heading, its image's size and the reach of its outline", () => {
    const [f] = carFeatures(car, Math.PI / 2, 17, 3).features;
    expect(f.geometry.coordinates).toEqual([car.lon, car.lat]);
    // At zoom 17 the image's own size (drawn at 2), its outline 14 pt along from the middle and the edge past it.
    expect(f.properties).toMatchObject({ deg: 90, image: "", size: 1 });
    // Twice as large at 19: on a 3x screen the 6-pixel image, a sixth of its own size twice over.
    expect(carFeatures(car, 0, 19, 3).features[0].properties).toMatchObject({ image: "-x6" });
    expect(carFeatures(car, 0, 19, 3).features[0].properties?.size).toBeCloseTo(1 / 3, 6);
  });

  test("the car's image: its own until the screen would stretch it, then the least dense near image that is enough", () => {
    expect(carImage(1.1, 3)).toEqual({ suffix: "", size: 1.1 });
    expect(carImage(2, 3)).toEqual({ suffix: "-x6", size: 2 / 6 });
    expect(carImage(3, 3)).toEqual({ suffix: "-x12", size: 3 / 12 });
    expect(carImage(3, 2)).toEqual({ suffix: "-x6", size: 3 / 6 });
    // Past the densest, the densest stretched.
    expect(carImage(8, 3)).toEqual({ suffix: "-x12", size: 8 / 12 });
  });

  test("the car grows as the map is zoomed in: twice as large every two zoom levels, never smaller than the lessons'", () => {
    expect(carScale(car.lat, 17)).toBe(2);
    expect(carScale(car.lat, 19)).toBeCloseTo(4, 6);
    expect(carScale(car.lat, 15)).toBeCloseTo(1, 6);
    expect(carScale(car.lat, 12)).toBe(1);
    // Never shorter than a real car: far in, the map's own growth takes over.
    const zoom = 22;
    expect(28 * carScale(car.lat, zoom) * metresPerPoint(car.lat, zoom)).toBeGreaterThanOrEqual(5 - 1e-9);
  });

  describe("the dot on the car", () => {
    const parked = { ...car, headingRad: 0 };
    const zoom = 17;
    const mpp = metresPerPoint(car.lat, zoom);
    /** A dot `pt` points east of the car's side (its outline 14.3 pt from its centre that way: 6.5 + 0.65 pt, drawn at 2). */
    const beside = (pt: number, speedMps = 0) => ({ ...destinationAtBearing(car, Math.PI / 2, (14.3 + pt) * mpp), speedMps });

    test("standing on it, or touching it, the dot gives way", () => {
      expect(dotOnCar({ ...car, speedMps: 0 }, parked, zoom, 1, false)).toBe(true);
      expect(dotOnCar(beside(12), parked, zoom, 1, false)).toBe(true);
      expect(dotOnCar(beside(16), parked, zoom, 1, false)).toBe(false);
    });

    test("once hidden, it shows again only clear of the car, so it doesn't flicker at the edge", () => {
      expect(dotOnCar(beside(18), parked, zoom, 1, true)).toBe(true);
      expect(dotOnCar(beside(24), parked, zoom, 1, true)).toBe(false);
    });

    test("driving, never", () => {
      expect(dotOnCar({ ...car, speedMps: 3 }, parked, zoom, 1, true)).toBe(false);
    });
  });
});
