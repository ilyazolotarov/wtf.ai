import { readFileSync } from "node:fs";
import path from "node:path";

import { syntheticCompassCalibration, syntheticDrive, type DriveSegment } from "@/nav/__fixtures__/synthetic-drive";
import { LocalFrame } from "@/nav/geo/local-frame";
import { bufferByteSource } from "@/nav/mapmatch/graph/byte-source";
import { TiledRoadGraph } from "@/nav/mapmatch/graph/road-graph";
import { replayTrip } from "@/nav/replay/replay";
import { rotateCalibration } from "@/nav/compass/compass";
import { Navigator } from "@/nav/navigator";

// The fixture's long road (tools/tiles tests/test_graph.py): 60 —160— 61 —161— 63 due east at
// LAT0 + 0.01, with the one-way 162 running north from 61 (1.73 km east of 60).
const FIXTURE = readFileSync(path.join(__dirname, "../__fixtures__/net.graph.bin"));
const ORIGIN = { lat: 51.53, lon: 30.75 };
const graph = () => new TiledRoadGraph(bufferByteSource(new Uint8Array(FIXTURE)), new LocalFrame(ORIGIN));
const wayOf = (g: TiledRoadGraph, edge: number | null) => (edge === null ? null : g.edge(edge).wayId);

// Node 61 is 1732 m east of 60. A 20 °/s turn at 5 m/s has a 14 m radius (a real junction turn;
// a wider arc is much shorter than the road via the node), so it starts 14 m before the junction
// and ends on 162 (or, turning right, in open country).
function junctionDrive(turnDegS: number): DriveSegment[] {
  return [
    { durationS: 3, speedMps: 0, yawRateDegS: 0 },
    { durationS: 10, speedMps: 12, yawRateDegS: 0 }, // 60 m
    { durationS: 133.9, speedMps: 12, yawRateDegS: 0 }, // 1607 m
    { durationS: 6, speedMps: 5, yawRateDegS: 0 }, // 51 m
    { durationS: 4.5, speedMps: 5, yawRateDegS: turnDegS }, // quarter circle
    { durationS: 20, speedMps: 10, yawRateDegS: 0 },
  ];
}

describe("ParticleFilter in the navigator (synthetic drives on the fixture graph)", () => {
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

  test("a route hint the driver doesn't follow never overrides the turn (ROUTING-SPEC §8.6)", () => {
    const g = graph();
    const drive = syntheticDrive({ segments: junctionDrive(20), origin: ORIGIN, startHeadingRad: Math.PI / 2, gnss: "clean", obdScale: 0.99 });
    // The route goes straight on along 161; the car turns onto 162.
    const straightOn = g.edgesInTiles(g.tilesInBounds(-180, -85, 180, 85)).filter((e) => e.wayId === 160 || e.wayId === 161).map((e) => e.id);
    const result = replayTrip(drive.trip, {
      nav: { routeHintFactor: 10 },
      mapMatch: { graph: g },
      cuts: [{ fromS: 100, toS: 1e9 }],
      routeHints: [{ fromS: 0, edges: straightOn }],
    });
    const end = result.track.at(-1)!.mapMatch!;
    expect(wayOf(g, end.clusters[0].edge)).toBe(162);
    expect(end.clusters[0].weight).toBeGreaterThan(0.8);
  });

  test("a turn into open country hands over to the off-road particles", () => {
    const g = graph();
    const drive = syntheticDrive({ segments: junctionDrive(-20), origin: ORIGIN, startHeadingRad: Math.PI / 2, gnss: "clean", obdScale: 0.99 });
    const result = replayTrip(drive.trip, { mapMatch: { graph: g }, cuts: [{ fromS: 100, toS: 1e9 }] });
    const end = result.track.at(-1)!.mapMatch!;
    expect(end.state).toBe("offroad");
    expect(end.clusters[0].edge).toBeNull();
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

  test("waits while the anchor is too coarse", () => {
    const g = graph();
    const drive = syntheticDrive({ segments: junctionDrive(20).slice(0, 2), origin: ORIGIN, startHeadingRad: Math.PI / 2, gnss: "coarse", gnssSigmaM: 400 });
    const result = replayTrip(drive.trip, { mapMatch: { graph: g } });
    expect(result.track.every((p) => p.mapMatch === undefined)).toBe(true);
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

// MAPMATCH-SPEC §9: the road's direction back into the EKF heading.
describe("road heading into the EKF", () => {
  // East along the fixture's long road, GNSS cut after 40 s, with a gyro bias the EKF hasn't learned
  // (one 3 s stop): open loop the heading drifts with it, the road holds it.
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
  const headingErrorDeg = (loop: "open" | "heading") => {
    const result = replayTrip(straightDrive().trip, {
      nav: { mapMatchLoop: loop },
      mapMatch: { graph: graph() },
      cuts: [{ fromS: 40, toS: 1e9 }],
    });
    const end = result.track.at(-1)!;
    return { errorDeg: Math.abs(end.headingRad! - Math.PI / 2) * (180 / Math.PI), roadHeading: result.summary.roadHeading };
  };

  test("open loop sends nothing and the heading drifts with the gyro bias", () => {
    const open = headingErrorDeg("open");
    expect(open.roadHeading).toEqual({ accepted: 0, rejected: 0 });
    expect(open.errorDeg).toBeGreaterThan(2);
  });

  test("on a straight road it holds the heading, about every 25 m", () => {
    const closed = headingErrorDeg("heading");
    // ~1.5 km of straight road: one update per 25 m once the filter tracks, minus the junction margins.
    expect(closed.roadHeading.accepted).toBeGreaterThan(20);
    expect(closed.roadHeading.rejected).toBe(0);
    expect(closed.errorDeg).toBeLessThan(1);
  });
});

describe("road position into the EKF", () => {
  // The junction drive with GNSS cut 50 s before the turn, a gyro bias the EKF hasn't learned and OBD
  // reading 3 % low: the EKF drifts off the road; the filter knows where it is once the car has turned.
  const run = (loop: "open" | "closed", cut = true) => {
    const drive = syntheticDrive({
      segments: junctionDrive(20),
      origin: ORIGIN,
      startHeadingRad: Math.PI / 2,
      gnss: "clean",
      obdScale: 0.97,
      gyroBiasRadS: (0.05 * Math.PI) / 180,
    });
    const result = replayTrip(drive.trip, { nav: { mapMatchLoop: loop }, mapMatch: { graph: graph() }, cuts: cut ? [{ fromS: 100, toS: 1e9 }] : [] });
    const end = result.track.at(-1)!;
    const truth = drive.truthAt(drive.trip.imu.at(-1)!.tUs);
    const dN = (end.lat - truth.lat) * 111_195;
    const dE = (end.lon - truth.lon) * 111_195 * Math.cos((truth.lat * Math.PI) / 180);
    return { errorM: Math.hypot(dE, dN), sigmaM: end.accuracyM, summary: result.summary };
  };

  test("only while GNSS is cut, and it brings the EKF back to the road the car turned onto", () => {
    const open = run("open");
    const closed = run("closed");
    expect(open.summary.roadPosition).toEqual({ accepted: 0, rejected: 0 });
    // ~0.9 km without GNSS, one every 200 m.
    expect(closed.summary.roadPosition.accepted).toBeGreaterThanOrEqual(3);
    expect(closed.summary.roadPosition.rejected).toBe(0);
    expect(closed.errorM).toBeLessThan(open.errorM);
    // Its radius shrinks with it, and still covers the error.
    expect(closed.sigmaM).toBeLessThan(open.sigmaM);
    expect(closed.errorM).toBeLessThan(2 * closed.sigmaM);
    // With GNSS throughout, the filter weighs the same fixes: no road position.
    expect(run("closed", false).summary.roadPosition).toEqual({ accepted: 0, rejected: 0 });
  });

  test("the map-free twin (off by default) runs alongside and can feed the filter", () => {
    const drive = syntheticDrive({ segments: junctionDrive(20), origin: ORIGIN, startHeadingRad: Math.PI / 2, gnss: "clean", obdScale: 0.97 });
    const result = replayTrip(drive.trip, {
      nav: { mapMatchLoop: "closed", mapMatchTwin: { prior: true, odometry: true } },
      mapMatch: { graph: graph() },
      cuts: [{ fromS: 100, toS: 1e9 }],
    });
    const end = result.track.at(-1)!;
    const truth = drive.truthAt(drive.trip.imu.at(-1)!.tUs);
    expect(Math.hypot((end.lat - truth.lat) * 111_195, (end.lon - truth.lon) * 111_195 * Math.cos((truth.lat * Math.PI) / 180))).toBeLessThan(25);
    expect(result.summary.roadPosition.accepted).toBeGreaterThan(0);
  });
});
