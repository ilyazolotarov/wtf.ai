import { syntheticDrive, type DriveSegment } from "@/nav/__fixtures__/synthetic-drive";
import { haversineM } from "@/nav/geo";
import { Navigator } from "@/nav/navigator";
import { replayTrip } from "@/nav/replay/replay";

const deg = (r: number) => (r * 180) / Math.PI;
const angleDiffDeg = (a: number, b: number) => Math.abs(deg(Math.atan2(Math.sin(a - b), Math.cos(a - b))));

// ~2.4 km: pull away, straights, left and right turns, a stop, more turns.
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

function endError(drive: ReturnType<typeof syntheticDrive>, result: ReturnType<typeof replayTrip>) {
  const last = result.track.at(-1)!;
  const truth = drive.truthAt(drive.trip.imu.at(-1)!.tUs);
  return { posM: haversineM(last, truth), headingDeg: last.headingRad === undefined ? NaN : angleDiffDeg(last.headingRad, truth.psi), last };
}

describe("Navigator on a synthetic drive", () => {
  test("clean GNSS: initializes from the course, tracks within a few metres, learns the OBD scale", () => {
    const drive = syntheticDrive({ segments: CITY, gnss: "clean", obdScale: 0.985, gyroBiasRadS: 0.0002, startHeadingRad: 1 });
    const result = replayTrip(drive.trip);
    expect(result.summary.init?.method).toBe("course");
    const err = endError(drive, result);
    expect(err.last.mode).toBe("dr");
    expect(err.posM).toBeLessThan(6);
    expect(err.headingDeg).toBeLessThan(2);
    expect(result.summary.fixes.rejected).toBe(0);
    // v = k_s · s_OBD, OBD reads 1.5 % low.
    expect(result.summary.params!.speedScale).toBeCloseTo(1 / 0.985, 2);
  });

  test("GNSS outage: dead reckoning stays close and its uncertainty covers the error", () => {
    const drive = syntheticDrive({ segments: CITY, gnss: "clean", obdScale: 0.985, gyroBiasRadS: 0.0002, startHeadingRad: 1 });
    const result = replayTrip(drive.trip, { cuts: [{ fromS: 70, toS: 160 }] });
    const cut = result.summary.cuts[0];
    expect(cut.distanceM).toBeGreaterThan(800);
    expect(cut.truthFixes).toBeGreaterThan(80);
    expect(cut.maxErrorM!).toBeLessThan(25);
    // The claimed 1σ shouldn't be wildly optimistic.
    expect(cut.maxErrorM!).toBeLessThan(4 * cut.meanSigmaM! + 10);
  });

  test("open loop: every fix after the heading fix (+ delay) is withheld and scored", () => {
    const drive = syntheticDrive({ segments: CITY, gnss: "clean", obdScale: 0.985, gyroBiasRadS: 0.0002, startHeadingRad: 1 });
    const result = replayTrip(drive.trip, { openLoop: { delayS: 20 } });
    const init = result.summary.init!;
    const ol = result.summary.cuts.find((c) => c.openLoop)!;
    expect(ol.fromS).toBeCloseTo(init.tS + 20, 6);
    expect(ol.toS).toBeCloseTo(result.summary.durationS, 6);
    const after = result.fixes.filter((f) => f.tS >= ol.fromS);
    expect(after.every((f) => f.status === "cut")).toBe(true);
    expect(result.fixes.filter((f) => f.tS < ol.fromS && f.tS > init.tS).every((f) => f.status === "accepted")).toBe(true);
    expect(ol.distanceM).toBeGreaterThan(1500);
    expect(ol.maxErrorM!).toBeLessThan(60);
  });

  test("jamming (coarse fixes, no course): heading found by aligning the track to the fixes", () => {
    const drive = syntheticDrive({ segments: CITY, gnss: "coarse", gnssSigmaM: 40, startHeadingRad: 2.5, seed: 7 });
    const result = replayTrip(drive.trip);
    expect(result.summary.init?.method).toBe("alignment");
    const err = endError(drive, result);
    expect(err.last.mode).toBe("dr");
    expect(err.headingDeg).toBeLessThan(10);
    expect(err.posM).toBeLessThan(80);
    expect(err.posM).toBeLessThan(2 * err.last.accuracyM);
  });

  test("a Wi-Fi fix repeated with sub-metre jitter is skipped like an exact repeat", () => {
    const nav = new Navigator();
    const fix = { tUs: 1_000_000, lat: 51.519191, lon: 30.756957, hAccM: 108 };
    expect(nav.onGnss(fix).status).toBe("anchored");
    expect(nav.onGnss({ ...fix, tUs: 5_000_000, lat: 51.519193 }).status).toBe("skipped");
    expect(nav.onGnss({ ...fix, tUs: 9_000_000, lat: 51.5193 }).status).toBe("anchored");
    // Dense-area Wi-Fi claims ±10 m: a metre is a new measurement, not a repeat.
    expect(nav.onGnss({ ...fix, tUs: 13_000_000, lat: 51.51931, hAccM: 10 }).status).toBe("anchored");
  });

  test("before the heading is known the radius grows with the distance driven", () => {
    const drive = syntheticDrive({
      segments: [{ durationS: 3, speedMps: 0, yawRateDegS: 0 }, { durationS: 30, speedMps: 10, yawRateDegS: 0 }],
      gnss: "none",
    });
    drive.trip.gnss = [{ tUs: drive.trip.imu[0].tUs, lat: 51.52, lon: 30.76, hAccM: 30 }];
    const est = replayTrip(drive.trip).track.at(-1)!;
    expect(est.mode).toBe("anchored");
    // 30 m fix (σ 30 for a fix without speed → 45 m radius) plus ~150 m driven.
    expect(est.accuracyM).toBeGreaterThan(180);
    expect(est.lat).toBe(51.52);
  });

  test("standing still: heading holds despite gyro bias, and the bias is learned", () => {
    const drive = syntheticDrive({
      segments: [
        { durationS: 5, speedMps: 0, yawRateDegS: 0 },
        { durationS: 30, speedMps: 14, yawRateDegS: 0 },
        { durationS: 5, speedMps: 0, yawRateDegS: 0 },
        { durationS: 120, speedMps: 0, yawRateDegS: 0 },
      ],
      gnss: "none",
      gyroBiasRadS: 0.002,
    });
    const nav = new Navigator();
    const t0 = drive.trip.imu[0].tUs;
    // One course fix while driving starts the EKF; then GNSS is gone.
    let oi = 0;
    let fed = false;
    for (const s of drive.trip.imu) {
      while (oi < drive.trip.obdSpeed.length && drive.trip.obdSpeed[oi].tUs <= s.tUs) nav.onObdSpeed(drive.trip.obdSpeed[oi++]);
      nav.onImu(s);
      if (!fed && s.tUs - t0 >= 20e6) {
        fed = true;
        const p = drive.truthAt(s.tUs - 0.4e6);
        nav.onGnss({ tUs: s.tUs, lat: p.lat, lon: p.lon, hAccM: 5, speedMps: 14, speedAccMps: 0.3, courseRad: p.psi, courseAccRad: 0.03 });
      }
    }
    const est = nav.estimate()!;
    expect(est.mode).toBe("dr");
    expect(nav.isStandstill).toBe(true);
    // 0.002 rad/s over 2 minutes would be 14° without standstill handling.
    expect(angleDiffDeg(est.headingRad!, 0)).toBeLessThan(1);
    expect(nav.params!.bw).toBeCloseTo(0.002, 3);
  });

  test("handling the phone while parked doesn't lose the heading", () => {
    const drive = syntheticDrive({
      segments: [
        { durationS: 30, speedMps: 14, yawRateDegS: 0 },
        { durationS: 5, speedMps: 0, yawRateDegS: 0 },
        { durationS: 30, speedMps: 0, yawRateDegS: 0 },
        { durationS: 20, speedMps: 12, yawRateDegS: 0 },
      ],
      gnss: "clean",
      handling: { fromS: 40, toS: 55, tiltRad: 0.8, yawRateRadS: 0.5 },
    });
    const result = replayTrip(drive.trip, { cuts: [{ fromS: 38, toS: 200 }] });
    const err = endError(drive, result);
    expect(result.summary.imuInvalidS).toBe(0);
    expect(err.headingDeg).toBeLessThan(2);
    expect(err.posM).toBeLessThan(15);
  });

  test("handling while driving inflates the heading uncertainty instead of turning", () => {
    const drive = syntheticDrive({
      segments: [{ durationS: 30, speedMps: 14, yawRateDegS: 0 }, { durationS: 30, speedMps: 14, yawRateDegS: 0 }],
      gnss: "clean",
      handling: { fromS: 35, toS: 40, tiltRad: 0.8, yawRateRadS: 0.5 },
    });
    const result = replayTrip(drive.trip, { cuts: [{ fromS: 33, toS: 100 }] });
    const before = result.track.find((p) => p.tS >= 33)!;
    const after = result.track.find((p) => p.tS >= 45)!;
    expect(result.summary.imuInvalidS).toBeGreaterThan(4);
    expect(after.headingSigmaRad!).toBeGreaterThan(before.headingSigmaRad! * 3);
    // 0.5 rad/s for 5 s would have turned the heading by 143°.
    expect(angleDiffDeg(after.headingRad!, before.headingRad!)).toBeLessThan(5);
  });
});

describe("buildViewerData", () => {
  test("packs the replay, sensor streams, and cut options for the browser viewer", () => {
    const { buildViewerData } = jest.requireActual<typeof import("@/nav/replay/viewer-data")>("@/nav/replay/viewer-data");
    const drive = syntheticDrive({ segments: CITY.slice(0, 5), gnss: "clean", startHeadingRad: 1 });
    drive.trip.events = [{ tUs: drive.trip.startUs + 2e6, event: "marker" }];
    drive.trip.timeSync = [{ tUs: drive.trip.startUs + 1e6, utcUs: 1_791_000_001_000_000 }];
    const d = buildViewerData("trip.ulg", drive.trip, { cuts: [{ fromS: 30, toS: 40 }] });
    expect(d.startUtcMs).toBe(1_791_000_000_000);
    expect(d.track.length).toBeGreaterThan(5 * d.durationS - 10); // 0.2 s steps from the first fix
    expect(d.track.at(-1)!.mode).toBe("dr");
    expect(d.fixes.filter((f) => f.status === "cut").length).toBeGreaterThanOrEqual(9);
    expect(d.obd.length).toBeLessThanOrEqual(5 * d.durationS + 1);
    expect(d.events).toEqual([{ t: 2, kind: "marker", text: "marker" }]);
    expect(d.options.cuts).toEqual([{ fromS: 30, toS: 40 }]);
    expect(d.options.gnssLagS).toBeNull(); // learned on the drive, as in the app
    // The drive report: the cut is scored on the fixes it withheld; no phone track in a synthetic log.
    expect(d.shown).toHaveLength(d.track.length);
    expect(d.phone).toEqual([]);
    expect(d.compare).toBeNull();
    expect(d.outages).toHaveLength(1);
    expect(d.outages[0]).toMatchObject({ kind: "replay-cut", fromS: 30, toS: 40 });
    expect(d.outages[0].scores.replay!.truthFixes).toBeGreaterThanOrEqual(9);
    expect(d.outages[0].scores.replay!.maxErrorM).toBeLessThan(20);
    expect(d.errors.replay.length).toBeGreaterThan(d.durationS / 2);
    expect(d.noGpsS).toBe(0);
  });

  test("lists the app's Cut GPS windows and scores a compare replay", () => {
    const { buildViewerData } = jest.requireActual<typeof import("@/nav/replay/viewer-data")>("@/nav/replay/viewer-data");
    const drive = syntheticDrive({ segments: CITY.slice(0, 5), gnss: "clean", startHeadingRad: 1 });
    const d = buildViewerData("trip.ulg", drive.trip, {}, { appCuts: [{ fromS: 20, toS: 35 }], compare: { label: "B", options: { cuts: [{ fromS: 20, toS: 35 }] } } });
    expect(d.outages.map((o) => o.kind)).toEqual(["app-cut"]);
    expect(d.compare?.label).toBe("B");
    // The compare replay had the cut, this one GPS: its dot stays on GPS, the other drifts a little.
    const { replay, compare } = d.outages[0].scores;
    expect(compare!.maxErrorM!).toBeGreaterThan(replay!.maxErrorM!);
  });
});

describe("Navigator from a parked pose", () => {
  const DRIVE: DriveSegment[] = [
    { durationS: 10, speedMps: 0, yawRateDegS: 0 },
    { durationS: 10, speedMps: 10, yawRateDegS: 0 },
    { durationS: 9, speedMps: 8, yawRateDegS: 10 },
    { durationS: 40, speedMps: 12, yawRateDegS: 0 },
    { durationS: 5, speedMps: 0, yawRateDegS: 0 },
    { durationS: 5, speedMps: 0, yawRateDegS: 0 },
  ];
  const drive = syntheticDrive({ segments: DRIVE, gnss: "coarse", startHeadingRad: 2, seed: 4 });
  const start = drive.truth[0];
  const pose = { lat: start.lat, lon: start.lon, headingRad: start.psi, posSigmaM: 5, headingSigmaRad: 0.04 };

  test("dead-reckons from the start under jamming; a fix after some driving confirms it", () => {
    const plain = replayTrip(drive.trip).summary;
    const r = replayTrip(drive.trip, { startPose: pose });
    expect(r.summary.init).toMatchObject({ tS: 0, method: "parked pose" });
    expect(r.summary.startPose?.status).toBe("confirmed");
    // Confirmed only after driving: a fix while parked says nothing about the heading.
    expect(r.summary.startPose!.tS).toBeGreaterThan(20);
    expect(plain.init === null || plain.init.tS > 30).toBe(true);
    expect(endError(drive, r).posM).toBeLessThan(20);
  });

  test("ends parked: the pose for the next start", () => {
    const end = replayTrip(drive.trip, { startPose: pose }).summary.endPose!;
    const truth = drive.truth.at(-1)!;
    expect(haversineM(end, truth)).toBeLessThan(20);
    expect(angleDiffDeg(end.headingRad, truth.psi)).toBeLessThan(5);
  });

  test("no pose while moving", () => {
    const moving = syntheticDrive({ segments: DRIVE.slice(0, 4), gnss: "clean", seed: 4 });
    expect(replayTrip(moving.trip).summary.endPose).toBeNull();
  });

  test("a fix far from the pose drops it: back to a normal start", () => {
    const r = replayTrip(drive.trip, { startPose: { ...pose, lat: pose.lat + 0.005 } });
    expect(r.summary.startPose).toMatchObject({ status: "rejected" });
    expect(r.summary.startPose!.tS).toBeLessThan(5);
    expect(r.track.find((t) => t.tS > r.summary.startPose!.tS)?.mode).toBe("anchored");
  });

  test("a heading turned around is dropped once the car drives", () => {
    const r = replayTrip(drive.trip, { startPose: { ...pose, headingRad: pose.headingRad + Math.PI } });
    expect(r.summary.startPose?.status).toBe("rejected");
  });

  test("the phone handled while parked, then carried off: the pose stays where the car is", () => {
    const parked = syntheticDrive({
      segments: [
        { durationS: 30, speedMps: 12, yawRateDegS: 0 },
        { durationS: 5, speedMps: 0, yawRateDegS: 0 },
        { durationS: 60, speedMps: 0, yawRateDegS: 0 },
      ],
      gnss: "clean",
      handling: { fromS: 45, toS: 95, tiltRad: 0.8, yawRateRadS: 0.5 },
    });
    // The driver walks north with the phone at 1.5 m/s: 75 m by the end.
    const walkUs = parked.trip.startUs + 45e6;
    parked.trip.gnss = parked.trip.gnss.map((f) =>
      f.tUs < walkUs ? f : { ...f, lat: f.lat + (1.5 * (f.tUs - walkUs)) / 1e6 / 111_320, speedMps: 1.5, courseRad: 0 },
    );
    const end = replayTrip(parked.trip).summary.endPose!;
    expect(haversineM(end, parked.truth.at(-1)!)).toBeLessThan(10);
  });

  test("refused when the fixes so far disagree", () => {
    const nav = new Navigator();
    nav.onGnss({ tUs: 1, lat: pose.lat + 0.01, lon: pose.lon, hAccM: 20 });
    expect(nav.startFromPose(pose)).toBe(false);
    expect(nav.mode).toBe("anchored");
  });
});
