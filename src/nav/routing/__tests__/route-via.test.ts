import { alongEvery, viaNames } from "../route-via";

/** A point `east` and `north` metres from a corner in Kyiv. */
const at = (east: number, north: number) => ({ lat: 50.45 + north / 111_195, lon: 30.52 + east / (111_195 * Math.cos((50.45 * Math.PI) / 180)) });

describe("what sets a route apart", () => {
  test("points every step along a line, round its corners", () => {
    const pts = alongEvery([at(0, 0), at(100, 0), at(100, 100)], 75);
    expect(pts).toHaveLength(3);
    expect(pts[2].lat).toBeCloseTo(at(100, 50).lat, 6);
    expect(pts[2].lon).toBeCloseTo(at(100, 50).lon, 6);
  });

  test("each route is named by the street of its own stretch, not the one they share", () => {
    // Both start along a shared street (north 0), then part: one north-east, one along a street 300 m south.
    const shared = [at(0, 0), at(400, 0)];
    const route = [...shared, at(400, 400), at(1200, 400)];
    const other = [...shared, at(400, -300), at(1200, -300), at(1200, 400)];
    const nameAt = (p: { lat: number }) => {
      const north = (p.lat - 50.45) * 111_195;
      if (Math.abs(north) < 20) return "Shared Street";
      if (north > 380) return "North Avenue";
      if (north < -280) return "South Embankment";
      return null;
    };
    expect(viaNames([route, other], nameAt)).toEqual(["North Avenue", "South Embankment"]);
  });

  test("a stretch within 40 m of another route is shared, beyond it the route's own", () => {
    const line = [at(0, 0), at(1000, 0)];
    const named = (p: { lat: number }) => ((p.lat - 50.45) * 111_195 > 1 ? "Parallel Street" : "Main Street");
    expect(viaNames([[at(0, 35), at(1000, 35)], line], named)).toEqual([null, null]);
    expect(viaNames([[at(0, 45), at(1000, 45)], line], named)).toEqual(["Parallel Street", "Main Street"]);
    // A route of one point (the car at the destination) is a point.
    expect(viaNames([[at(500, 0)], line], named)).toEqual([null, "Main Street"]);
  });

  test("no name without a stretch of its own, or without a named house near it", () => {
    const line = [at(0, 0), at(1000, 0)];
    expect(viaNames([line, line], () => "Same Street")).toEqual([null, null]);
    expect(viaNames([line, [at(0, 0), at(0, 900)]], () => null)).toEqual([null, null]);
  });

  test("200 km routes with a vertex every 20 m are told apart in well under a second (each point against every vertex froze the phone 20 s)", () => {
    const route = (phase: number) =>
      Array.from({ length: 10_001 }, (_, i) => {
        const f = i / 10_000;
        return { lat: 51.52 - f * 1.15 + Math.sin(f * 20 + phase) * 0.01, lon: 30.76 - f * 0.3 + Math.cos(f * 13 + phase) * 0.01 };
      });
    const routes = [route(0), route(0.5), route(1)];
    const start = performance.now();
    expect(viaNames(routes, (p) => (p.lat > 51 ? "North" : "South"))).toEqual(["North", "South", "South"]);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
