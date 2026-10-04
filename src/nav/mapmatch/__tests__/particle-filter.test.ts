import { readFileSync } from "node:fs";
import path from "node:path";

import { syntheticDrive, type DriveSegment } from "@/nav/__fixtures__/synthetic-drive";
import { LocalFrame } from "@/nav/geo/local-frame";
import { bufferByteSource } from "@/nav/mapmatch/graph/byte-source";
import { TiledRoadGraph } from "@/nav/mapmatch/graph/road-graph";
import { replayTrip } from "@/nav/replay/replay";

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

  test("a turn into open country hands over to the off-road particles", () => {
    const g = graph();
    const drive = syntheticDrive({ segments: junctionDrive(-20), origin: ORIGIN, startHeadingRad: Math.PI / 2, gnss: "clean", obdScale: 0.99 });
    const result = replayTrip(drive.trip, { mapMatch: { graph: g }, cuts: [{ fromS: 100, toS: 1e9 }] });
    const end = result.track.at(-1)!.mapMatch!;
    expect(end.state).toBe("offroad");
    expect(end.clusters[0].edge).toBeNull();
  });

  test("starts with the EKF, reports cheap updates, and stays off without a graph", () => {
    const g = graph();
    const drive = syntheticDrive({ segments: junctionDrive(20), origin: ORIGIN, startHeadingRad: Math.PI / 2, gnss: "clean" });
    const result = replayTrip(drive.trip, { mapMatch: { graph: g } });
    const initS = result.summary.init!.tS;
    expect(result.track.filter((p) => p.tS < initS - 0.5).every((p) => p.mapMatch === undefined)).toBe(true);
    const after = result.track.filter((p) => p.tS > initS + 1);
    expect(after.every((p) => p.mapMatch && p.mapMatch.particles === 500)).toBe(true);
    // With clean GNSS the whole drive is on the right roads.
    expect(after.filter((p) => p.tS < 140).every((p) => wayOf(g, p.mapMatch!.clusters[0].edge) === 160)).toBe(true);
    const plain = replayTrip(drive.trip);
    expect(plain.track.every((p) => p.mapMatch === undefined)).toBe(true);
  });
});
