import { haversineM } from "../../geo";
import { DRIVE_CRUISE_MPS, RouteDrive } from "../route-drive";

/** A point `east` and `north` metres from a corner in Kyiv. */
const at = (east: number, north: number) => ({ lat: 50.45 + north / 111_195, lon: 30.52 + east / (111_195 * Math.cos((50.45 * Math.PI) / 180)) });

/** Steps of `dtS` until it arrives (or `maxS`); each point. */
function drive(d: RouteDrive, dtS = 0.25, maxS = 600) {
  const points = [d.point()];
  for (let t = 0; t < maxS && !points[points.length - 1].arrived; t += dtS) points.push(d.step(dtS));
  return points;
}

describe("the car's test drive along a route", () => {
  test("starts standing, keeps to the line, gets to the end and stops there", () => {
    const line = [at(0, 0), at(600, 0), at(600, 400)];
    const points = drive(new RouteDrive(line));
    expect(points[0].speedMps).toBe(0);
    const end = points[points.length - 1];
    expect(end.arrived).toBe(true);
    expect(end.speedMps).toBe(0);
    expect(haversineM(end, line[2])).toBeLessThan(0.5);
    // Never off the line: each point is on one of its two legs.
    for (const p of points) expect(Math.min(Math.abs(haversineM(p, { lat: line[0].lat, lon: p.lon })), haversineM(p, { lat: p.lat, lon: line[2].lon }))).toBeLessThan(0.5);
  });

  test("a town's speed on the straight, slow through a right-angle turn", () => {
    const line = [at(0, 0), at(800, 0), at(800, 800)];
    const points = drive(new RouteDrive(line));
    const near = (e: number, n: number) => points.reduce((a, b) => (haversineM(b, at(e, n)) < haversineM(a, at(e, n)) ? b : a));
    expect(near(400, 0).speedMps).toBeCloseTo(DRIVE_CRUISE_MPS, 1);
    expect(near(800, 0).speedMps).toBeLessThan(5.5);
    expect(near(800, 0).speedMps).toBeGreaterThan(2);
    // Heading east before the turn, north after it.
    expect(near(400, 0).headingRad).toBeCloseTo(Math.PI / 2, 2);
    expect(near(800, 400).headingRad).toBeCloseTo(0, 2);
  });

  test("a turn drawn as many short segments slows it as one does", () => {
    // A right angle as a quarter circle of 12 m radius, a point every 5°.
    const arc = Array.from({ length: 19 }, (_, k) => {
      const a = (k * 5 * Math.PI) / 180;
      return at(800 + 12 * Math.sin(a), 12 - 12 * Math.cos(a));
    });
    const line = [at(0, 0), ...arc, at(812, 800)];
    const slowest = Math.min(...drive(new RouteDrive(line)).slice(10, -40).map((p) => p.speedMps));
    expect(slowest).toBeLessThanOrEqual(7);
  });

  test("carries on from where it is onto a new line, at its speed", () => {
    const first = new RouteDrive([at(0, 0), at(1000, 0)]);
    for (let i = 0; i < 120; i++) first.step(0.25);
    const was = first.point();
    const next = new RouteDrive([at(0, 0), at(1000, 0), at(1000, 500)], was, was.speedMps);
    expect(haversineM(next.point(), was)).toBeLessThan(0.5);
    expect(next.point().speedMps).toBeCloseTo(was.speedMps, 5);
  });

  test("a route of one point is there already", () => {
    const d = new RouteDrive([at(0, 0)]);
    expect(d.step(1).arrived).toBe(true);
  });
});
