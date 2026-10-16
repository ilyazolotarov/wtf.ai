import type { DrawnTruthTrack } from "../drawn-truth";
import { findIncidents, INCIDENT_STEP_S, type DotSample } from "../incidents";

// 200 m north, a right turn, 200 m east, at 10 m/s.
const LAT0 = 50.45;
const LON0 = 30.52;
const M_LAT = 1 / 111_195;
const M_LON = 1 / (111_195 * Math.cos((LAT0 * Math.PI) / 180));
const at = (s: number): [number, number] => (s <= 200 ? [LAT0 + s * M_LAT, LON0] : [LAT0 + 200 * M_LAT, LON0 + (s - 200) * M_LON]);
const headingAt = (s: number) => (s < 200 ? 0 : Math.PI / 2);

function truth(): DrawnTruthTrack {
  const path: [number, number][] = [];
  const cum: number[] = [];
  for (let s = 0; s <= 400; s += 5) {
    path.push(at(s));
    cum.push(s);
  }
  const points: DrawnTruthTrack["points"] = [];
  for (let t = 0; t <= 40 + 1e-9; t += INCIDENT_STEP_S) {
    const s = Math.min(400, t * 10);
    points.push([t, ...at(s), s, 0]);
  }
  return { path, cum, points, pathM: 400, odometerM: 400, anchors: 0, doubtM: 0 };
}

/** The dot exactly on the car, 10 Hz, its arrow along the road. */
function exact(): DotSample[] {
  const dots: DotSample[] = [];
  for (let t = 0; t <= 40; t += 0.1) {
    const s = Math.min(400, t * 10);
    const [lat, lon] = at(s);
    dots.push({ t, lat, lon, headingRad: headingAt(s) });
  }
  return dots;
}

describe("findIncidents", () => {
  it("finds nothing on a dot that is where the car is", () => {
    const r = findIncidents(truth(), exact());
    expect(r.incidents).toEqual([]);
    expect(r.coverage.movingS).toBeGreaterThan(35);
    expect(r.coverage.errorMaxM).toBeLessThan(2);
  });

  it("lets a dot lag a little through the turn", () => {
    // 8 m behind the car, its arrow the way its own stretch goes.
    const dots = exact().map((d) => {
      const s = Math.max(0, Math.min(400, d.t * 10) - 8);
      const [lat, lon] = at(s);
      return { t: d.t, lat, lon, headingRad: headingAt(s) };
    });
    expect(findIncidents(truth(), dots).incidents.filter((i) => i.major)).toEqual([]);
  });

  it("catches the arrow flipping against the car after a turn", () => {
    // After the turn the dot runs back west along the new road for 1.5 s, the wrong way (the T-junction flip).
    const dots = exact().map((d) => {
      if (d.t < 21 || d.t > 22.5) return d;
      const back = (d.t - 21) * 10;
      return { t: d.t, lat: LAT0 + 200 * M_LAT, lon: LON0 - back * M_LON, headingRad: (3 * Math.PI) / 2 };
    });
    const ww = findIncidents(truth(), dots).incidents.filter((i) => i.kind === "wrong-way");
    expect(ww).toHaveLength(1);
    expect(ww[0].major).toBe(true);
    expect(ww[0].worst).toBeGreaterThan(170);
    expect(ww[0].fromS).toBeGreaterThanOrEqual(20.8);
    expect(ww[0].toS).toBeLessThanOrEqual(23);
  });

  it("catches a dot on a parallel road", () => {
    // 50 m west of the northbound road for 6 s.
    const dots = exact().map((d) => (d.t >= 5 && d.t < 11 ? { ...d, lon: d.lon - 50 * M_LON } : d));
    const wr = findIncidents(truth(), dots).incidents.filter((i) => i.kind === "wrong-road");
    expect(wr).toHaveLength(1);
    expect(wr[0].major).toBe(true);
  });

  it("keeps a dot on its own pass where the route comes back beside itself", () => {
    // North 150 m, 6 m east, south 150 m: the way back runs 6 m from the way out.
    const leg = (s: number): [number, number] =>
      s <= 150 ? [LAT0 + s * M_LAT, LON0] : s <= 156 ? [LAT0 + 150 * M_LAT, LON0 + (s - 150) * M_LON] : [LAT0 + (306 - s) * M_LAT, LON0 + 6 * M_LON];
    const path: [number, number][] = [];
    const cum: number[] = [];
    for (let s = 0; s <= 306; s += 3) {
      path.push(leg(s));
      cum.push(s);
    }
    const points: DrawnTruthTrack["points"] = [];
    const dots: DotSample[] = [];
    for (let t = 0; t <= 30 + 1e-9; t += INCIDENT_STEP_S) {
      const s = Math.min(306, t * 10);
      points.push([t, ...leg(s), s, 0]);
      const [lat, lon] = leg(s);
      dots.push({ t, lat, lon, headingRad: s < 150 ? 0 : s <= 156 ? Math.PI / 2 : Math.PI });
    }
    const r = findIncidents({ path, cum, points, pathM: 306, odometerM: 306, anchors: 0, doubtM: 0 }, dots);
    expect(r.incidents.filter((i) => i.major)).toEqual([]);
  });

  it("does not pass a drive with no dots for clean", () => {
    const r = findIncidents(truth(), []);
    expect(r.incidents).toEqual([]);
    expect(r.coverage.movingS).toBe(0);
  });
});

describe("findIncidents: what it can't judge, and a lost stretch", () => {
  it("doesn't judge a drawing the odometer can't time", () => {
    const t = { ...truth(), odometerM: 50, doubtM: 10 };
    expect(findIncidents(t, exact()).unjudged).toMatch(/odometer/);
  });

  it("counts a dot lost for long, back near the car for a few seconds, as one loss", () => {
    // 300 m off from 5 s to 40 s, but on the car for 10 s in the middle.
    const dots = exact().map((d) => (d.t >= 5 && (d.t < 18 || d.t >= 28) ? { ...d, lon: d.lon + 300 * M_LON } : d));
    const lost = findIncidents(truth(), dots).incidents.filter((i) => i.kind === "lost");
    expect(lost).toHaveLength(1);
  });
});

describe("findIncidents: a drawing clean GPS disagrees with", () => {
  it("doesn't judge the dot where a clean fix is far from the drawing, and says where", () => {
    // From 10 s to 15 s the car (and the dot, and clean GPS) were 80 m west of the drawn road.
    const off = (d: DotSample) => (d.t >= 10 && d.t < 15 ? { ...d, lon: d.lon - 80 * M_LON } : d);
    const dots = exact().map(off);
    const fixes = Array.from({ length: 41 }, (_, t) => ({ ...off({ t, lat: at(t * 10)[0], lon: at(t * 10)[1] }), hAccM: 5 }));
    const r = findIncidents(truth(), dots, fixes);
    expect(r.incidents.filter((i) => i.kind === "wrong-road")).toEqual([]);
    expect(r.coverage.disputed.length).toBe(1);
    expect(r.coverage.disputed[0][0]).toBeGreaterThanOrEqual(9);
    expect(r.coverage.disputed[0][1]).toBeLessThanOrEqual(16.5);
  });

  it("a coarse fix there disputes nothing", () => {
    const off = (d: DotSample) => (d.t >= 10 && d.t < 15 ? { ...d, lon: d.lon - 80 * M_LON } : d);
    const fixes = Array.from({ length: 41 }, (_, t) => ({ ...off({ t, lat: at(t * 10)[0], lon: at(t * 10)[1] }), hAccM: 65 }));
    const r = findIncidents(truth(), exact().map(off), fixes);
    expect(r.coverage.disputed).toEqual([]);
    expect(r.incidents.some((i) => i.kind === "wrong-road")).toBe(true);
  });

  it("judges a dot across a hairpin by how far it is from the car, not round the path", () => {
    // 200 m north, round a hairpin, 200 m back south 25 m to the east; at 10 m/s.
    const hairpin = (s: number): [number, number] => (s <= 200 ? [LAT0 + s * M_LAT, LON0] : [LAT0 + (400 - s) * M_LAT, LON0 + 25 * M_LON]);
    const path: [number, number][] = [];
    const cum: number[] = [];
    for (let s = 0; s <= 400; s += 5) {
      path.push(hairpin(s));
      cum.push(s);
    }
    const points: DrawnTruthTrack["points"] = [];
    for (let t = 0; t <= 40 + 1e-9; t += INCIDENT_STEP_S) points.push([t, ...hairpin(Math.min(400, t * 10)), Math.min(400, t * 10), 0]);
    const track: DrawnTruthTrack = { path, cum, points, pathM: 400, odometerM: 400, anchors: 0, doubtM: 0 };
    // From 28 s the dot is level with the car on the way up, 25 m across: 200 m round the path, 25 m away.
    const dots: DotSample[] = [];
    for (let t = 0; t <= 40; t += 0.1) {
      const s = Math.min(400, t * 10);
      dots.push({ t, lat: hairpin(t >= 28 && t < 33 ? 400 - s : s)[0], lon: hairpin(t >= 28 && t < 33 ? 400 - s : s)[1] });
    }
    // (It jumps there and back, and drives the other way: those it is judged for.)
    expect(findIncidents(track, dots).incidents.map((i) => i.kind)).not.toContain("far");
  });
});
