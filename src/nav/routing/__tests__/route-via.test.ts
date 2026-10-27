import { alongEvery, distanceToLineM, viaNames } from "../route-via";

/** A point `east` and `north` metres from a corner in Kyiv. */
const at = (east: number, north: number) => ({ lat: 50.45 + north / 111_195, lon: 30.52 + east / (111_195 * Math.cos((50.45 * Math.PI) / 180)) });

describe("what sets a route apart", () => {
  test("points every step along a line, round its corners", () => {
    const pts = alongEvery([at(0, 0), at(100, 0), at(100, 100)], 75);
    expect(pts).toHaveLength(3);
    expect(distanceToLineM(pts[2], [at(100, 0), at(100, 100)])).toBeLessThan(0.5);
  });

  test("a point's distance from a line", () => {
    expect(distanceToLineM(at(50, 30), [at(0, 0), at(100, 0)])).toBeCloseTo(30, 0);
    expect(distanceToLineM(at(-40, 0), [at(0, 0), at(100, 0)])).toBeCloseTo(40, 0);
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

  test("no name without a stretch of its own, or without a named house near it", () => {
    const line = [at(0, 0), at(1000, 0)];
    expect(viaNames([line, line], () => "Same Street")).toEqual([null, null]);
    expect(viaNames([line, [at(0, 0), at(0, 900)]], () => null)).toEqual([null, null]);
  });
});
