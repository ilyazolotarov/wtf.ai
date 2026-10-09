import { readFileSync } from "node:fs";
import path from "node:path";

import { syntheticDrive, type DriveSegment } from "@/nav/__fixtures__/synthetic-drive";
import { haversineM } from "@/nav/geo";
import { LocalFrame } from "@/nav/geo/local-frame";
import { bufferByteSource } from "@/nav/mapmatch/graph/byte-source";
import { TiledRoadGraph } from "@/nav/mapmatch/graph/road-graph";
import { TurnTracker } from "@/nav/mapmatch/turn-tracker";
import { PhoneNavigator } from "@/nav/phone/phone-navigator";

// The fixture's long road (tools/tiles tests/test_graph.py): 60 —160— 61 —161— 63 due east at LAT0 + 0.01, with the
// one-way 162 running north from 61 (1.73 km east of 60).
const FIXTURE = readFileSync(path.join(__dirname, "../../mapmatch/__fixtures__/net.graph.bin"));
const ORIGIN = { lat: 51.53, lon: 30.75 };
const graph = () => new TiledRoadGraph(bufferByteSource(new Uint8Array(FIXTURE)), new LocalFrame(ORIGIN));
const wayAt = (g: TiledRoadGraph, e: number, n: number) => g.edgesNear(e, n, 20).sort((a, b) => a.distanceM - b.distanceM)[0]?.edge.wayId ?? null;

// Stand, pull away east along 160, slow down and turn left onto 162 at node 61, drive on north.
const DRIVE: DriveSegment[] = [
  { durationS: 5, speedMps: 0, yawRateDegS: 0 },
  { durationS: 8, speedMps: 12, yawRateDegS: 0 }, // 48 m
  { durationS: 138.5, speedMps: 12, yawRateDegS: 0 }, // 1662 m
  { durationS: 6, speedMps: 5, yawRateDegS: 0 }, // 51 m
  { durationS: 4.5, speedMps: 5, yawRateDegS: 20 }, // a quarter circle, left
  { durationS: 3, speedMps: 10, yawRateDegS: 0 },
  { durationS: 20, speedMps: 10, yawRateDegS: 0 }, // 200 m north
];

describe("TurnTracker", () => {
  test("a speed 20 % low still finds the junction the car turned at", () => {
    const g = graph();
    const drive = syntheticDrive({ segments: DRIVE, origin: ORIGIN, startHeadingRad: Math.PI / 2, gnss: "none" });
    const frame = new LocalFrame(ORIGIN);
    const tracker = new TurnTracker(g);
    const [e0, n0] = frame.toEnu(drive.truthAt(drive.trip.imu[0].tUs));
    tracker.start(e0, n0, Math.PI / 2, 10, 0.1);
    const imu = drive.trip.imu;
    for (let i = 10; i < imu.length; i += 10) {
      const t = drive.truthAt(imu[i].tUs);
      tracker.step({ tUs: imu[i].tUs, dtS: 0.1, speedMps: 0.8 * t.speedMps, yawRate: imu[i].gyro[2], valid: true, stopped: t.speedMps === 0 });
    }
    expect(tracker.stats.turns).toBe(1);
    const end = tracker.estimate()!;
    const truth = drive.truthAt(imu.at(-1)!.tUs);
    const [te, tn] = frame.toEnu(truth);
    // On 162, about the right distance north of the junction: 1.7 km at 0.8× put it ~200 m short there, and the snap
    // re-learned the scale from that.
    expect(wayAt(g, end.e, end.n)).toBe(162);
    expect(Math.hypot(end.e - te, end.n - tn)).toBeLessThan(60);
  });
});

describe("PhoneNavigator", () => {
  test("follows a drive from its parked pose on the phone's IMU alone", () => {
    const drive = syntheticDrive({ segments: DRIVE, origin: ORIGIN, startHeadingRad: Math.PI / 2, gnss: "none", phoneAccel: {} });
    const g = graph();
    const nav = new PhoneNavigator(g);
    const start = drive.truthAt(drive.trip.imu[0].tUs);
    nav.start({ lat: start.lat, lon: start.lon, headingRad: Math.PI / 2, posSigmaM: 10, headingSigmaRad: 0.1 });
    for (const s of drive.trip.imu) nav.onImu(s);
    const end = nav.estimate()!;
    const truth = drive.truthAt(drive.trip.imu.at(-1)!.tUs);
    expect(haversineM(end, truth)).toBeLessThan(80);
    // On 162 (the graph is in the navigator's frame: its origin is the start), heading north.
    const [ee, en] = new LocalFrame(start).toEnu(end);
    expect(wayAt(g, ee, en)).toBe(162);
    expect(Math.abs(Math.atan2(Math.sin(end.headingRad), Math.cos(end.headingRad)))).toBeLessThan(0.3);
    expect(nav.mount).not.toBeNull();
  });

  test("with a route the driver follows, the car is on it; placed off it, it has left it", () => {
    const drive = syntheticDrive({ segments: DRIVE, origin: ORIGIN, startHeadingRad: Math.PI / 2, gnss: "none", phoneAccel: {} });
    const imu = drive.trip.imu;
    // The route: the drive's own path.
    const route = [];
    for (let t = imu[0].tUs; t <= imu.at(-1)!.tUs; t += 2e6) route.push(drive.truthAt(t));
    const nav = new PhoneNavigator(graph());
    nav.setRoute(route);
    const start = drive.truthAt(imu[0].tUs);
    nav.start({ lat: start.lat, lon: start.lon, headingRad: Math.PI / 2, posSigmaM: 10, headingSigmaRad: 0.1 });
    expect(nav.routeState).toBe("following");
    for (const s of imu) nav.onImu(s);
    expect(nav.routeState).toBe("following");
    const end = nav.estimate()!;
    expect(haversineM(end, drive.truthAt(imu.at(-1)!.tUs))).toBeLessThan(40);
    expect(end.alternatives).toEqual([]);
    // The driver puts the car 300 m off the route: it has left it.
    nav.place({ lat: end.lat, lon: end.lon + 300 / (111_195 * Math.cos((end.lat * Math.PI) / 180)), headingRad: 0, posSigmaM: 15, headingSigmaRad: 0.2 });
    expect(nav.routeState).toBe("off");
  });

  test("a new route starting on the followed one ahead of a lagging dot carries on from where the dot is", () => {
    const drive = syntheticDrive({ segments: DRIVE, origin: ORIGIN, startHeadingRad: Math.PI / 2, gnss: "none", phoneAccel: {} });
    const imu = drive.trip.imu;
    const route = [];
    for (let t = imu[0].tUs; t <= imu.at(-1)!.tUs; t += 2e6) route.push(drive.truthAt(t));
    const nav = new PhoneNavigator(graph());
    nav.setRoute(route);
    const start = drive.truthAt(imu[0].tUs);
    nav.start({ lat: start.lat, lon: start.lon, headingRad: Math.PI / 2, posSigmaM: 10, headingSigmaRad: 0.1 });
    const half = Math.floor(imu.length / 2);
    for (const s of imu.slice(0, half)) nav.onImu(s);
    // Re-planned from where the car really was 400 m further on (a replay of a log made with OBD).
    const ahead = route.findIndex((q) => haversineM(q, nav.estimate()!) > 400 && q.lon > nav.estimate()!.lon);
    nav.setRoute(route.slice(ahead));
    expect(nav.routeState).toBe("following");
    for (const s of imu.slice(half)) nav.onImu(s);
    expect(nav.routeState).toBe("following");
    expect(haversineM(nav.estimate()!, drive.truthAt(imu.at(-1)!.tUs))).toBeLessThan(40);
  });

  test("a trusted satellite fix with a course starts it; an untrusted one doesn't", () => {
    const nav = new PhoneNavigator(graph());
    const at = { lat: ORIGIN.lat + 0.01, lon: ORIGIN.lon + 0.005 };
    const fix = { tUs: 1e9, ...at, hAccM: 5, speedMps: 10, courseRad: Math.PI / 2, courseAccRad: 0.05 };
    nav.onFix(fix, false);
    expect(nav.started).toBe(false);
    nav.onFix(fix, true);
    expect(nav.started).toBe(true);
    expect(haversineM(nav.estimate()!, at)).toBeLessThan(30);
  });
});
