import { syntheticDrive, type DriveSegment } from "@/nav/__fixtures__/synthetic-drive";
import { OdometryChunker, type OdometryIncrement, type OdometryStep } from "@/nav/odometry/odometry-output";
import { replayTrip } from "@/nav/replay/replay";

const deg = (r: number) => (r * 180) / Math.PI;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

describe("OdometryChunker", () => {
  const cal = { speedScaleRelSigma: 0.01, gyroBiasSigma: 0.001, gyroScaleSigma: 0.02 };
  const inc = (tUs: number, over: Partial<OdometryIncrement> = {}): OdometryIncrement => ({
    tUs, dtS: 0.01, dsM: 0.1, dpsiRad: 0.001, dpsiWhiteVar: 1e-7, stopped: false, yawUnknown: false, speedUnknown: false, source: "ekf", ...over,
  });

  test("closes a chunk at 2 m or 0.2 s, and keeps cumulative totals", () => {
    const steps: OdometryStep[] = [];
    const c = new OdometryChunker();
    for (let k = 1; k <= 40; k++) steps.push(...c.add(inc(k * 10_000, { dsM: 0.15 }), cal)); // 2 m every 14 steps
    for (let k = 41; k <= 80; k++) steps.push(...c.add(inc(k * 10_000, { dsM: 0, dpsiRad: 0, stopped: true }), cal)); // 0.2 s every 20
    const last = c.flush();
    if (last) steps.push(last);
    expect(steps.map((s) => s.dsM.toFixed(2))).toEqual(["2.10", "2.10", "1.80", "0.00", "0.00"]);
    // The third chunk (12 moving steps) runs on into the stopped ones until 0.2 s.
    expect(steps[2]).toMatchObject({ stopped: false, t0Us: 280_000, t1Us: 480_000 });
    expect(steps[3]).toMatchObject({ stopped: true, t0Us: 480_000, t1Us: 680_000 });
    expect(steps.at(-1)!.distanceM).toBeCloseTo(6, 9);
    expect(steps.at(-1)!.turnRad).toBeCloseTo(0.04, 9);
  });

  test("a source change closes the chunk; flags combine; variances", () => {
    const steps: OdometryStep[] = [];
    const c = new OdometryChunker();
    steps.push(...c.add(inc(10_000, { source: "relative", yawUnknown: true }), cal));
    steps.push(...c.add(inc(20_000, { source: "relative", speedUnknown: true }), cal));
    steps.push(...c.add(inc(30_000), cal));
    const last = c.flush();
    if (last) steps.push(last);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ source: "relative", yawUnknown: true, speedUnknown: true });
    expect(steps[1]).toMatchObject({ source: "ekf", yawUnknown: false, speedUnknown: false });
    const s = steps[0];
    expect(s.dsVar).toBeCloseTo((0.01 * 0.2) ** 2 + (0.1 * 0.02) ** 2, 12);
    expect(s.dpsiVar).toBeCloseTo(2e-7 + (0.001 * 0.02) ** 2 + (0.02 * 0.002) ** 2, 14);
  });
});

// ~2.4 km: pull away, straights, left and right turns, a stop, more turns (as navigator.test.ts).
const CITY: DriveSegment[] = [
  { durationS: 5, speedMps: 0, yawRateDegS: 0 },
  { durationS: 10, speedMps: 12, yawRateDegS: 0 },
  { durationS: 20, speedMps: 14, yawRateDegS: 0 },
  { durationS: 9, speedMps: 9, yawRateDegS: 10 },
  { durationS: 25, speedMps: 15, yawRateDegS: 0 },
  { durationS: 10, speedMps: 0, yawRateDegS: 0 },
  { durationS: 8, speedMps: 0, yawRateDegS: 0 },
  { durationS: 10, speedMps: 11, yawRateDegS: 0 },
  { durationS: 9, speedMps: 9, yawRateDegS: -10 },
  { durationS: 40, speedMps: 16, yawRateDegS: 0 },
  { durationS: 12, speedMps: 10, yawRateDegS: 7.5 },
  { durationS: 30, speedMps: 14, yawRateDegS: 0 },
];

describe("Navigator odometry on a synthetic drive", () => {
  const drive = syntheticDrive({ segments: CITY, gnss: "clean", obdScale: 0.985, gyroBiasRadS: 0.0002, startHeadingRad: 1 });
  const steps: OdometryStep[] = [];
  // A track point after every input event, so every chunk boundary has one.
  const result = replayTrip(drive.trip, { odometry: (s) => steps.push(s), cuts: [{ fromS: 70, toS: 160 }], trackStepS: 0 });

  test("relative before the heading is known, EKF after; chunks of ≤ 2 m / 0.2 s", () => {
    const initUs = drive.trip.startUs + result.summary.init!.tS * 1e6;
    expect(steps[0].source).toBe("relative");
    expect(steps.filter((s) => s.t1Us > initUs + 50_000).every((s) => s.source === "ekf")).toBe(true);
    // One 100 Hz step past the limit at most.
    expect(Math.max(...steps.map((s) => s.dsM))).toBeLessThan(2.2);
    expect(Math.max(...steps.map((s) => (s.t1Us - s.t0Us) / 1e6))).toBeLessThan(0.22);
    for (let k = 1; k < steps.length; k++) expect(steps[k].t0Us).toBeCloseTo(steps[k - 1].t1Us, -1);
  });

  test("sums to the true distance and heading change, up to the gyro bias not yet learned", () => {
    const truth = drive.truth;
    let distance = 0;
    for (let k = 1; k < truth.length; k++) distance += truth[k].speedMps * (truth[k].tUs - truth[k - 1].tUs) / 1e6;
    const turn = -CITY.reduce((s, g) => s + (g.yawRateDegS * Math.PI) / 180 * g.durationS, 0);
    const last = steps.at(-1)!;
    expect(last.distanceM / distance).toBeCloseTo(1, 2); // learned k_s; ~1.5 % low before init
    // The synthetic gyro bias (0.0115 °/s) is only partly learned at the short stops (prior σ
    // 0.03 °/s), so the turn sum drifts by at most bias × driving time.
    const unlearned = 0.0002 * result.summary.durationS;
    expect(Math.abs(last.turnRad - turn)).toBeLessThan(unlearned);
    expect(Math.abs(deg(last.turnRad - turn))).toBeGreaterThan(0.5); // …and the test would notice a sign error
  });

  test("stops are stopped chunks with no turn and no real distance", () => {
    // Speed reaches 0 at 79 s; standstill is detected 2 s later; it pulls away at 87 s.
    const stopUs = drive.trip.startUs + 81.5e6;
    const atStop = steps.filter((s) => s.t0Us >= stopUs && s.t1Us <= stopUs + 5e6);
    expect(atStop.length).toBeGreaterThan(20);
    // The EKF speed after zero-velocity updates is ~1e-5 m/s, not exactly 0.
    expect(atStop.every((s) => s.stopped && s.dsM < 1e-3 && s.dpsiRad === 0)).toBe(true);
  });

  test("during a GNSS cut the chunks are the EKF's own motion", () => {
    // No fix updates between 100 s and 150 s: the EKF heading and position move only by prediction
    // (OBD speed updates shift them by a hair through the cross-covariance).
    // Track points on chunk boundaries (a chunk cuts a 10 °/s turn every 0.2 s).
    const ends = new Set(steps.map((s) => s.t1Us));
    const onBoundary = result.track.filter((p) => ends.has(p.tUs) && p.tS >= 95 && p.tS <= 150);
    const a = onBoundary[0];
    const b = onBoundary.at(-1)!;
    expect(a.tS).toBeLessThan(97); // spans the right turn at 97–106 s
    expect(b.tS).toBeGreaterThan(106);
    const inWindow = steps.filter((s) => s.t0Us >= a.tUs && s.t1Us <= b.tUs);
    const dpsi = inWindow.reduce((sum, s) => sum + s.dpsiRad, 0);
    expect(Math.abs(deg(wrap(dpsi - (b.headingRad! - a.headingRad!))))).toBeLessThan(0.05);
    const ds = inWindow.reduce((sum, s) => sum + s.dsM, 0);
    const track = result.track.filter((p) => p.tUs >= a.tUs && p.tUs <= b.tUs);
    let path = 0;
    for (let k = 1; k < track.length; k++) {
      const dLat = (track[k].lat - track[k - 1].lat) * 111_195;
      const dLon = (track[k].lon - track[k - 1].lon) * 111_195 * Math.cos((track[k].lat * Math.PI) / 180);
      path += Math.hypot(dLat, dLon);
    }
    expect(ds / path).toBeCloseTo(1, 2);
  });
});
