import { readFileSync } from "node:fs";
import path from "node:path";

import { syntheticCompassCalibration, syntheticDrive, type DriveSegment } from "@/nav/__fixtures__/synthetic-drive";
import { LocalFrame } from "@/nav/geo/local-frame";
import { bufferByteSource } from "@/nav/mapmatch/graph/byte-source";
import { TiledRoadGraph } from "@/nav/mapmatch/graph/road-graph";
import { replayTrip } from "@/nav/replay/replay";
import { rotateCalibration } from "@/nav/compass/compass";
import { ParticleFilter } from "@/nav/mapmatch/particle-filter";
import { Navigator } from "@/nav/navigator";
import { puckHypothesis } from "@/nav/position/puck";

// The fixture's long road (tools/tiles tests/test_graph.py): 60 —160— 61 —161— 63 due east at
// LAT0 + 0.01, with the one-way 162 running north from 61 (1.73 km east of 60).
const FIXTURE = readFileSync(path.join(__dirname, "../__fixtures__/net.graph.bin"));
const ORIGIN = { lat: 51.53, lon: 30.75 };
const graph = () => new TiledRoadGraph(bufferByteSource(new Uint8Array(FIXTURE)), new LocalFrame(ORIGIN));
const wayOf = (g: TiledRoadGraph, edge: number | null) => (edge === null ? null : g.edge(edge).wayId);

// Node 61 is 1732 m east of 60. A 20 °/s turn at 5 m/s has a 14 m radius (a real junction turn;
// a wider arc is much shorter than the road via the node), so it starts 14 m before the junction
// and ends on 162 (or, turning right, in open country).
function junctionDrive(turnDegS: number, exitMps = 10): DriveSegment[] {
  return [
    { durationS: 3, speedMps: 0, yawRateDegS: 0 },
    { durationS: 10, speedMps: 12, yawRateDegS: 0 }, // 60 m
    { durationS: 133.9, speedMps: 12, yawRateDegS: 0 }, // 1607 m
    { durationS: 6, speedMps: 5, yawRateDegS: 0 }, // 51 m
    { durationS: 4.5, speedMps: 5, yawRateDegS: turnDegS }, // quarter circle
    { durationS: 200 / exitMps, speedMps: exitMps, yawRateDegS: 0 }, // 200 m
  ];
}

describe("ParticleFilter in the navigator (synthetic drives on the fixture graph)", () => {
  // CAN knows reverse gear (SPEC §2.1 Stage 2): the speed is negative, and the car moves backwards on the map. OBD's
  // speed is unsigned (the main test car reads 0 in reverse): the car stays where it stopped.
  test("reversing with CAN speed: the matched car goes back along the road, still facing the way it did", () => {
    const g = graph();
    const segments: DriveSegment[] = [
      { durationS: 3, speedMps: 0, yawRateDegS: 0 },
      { durationS: 10, speedMps: 12, yawRateDegS: 0 }, // 60 m
      { durationS: 80, speedMps: 12, yawRateDegS: 0 }, // 960 m
      { durationS: 5, speedMps: 0, yawRateDegS: 0 }, // 30 m, stops
      { durationS: 3, speedMps: 0, yawRateDegS: 0 },
      { durationS: 2, speedMps: -3, yawRateDegS: 0 }, // 3 m back
      { durationS: 10, speedMps: -3, yawRateDegS: 0 }, // 30 m back
      { durationS: 2, speedMps: 0, yawRateDegS: 0 }, // 3 m back
      { durationS: 3, speedMps: 0, yawRateDegS: 0 },
    ];
    const drive = syntheticDrive({ segments, origin: ORIGIN, startHeadingRad: Math.PI / 2, gnss: "clean", obdScale: 1 });
    // GNSS gone from the stop: only odometry and the map follow the reversing.
    const cuts = [{ fromS: 95, toS: 1e9 }];
    const can = { ...drive.trip, obdSpeed: drive.trip.obdSpeed.map((o) => ({ ...o, rawKph: Math.abs(o.rawKph), source: "can" as const })) };
    const obd = { ...drive.trip, obdSpeed: drive.trip.obdSpeed.map((o) => ({ ...o, speedMps: Math.max(0, o.speedMps), rawKph: Math.max(0, o.rawKph) })) };
    const truth = drive.truthAt(drive.trip.imu.at(-1)!.tUs);
    const errorM = (trip: typeof drive.trip) => {
      const top = replayTrip(trip, { mapMatch: { graph: g }, cuts }).track.at(-1)!.mapMatch!.clusters[0];
      const dN = (top.lat - truth.lat) * 111_195;
      const dE = (top.lon - truth.lon) * 111_195 * Math.cos((truth.lat * Math.PI) / 180);
      return { m: Math.hypot(dE, dN), way: wayOf(g, top.edge) };
    };
    const withCan = errorM(can);
    expect(withCan.way).toBe(160);
    expect(withCan.m).toBeLessThan(8);
    // The same drive on OBD speed: the car stays where it stopped, the 36 m back missed.
    expect(errorM(obd).m).toBeGreaterThan(25);
  });

  test("without GNSS it follows the turn onto the branch the car took", () => {
    const g = graph();
    const drive = syntheticDrive({ segments: junctionDrive(20), origin: ORIGIN, startHeadingRad: Math.PI / 2, gnss: "clean", obdScale: 0.99 });
    // GNSS gone from 100 s: the turn at ~153 s has only odometry and the map.
    const result = replayTrip(drive.trip, { mapMatch: { graph: g }, cuts: [{ fromS: 100, toS: 1e9 }] });
    const before = result.track.find((p) => p.tS >= 140)!.mapMatch!;
    expect(wayOf(g, before.clusters[0].edge)).toBe(160);
    const end = result.track.at(-1)!.mapMatch!;
    expect(end.state).not.toBe("off");
    expect(wayOf(g, end.clusters[0].edge)).toBe(162);
    expect(end.clusters[0].weight).toBeGreaterThan(0.8);
    // On 162, the filter's position is close to the truth.
    const truth = drive.truthAt(drive.trip.imu.at(-1)!.tUs);
    const top = end.clusters[0];
    const dN = (top.lat - truth.lat) * 111_195;
    const dE = (top.lon - truth.lon) * 111_195 * Math.cos((truth.lat * Math.PI) / 180);
    expect(Math.hypot(dE, dN)).toBeLessThan(25);
  });

  // Off the map at a yard's pace (a parking lot, a lane the map lacks): the off-road particles take over.
  test("a turn into open country at 18 km/h hands over to the off-road particles", () => {
    const g = graph();
    const drive = syntheticDrive({ segments: junctionDrive(-20, 5), origin: ORIGIN, startHeadingRad: Math.PI / 2, gnss: "clean", obdScale: 0.99 });
    const result = replayTrip(drive.trip, { mapMatch: { graph: g }, cuts: [{ fromS: 100, toS: 1e9 }] });
    const end = result.track.at(-1)!.mapMatch!;
    expect(end.state).toBe("offroad");
    expect(end.clusters[0].edge).toBeNull();
  });

  // Nobody drives a yard at 50 km/h (`offRoadSpeed`): a heading slowly drifting off a road at that speed is far
  // likelier dead reckoning (the EKF under jamming) than the car leaving the map, so the filter keeps to the roads.
  // A sharp turn no road explains still hands over (the open-country test above).
  test("veering gently off the map at 50 km/h, the filter keeps to the roads", () => {
    const segments: DriveSegment[] = [
      { durationS: 3, speedMps: 0, yawRateDegS: 0 },
      { durationS: 10, speedMps: 12, yawRateDegS: 0 },
      { durationS: 90, speedMps: 14, yawRateDegS: 0 }, // 1.4 km east, short of the junction
      { durationS: 10, speedMps: 14, yawRateDegS: -3 }, // 30° off the road, gently
      { durationS: 20, speedMps: 14, yawRateDegS: 0 },
    ];
    const drive = syntheticDrive({ segments, origin: ORIGIN, startHeadingRad: Math.PI / 2, gnss: "clean", obdScale: 0.99 });
    const handOver = (factor?: number) => {
      const config = factor === undefined ? {} : { offRoadSpeed: { freeMps: 20 / 3.6, fullMps: 40 / 3.6, factor } };
      const result = replayTrip(drive.trip, { mapMatch: { graph: graph(), config }, cuts: [{ fromS: 50, toS: 1e9 }] });
      return result.track.find((p) => p.tS > 100 && p.mapMatch?.state === "offroad")?.tS ?? Infinity;
    };
    // Without the speed rule it hands over within a few seconds of the veer (at ~117 s).
    expect(handOver(1)).toBeLessThan(125);
    expect(handOver()).toBe(Infinity);
  });

  // Jammed start (MAPMATCH-SPEC §8): Wi-Fi-like fixes (±60 m) only while parked, then nothing. No
  // course, and no fix spread for alignment: only the map can give the heading.
  test("jammed start at the dead end: the map gives the heading", () => {
    const g = graph();
    const drive = syntheticDrive({ segments: junctionDrive(20), origin: ORIGIN, startHeadingRad: Math.PI / 2, gnss: "coarse", obdScale: 0.99 });
    const cuts = [{ fromS: 3.5, toS: 1e9 }];
    expect(replayTrip(drive.trip, { cuts }).summary.init).toBeNull();
    const result = replayTrip(drive.trip, { mapMatch: { graph: g }, cuts });
    const init = result.summary.init!;
    expect(init.method).toBe("map");
    // Driving east from the dead end: the westbound hypotheses turn round there, which the gyro
    // didn't see. Then one hypothesis tracked over 100 m.
    expect(init.distanceM).toBeLessThan(400);
    const truth = drive.truthAt(drive.trip.startUs + init.tS * 1e6);
    expect(Math.abs(init.estimate!.headingRad! - Math.PI / 2)).toBeLessThan((5 * Math.PI) / 180);
    // The position along the road is still open (no turn yet): the EKF starts with that spread.
    const dN = (init.estimate!.lat - truth.lat) * 111_195;
    const dE = (init.estimate!.lon - truth.lon) * 111_195 * Math.cos((truth.lat * Math.PI) / 180);
    expect(init.estimate!.accuracyM).toBeLessThan(150);
    expect(Math.hypot(dE, dN)).toBeLessThan(2 * init.estimate!.accuracyM);
    // Before the start: state init.
    const first = result.track.find((p) => p.mapMatch)!;
    expect(first.mode).toBe("anchored");
    expect(first.mapMatch!.state).toBe("init");
    // Then the filter carries on and takes the turn onto 162.
    const end = result.track.at(-1)!;
    expect(end.mode).toBe("dr");
    expect(wayOf(g, end.mapMatch!.clusters[0].edge)).toBe(162);
  });

  test("jammed start mid-road: both directions stay alive, so no start", () => {
    const g = graph();
    // 800 m east of the dead end, 400 m straight: neither direction reaches a node.
    const origin = { lat: ORIGIN.lat, lon: ORIGIN.lon + 800 / (111_195 * Math.cos((ORIGIN.lat * Math.PI) / 180)) };
    const segments = [
      { durationS: 3, speedMps: 0, yawRateDegS: 0 },
      { durationS: 10, speedMps: 12, yawRateDegS: 0 },
      { durationS: 28, speedMps: 12, yawRateDegS: 0 },
    ];
    const drive = syntheticDrive({ segments, origin, startHeadingRad: Math.PI / 2, gnss: "coarse" });
    const result = replayTrip(drive.trip, { mapMatch: { graph: g }, cuts: [{ fromS: 3.5, toS: 1e9 }] });
    expect(result.summary.init).toBeNull();
    const end = result.track.at(-1)!;
    expect(end.mode).toBe("anchored");
    expect(end.mapMatch!.state).toBe("init");
    // The top hypotheses are both directions of road 160 (each spread along it: the position along
    // the road is still open, so neither holds enough weight to track).
    const top = end.mapMatch!.clusters;
    const facing = (heading: number) =>
      top.some((c) => wayOf(g, c.edge) === 160 && Math.abs(Math.atan2(Math.sin(c.headingRad - heading), Math.cos(c.headingRad - heading))) < 0.3);
    expect(facing(Math.PI / 2)).toBe(true);
    expect(facing(-Math.PI / 2)).toBe(true);
    expect(top[0].weight).toBeLessThan(0.9);
  });

  test("jammed start mid-road with a compass: the true direction wins; a compass turned around still keeps it", () => {
    const origin = { lat: ORIGIN.lat, lon: ORIGIN.lon + 800 / (111_195 * Math.cos((ORIGIN.lat * Math.PI) / 180)) };
    const segments = [
      { durationS: 3, speedMps: 0, yawRateDegS: 0 },
      { durationS: 10, speedMps: 12, yawRateDegS: 0 },
      { durationS: 28, speedMps: 12, yawRateDegS: 0 },
    ];
    const drive = syntheticDrive({ segments, origin, startHeadingRad: Math.PI / 2, gnss: "coarse", magnetometer: {} });
    // East's share of the weight at the end, fed like the replay with every fix after 3.5 s withheld.
    const eastShare = (rotateRad: number) => {
      const nav = new Navigator({ compassUse: "on" });
      nav.setRoadGraph(graph());
      nav.setCompassCalibration(rotateCalibration(syntheticCompassCalibration(), rotateRad));
      const t = drive.trip;
      const events = [
        ...t.imu.map((x) => ({ tUs: x.tUs, go: () => nav.onImu(x) })),
        ...t.obdSpeed.map((x) => ({ tUs: x.tUs, go: () => nav.onObdSpeed(x) })),
        ...t.mag.map((x) => ({ tUs: x.tUs, go: () => nav.onMag(x) })),
        ...t.gnss.filter((f) => f.tUs < t.startUs + 3.5e6).map((x) => ({ tUs: x.tUs, go: () => nav.onGnss(x) })),
      ].sort((a, b) => a.tUs - b.tUs);
      for (const ev of events) ev.go();
      expect(nav.mode).toBe("anchored");
      return nav.mapMatcher!.directionShare(Math.PI / 2, 0.3);
    };
    // Right compass: east is preferred (without a compass both directions stay even, test above).
    expect(eastShare(0)).toBeGreaterThan(0.7);
    // Turned 180°: west is preferred, but east keeps the weight to win at the next turn or dead end,
    // and the compass alone can't reach the 0.9 a map start needs.
    const wrong = eastShare(Math.PI);
    expect(wrong).toBeLessThan(0.5);
    expect(wrong).toBeGreaterThan(0.1);
  });

  test("waits while the anchor is too coarse: a cell fix searches its claim (they are within it), a Wi-Fi fix 3σ", () => {
    const g = graph();
    const run = (gnssSigmaM: number) =>
      replayTrip(syntheticDrive({ segments: junctionDrive(20).slice(0, 2), origin: ORIGIN, startHeadingRad: Math.PI / 2, gnss: "coarse", gnssSigmaM }).trip, { mapMatch: { graph: g } });
    // ±1.5 km: wider than the filter starts on.
    expect(run(1500).track.every((p) => p.mapMatch === undefined)).toBe(true);
    // ±400 m: 450 m around it (3σ was 1.2 km, too wide).
    expect(run(400).track.some((p) => p.mapMatch !== undefined)).toBe(true);
  });

  test("starts at the first fix, carries on through the course start, and stays off without a graph", () => {
    const g = graph();
    const drive = syntheticDrive({ segments: junctionDrive(20), origin: ORIGIN, startHeadingRad: Math.PI / 2, gnss: "clean" });
    const result = replayTrip(drive.trip, { mapMatch: { graph: g } });
    const initS = result.summary.init!.tS;
    expect(result.summary.init!.method).toBe("course");
    // Anchored, the filter runs with the heading unknown.
    const before = result.track.filter((p) => p.tS >= 1.5 && p.tS < initS - 0.5);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((p) => p.mode === "anchored" && p.mapMatch && ["init", "tracking"].includes(p.mapMatch.state))).toBe(true);
    // It tracks the road when the course arrives, so the EKF keeps it.
    expect(result.summary.init!.estimate!.mapMatch!.state).toBe("tracking");
    const after = result.track.filter((p) => p.tS > initS + 1);
    expect(after.every((p) => p.mapMatch && p.mapMatch.particles === 500)).toBe(true);
    // With clean GNSS the whole drive is on the right roads.
    expect(after.filter((p) => p.tS < 140).every((p) => wayOf(g, p.mapMatch!.clusters[0].edge) === 160)).toBe(true);
    const plain = replayTrip(drive.trip);
    expect(plain.track.every((p) => p.mapMatch === undefined)).toBe(true);
  });
});

// The road heading switched off: a straight-road share no road reaches.
const NO_ROAD_HEADING = { roadHeading: { minShare: 2 } };
// And the road position: GNSS counted as trusted for ever after a satellite fix was accepted. Only after one: an EKF
// the map started never had one, GNSS is untrusted from the start, and the road position runs all the same.
const NO_ROAD_CORRECTIONS = { ...NO_ROAD_HEADING, roadPosition: { trustedWindowUs: Infinity } };

// MAPMATCH-SPEC §9: the road's direction back into the EKF heading.
describe("road heading into the EKF", () => {
  // East along the fixture's long road, GNSS cut after 40 s, with a gyro bias the EKF hasn't learned
  // (one 3 s stop): without the road heading the heading drifts with it, the road holds it. No satellite fix is ever
  // accepted here (no course, no turn to align on: the map starts the EKF after the cut), so the road position runs
  // in both runs.
  const straightDrive = () =>
    syntheticDrive({
      segments: [
        { durationS: 3, speedMps: 0, yawRateDegS: 0 },
        { durationS: 130, speedMps: 12, yawRateDegS: 0 },
      ],
      origin: ORIGIN,
      startHeadingRad: Math.PI / 2,
      gnss: "clean",
      obdScale: 0.99,
      gyroBiasRadS: (0.05 * Math.PI) / 180,
    });
  const headingErrorDeg = (roadHeading: boolean) => {
    const result = replayTrip(straightDrive().trip, {
      ...(roadHeading ? {} : { nav: NO_ROAD_HEADING }),
      mapMatch: { graph: graph() },
      cuts: [{ fromS: 40, toS: 1e9 }],
    });
    const end = result.track.at(-1)!;
    const { roadHeading: heading, roadPosition: position } = result.summary;
    return { errorDeg: Math.abs(end.headingRad! - Math.PI / 2) * (180 / Math.PI), roadHeading: heading, roadPosition: position };
  };

  test("without the road heading the heading drifts further with the gyro bias", () => {
    const without = headingErrorDeg(false);
    const withRoad = headingErrorDeg(true);
    expect(without.roadHeading).toEqual({ accepted: 0, rejected: 0 });
    // The road heading is all that differs.
    expect(without.roadPosition).toEqual(withRoad.roadPosition);
    // 0.86° against 0.61° (seeds 2 and 3, and biases to 0.15°/s: 23–29 % less with the road).
    expect(without.errorDeg).toBeGreaterThan(1.25 * withRoad.errorDeg);
  });

  test("on a straight road it holds the heading, about every 25 m", () => {
    const closed = headingErrorDeg(true);
    // ~1.5 km of straight road: one update per 25 m once the filter tracks, minus the junction margins.
    expect(closed.roadHeading.accepted).toBeGreaterThan(20);
    expect(closed.roadHeading.rejected).toBe(0);
    expect(closed.errorDeg).toBeLessThan(1);
  });
});

describe("road position into the EKF", () => {
  // The junction drive with GNSS cut 50 s before the turn, a gyro bias the EKF hasn't learned and OBD
  // reading 3 % low: the EKF drifts off the road; the filter knows where it is once the car has turned.
  const run = (corrections: boolean, cut = true) => {
    const drive = syntheticDrive({
      segments: junctionDrive(20),
      origin: ORIGIN,
      startHeadingRad: Math.PI / 2,
      gnss: "clean",
      obdScale: 0.97,
      gyroBiasRadS: (0.05 * Math.PI) / 180,
    });
    const result = replayTrip(drive.trip, {
      ...(corrections ? {} : { nav: NO_ROAD_CORRECTIONS }),
      mapMatch: { graph: graph() },
      cuts: cut ? [{ fromS: 100, toS: 1e9 }] : [],
    });
    const end = result.track.at(-1)!;
    const truth = drive.truthAt(drive.trip.imu.at(-1)!.tUs);
    const dN = (end.lat - truth.lat) * 111_195;
    const dE = (end.lon - truth.lon) * 111_195 * Math.cos((truth.lat * Math.PI) / 180);
    return { errorM: Math.hypot(dE, dN), sigmaM: end.accuracyM, summary: result.summary };
  };

  test("only while GNSS is cut, and it brings the EKF back to the road the car turned onto", () => {
    const open = run(false);
    const closed = run(true);
    expect(open.summary.roadPosition).toEqual({ accepted: 0, rejected: 0 });
    // ~0.9 km without GNSS, one every 200 m.
    expect(closed.summary.roadPosition.accepted).toBeGreaterThanOrEqual(3);
    expect(closed.summary.roadPosition.rejected).toBe(0);
    expect(closed.errorM).toBeLessThan(open.errorM);
    // Its radius shrinks with it, and still covers the error.
    expect(closed.sigmaM).toBeLessThan(open.sigmaM);
    expect(closed.errorM).toBeLessThan(2 * closed.sigmaM);
    // With GNSS throughout, the filter weighs the same fixes: no road position.
    expect(run(true, false).summary.roadPosition).toEqual({ accepted: 0, rejected: 0 });
  });

  test("the map-free twin (off by default) runs alongside and can feed the filter", () => {
    const drive = syntheticDrive({ segments: junctionDrive(20), origin: ORIGIN, startHeadingRad: Math.PI / 2, gnss: "clean", obdScale: 0.97 });
    const result = replayTrip(drive.trip, {
      nav: { mapMatchTwin: { prior: true, odometry: true } },
      mapMatch: { graph: graph() },
      cuts: [{ fromS: 100, toS: 1e9 }],
    });
    const end = result.track.at(-1)!;
    const truth = drive.truthAt(drive.trip.imu.at(-1)!.tUs);
    expect(Math.hypot((end.lat - truth.lat) * 111_195, (end.lon - truth.lon) * 111_195 * Math.cos((truth.lat * Math.PI) / 180))).toBeLessThan(25);
    expect(result.summary.roadPosition.accepted).toBeGreaterThan(0);
  });
});

// The dense junction (tools/tiles tests/test_graph.py, shaped on a real one with `replay:junction`): a 2 km
// primary from the north into node 70, where **two** primaries leave eastbound only a few degrees apart, with a
// service road at 134° and a service lane 45 m to the side. The fixture's other junctions offer one exit per
// direction, which is why they survive along-track errors this one does not.
describe("a 95° turn at a junction as dense as a real one (MAPMATCH-SPEC §15, item 14)", () => {
  const JUNCTION = { lat: 51.52 - 0.02, lon: 30.75 - 0.05 };
  // What the drive below really covers before the turn, and when the turn starts: the speeds ramp between
  // segments, so neither is the nominal sum.
  const APPROACH_M = 1497;
  const TURN_S = 71.3;
  const dense = () => new TiledRoadGraph(bufferByteSource(new Uint8Array(FIXTURE)), new LocalFrame(JUNCTION));
  const START = { lat: JUNCTION.lat + APPROACH_M / 111_195, lon: JUNCTION.lon };
  // The drive: 126 km/h down the approach, brake to ~30, a 95° left over 4.5 s, then away to the east.
  const DRIVE: DriveSegment[] = [
    { durationS: 3, speedMps: 0, yawRateDegS: 0 },
    { durationS: 20, speedMps: 20, yawRateDegS: 0 },
    { durationS: 40, speedMps: 35, yawRateDegS: 0 },
    { durationS: 8.3, speedMps: 8, yawRateDegS: 0 },
    { durationS: 4.5, speedMps: 5, yawRateDegS: 21 },
    { durationS: 20, speedMps: 20, yawRateDegS: 0 },
  ];

  /**
   * The drive with the filter started `offsetM` short of where the car really is, as 16 km of dead reckoning left
   * it on 2026-10-06, and no fix ever arriving to correct it. `obdScale` cannot stand in for the offset: the
   * navigator learns the speed scale and calibrates it away.
   */
  function run(offsetM: number) {
    const g = dense();
    const drive = syntheticDrive({ segments: DRIVE, origin: START, startHeadingRad: Math.PI, gnss: "clean", obdScale: 1 });
    const truth0 = drive.truth[0];
    const result = replayTrip(drive.trip, {
      mapMatch: { graph: g },
      cuts: [{ fromS: 0, toS: 1e9 }],
      startPose: { lat: truth0.lat + offsetM / 111_195, lon: truth0.lon, headingRad: truth0.psi, posSigmaM: 5, headingSigmaRad: 0.04 },
    });
    const frame = new LocalFrame(JUNCTION);
    const atTurn = result.track.find((p) => p.tS >= TURN_S)!;
    const after = result.track.filter((p) => p.tS >= TURN_S + 2);
    const end = result.track.at(-1)!.mapMatch!;
    return {
      // + means the filter thinks it is still short of the junction.
      alongM: frame.toEnu(atTurn)[1] - frame.toEnu(drive.truthAt(drive.trip.imu[0].tUs + TURN_S * 1e6))[1],
      offRoad: after.filter((p) => p.mapMatch?.state === "offroad").length / after.length,
      endWay: wayOf(g, end.clusters[0].edge),
      end,
    };
  }

  test("knowing where it is, it takes the turn onto one of the two eastbound roads", () => {
    for (const offsetM of [0, 20, 40]) {
      const r = run(offsetM);
      // Started up to 40 m short, and nothing says where along the 1.5 km approach it is (no turn, no fix): ~2 %
      // of it may add to that.
      expect(r.alongM).toBeLessThan(80);
      // 172 is the one driven; 173 leaves the node at the same heading and is 28 m off it 360 m on. Since the road
      // position stopped telling the EKF where along the road it is between turns, the filter can end on either.
      expect([172, 173]).toContain(r.endWay);
      expect(r.offRoad).toBeLessThan(0.2);
    }
  });

  // The failure of 2026-10-06, 16 km into the drive out: the car turned 62 m before the filter's idea of the
  // junction (250 m on the same drive replayed without GPS), so no road there explains a 95° turn. The dot left the
  // map, and on the phone it drove through the field beside the road for 52 s at 130 km/h. A wider reach to a road
  // (80–120 m) fixed this case and snapped particles onto roads the car was never on elsewhere. The turn itself says
  // the filter lost the car: almost none of it turned with it, and it starts again around the EKF, over twice its σ
  // (the EKF's position along the road came from those particles). Here the EKF claims ±5 m from its start pose,
  // so it reaches ~150 m; on the drive it claimed ±63 m and the junction 250 m on was within reach.
  test("short of the junction, the turn no road explains starts it again, and it finds the road", () => {
    for (const offsetM of [62, 150]) {
      const r = run(offsetM);
      expect(r.alongM).toBeGreaterThan(offsetM - 10);
      expect([172, 173]).toContain(r.endWay);
      expect(r.offRoad).toBeLessThan(0.2);
    }
  });
});

describe("the nearest road a car could be driving along (the dot at speed, MAPMATCH-SPEC §11)", () => {
  const filterAt = (lat: number, lon: number) =>
    new ParticleFilter(new TiledRoadGraph(bufferByteSource(new Uint8Array(FIXTURE)), new LocalFrame({ lat, lon })));
  const DEG = Math.PI / 180;

  test("30 m beside the long road, heading along it: on the road, its way", () => {
    const pf = filterAt(51.53, 30.76);
    const road = pf.nearestRoad(0, 30, 92 * DEG, 80, 60 * DEG)!;
    expect(Math.abs(road.n)).toBeLessThan(1);
    expect(Math.abs(road.e)).toBeLessThan(1);
    expect(road.headingRad).toBeCloseTo(Math.PI / 2, 1);
    // Heading the other way it is the same road, driven west.
    expect(Math.abs(pf.nearestRoad(0, 30, -88 * DEG, 80, 60 * DEG)!.headingRad + Math.PI / 2)).toBeLessThan(0.1);
  });

  // 2026-10-15: between a road and a parking lane 30 m apart the nearest changed every second or two.
  test("the road it was drawn on stays while it is at most the slack farther than the nearest", () => {
    const graph = new TiledRoadGraph(bufferByteSource(new Uint8Array(FIXTURE)), new LocalFrame({ lat: 51.53, lon: 30.76 }));
    const pf = new ParticleFilter(graph);
    // A spot beside two roads a car could be driving along (either way), the farther one 5–20 m farther.
    const fitsAt = (e: number, n: number, psi: number) =>
      graph.edgesNear(e, n, 80).filter((x) => {
        const d = Math.abs(Math.atan2(Math.sin(x.headingRad - psi), Math.cos(x.headingRad - psi)));
        return (d <= 60 * DEG || d >= 120 * DEG) && x.edge.oneway === 0;
      });
    let spot: { e: number; n: number; psi: number; first: number; second: number } | null = null;
    for (let e = -800; e <= -300 && !spot; e += 10) {
      for (let n = -1200; n <= -800 && !spot; n += 10) {
        for (const psi of [0, Math.PI / 2]) {
          const fits = fitsAt(e, n, psi);
          const gap = fits.length >= 2 ? fits[1].distanceM - fits[0].distanceM : Infinity;
          if (fits[1] && fits[1].edge.wayId !== fits[0].edge.wayId && gap >= 5 && gap <= 20) spot = { e, n, psi, first: fits[0].edge.id, second: fits[1].edge.id };
          if (spot) break;
        }
      }
    }
    expect(spot).not.toBeNull();
    const { e, n, psi, first, second } = spot!;
    expect(pf.nearestRoad(e, n, psi, 80, 60 * DEG)!.edge).toBe(first);
    expect(pf.nearestRoad(e, n, psi, 80, 60 * DEG, { edge: second, slackM: 20 })!.edge).toBe(second);
    expect(pf.nearestRoad(e, n, psi, 80, 60 * DEG, { edge: second, slackM: 2 })!.edge).toBe(first);
  });

  test("not across the road, not out of reach, not against a one-way", () => {
    const pf = filterAt(51.53, 30.76);
    expect(pf.nearestRoad(0, 30, 0, 80, 60 * DEG)).toBeNull();
    expect(pf.nearestRoad(0, 120, 90 * DEG, 80, 60 * DEG)).toBeNull();
    // The one-way 162 runs north: a car 20 m beside it heading north is on it, heading south it is not.
    const oneway = filterAt(51.532, 30.775);
    expect(oneway.nearestRoad(20, 0, 0, 80, 60 * DEG)).not.toBeNull();
    expect(oneway.nearestRoad(20, 0, Math.PI, 80, 60 * DEG)).toBeNull();
  });
});

describe("a start where the car was parked off the roads (MAPMATCH-SPEC §7.2)", () => {
  const DEG = Math.PI / 180;
  const start = (offRoadStart: boolean) => {
    // 30 m beside the long road, heading along it, 30 m sure: a lot beside a street.
    const pf = new ParticleFilter(new TiledRoadGraph(bufferByteSource(new Uint8Array(FIXTURE)), new LocalFrame({ lat: 51.53, lon: 30.76 })));
    pf.init(0, 30, 30, 92 * DEG, 2 * DEG, { distanceM: 0, turnRad: 0 }, offRoadStart);
    return pf;
  };

  test("parked on the road side as usual: the road takes the weight", () => {
    const pf = start(false);
    expect(pf.output().state).not.toBe("offroad");
    expect(pf.offRoadWeight()).toBeLessThan(0.5);
  });

  // 2026-10-12: parked on a lot, the next drive's dot started on the heaviest road within 3σ, 84 m from the spot.
  test("parked off the roads: it starts off-road", () => {
    const pf = start(true);
    expect(pf.output().state).toBe("offroad");
    expect(pf.offRoadWeight()).toBeGreaterThanOrEqual(0.6);
  });
});

// 2026-10-20 (r4banv): placed facing a lane in a car park, at right angles to the road it left by 5 m away, the
// filter started on the lane alone and the dot drove on along it after the car turned onto the road.
describe("the driver's placing off the roads (NAVIGATOR-SPEC §6.2)", () => {
  const DEG = Math.PI / 180;
  const BESIDE = { lat: 51.53 + 5 / 111_195, lon: 30.76 };
  const placed = (headingRad: number, withGraph: "before" | "after") => {
    const nav = new Navigator();
    const g = new TiledRoadGraph(bufferByteSource(new Uint8Array(FIXTURE)), new LocalFrame({ lat: 51.53, lon: 30.76 }));
    if (withGraph === "before") nav.setRoadGraph(g);
    nav.onImu({ tUs: 1_000_000, gyro: [0, 0, 0], gravity: [0, 0, -9.81], userAccel: [0, 0, 0] });
    nav.setPosition({ ...BESIDE, headingRad, posSigmaM: 10, headingSigmaRad: 15 * DEG });
    if (withGraph === "after") nav.setRoadGraph(g);
    return nav.estimate()!;
  };

  test("5 m beside the long road, at right angles to it: off the roads, at the spot", () => {
    for (const when of ["before", "after"] as const) {
      const est = placed(0, when);
      expect(est.mapMatch?.state).toBe("offroad");
      expect(est.parkedOffRoad).toBe(true);
    }
  });

  test("5 m beside the long road, along it either way: on the road", () => {
    for (const heading of [92 * DEG, -88 * DEG]) {
      const est = placed(heading, "before");
      expect(est.mapMatch?.state).not.toBe("offroad");
      expect(est.parkedOffRoad).toBeUndefined();
    }
  });
});

describe("a drive from a lot (NAVIGATOR-SPEC §6.1)", () => {
  // Parked facing east 30 m north of the long road, out of the lot onto it, then 700 m east along it; no GNSS.
  const LOT = { lat: 51.53 + 30 / 111_195, lon: 30.76 };
  const segments: DriveSegment[] = [
    { durationS: 5, speedMps: 0, yawRateDegS: 0 },
    { durationS: 2, speedMps: 5, yawRateDegS: 0 },
    { durationS: 3, speedMps: 5, yawRateDegS: -30 }, // right, to the south
    { durationS: 3, speedMps: 5, yawRateDegS: 0 },
    { durationS: 3, speedMps: 5, yawRateDegS: 30 }, // left, onto the road east
    { durationS: 60, speedMps: 12, yawRateDegS: 0 },
  ];
  const drive = syntheticDrive({ segments, origin: LOT, startHeadingRad: Math.PI / 2, gnss: "clean", obdScale: 1 });
  const run = (offRoad: boolean) =>
    replayTrip(drive.trip, {
      mapMatch: { graph: graph() },
      cuts: [{ fromS: 0, toS: 1e9 }],
      startPose: { ...LOT, headingRad: Math.PI / 2, posSigmaM: 30, headingSigmaRad: 0.04, ...(offRoad ? { offRoad } : {}) },
    }).track;

  test("saved off the roads: off-road at the spot until it drives away, then on the road", () => {
    const track = run(true);
    const parked = track.filter((p) => p.tS < 4);
    expect(parked.length).toBeGreaterThan(0);
    for (const p of parked) {
      expect(p.mapMatch?.state).toBe("offroad");
      expect(p.parkedOffRoad).toBe(true);
      // The dot is the spot itself, not a hypothesis on a road beside it.
      expect(puckHypothesis(p, true)).toBeUndefined();
    }
    const end = track.at(-1)!;
    expect(end.parkedOffRoad).toBeUndefined();
    const top = end.mapMatch!.clusters[0];
    const truth = drive.truthAt(drive.trip.imu.at(-1)!.tUs);
    expect(Math.hypot((top.lat - truth.lat) * 111_195, (top.lon - truth.lon) * 111_195 * Math.cos((truth.lat * Math.PI) / 180))).toBeLessThan(15);
  });

  test("saved on a road side: the road beside it takes the start, as before", () => {
    const first = run(false)[0];
    expect(first.mapMatch?.state).not.toBe("offroad");
    expect(first.parkedOffRoad).toBeUndefined();
  });
});
