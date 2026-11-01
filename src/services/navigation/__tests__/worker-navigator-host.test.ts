import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import path from "node:path";

import { syntheticDrive, type DriveSegment } from "@/nav/__fixtures__/synthetic-drive";
import { LocalFrame } from "@/nav/geo/local-frame";
import { bufferByteSource } from "@/nav/mapmatch/graph/byte-source";
import { TiledRoadGraph } from "@/nav/mapmatch/graph/road-graph";
import type { TripLog } from "@/triplog/trip-log-reader";
import { MemoryKeyValueStore, replayTripInApp } from "@/services/navigation/app-replay";
import { CalibrationStore } from "@/services/navigation/calibration-store";
import { inProcessLink, type FileBytes } from "@/services/navigation/navigator-remote";
import { WorkerNavigatorHost } from "@/services/navigation/worker-navigator-host";

const PHONE = { model: "iPhone14,5", os: "ios 26.0" };
const VIN = "JMZKF0000TEST0001";
// The fixture graph (src/nav/mapmatch/__fixtures__): a road east from the origin with a junction 1.73 km along it.
const GRAPH_PATH = path.join(__dirname, "../../../nav/mapmatch/__fixtures__/net.graph.bin");
const GRAPH_ORIGIN = { lat: 51.53, lon: 30.75 };
const JUNCTION_DRIVE: DriveSegment[] = [
  { durationS: 3, speedMps: 0, yawRateDegS: 0 },
  { durationS: 10, speedMps: 12, yawRateDegS: 0 },
  { durationS: 133.9, speedMps: 12, yawRateDegS: 0 },
  { durationS: 6, speedMps: 5, yawRateDegS: 0 },
  { durationS: 4.5, speedMps: 5, yawRateDegS: 20 },
  { durationS: 20, speedMps: 10, yawRateDegS: 0 },
];

/** Files read as modules/graph-bytes reads them on the phone. */
const nodeBytes: FileBytes = {
  open: (p) => openSync(p, "r"),
  size: (h) => fstatSync(h).size,
  read(h, offset, length) {
    const bytes = new Uint8Array(length);
    const n = readSync(h, bytes, 0, length, offset);
    return bytes.buffer.slice(0, n);
  },
  close: (h) => closeSync(h),
};

/** The app replayed with the navigator in-process, or behind the worker's protocol (each message copied). */
function replay(trip: TripLog, worker: boolean) {
  const errors: string[] = [];
  const graph = {
    key: "net:1",
    region: "net",
    graph: new TiledRoadGraph(bufferByteSource(new Uint8Array(readFileSync(GRAPH_PATH))), new LocalFrame(GRAPH_ORIGIN)),
    file: { path: GRAPH_PATH, centre: GRAPH_ORIGIN },
  };
  const r = replayTripInApp(trip, {
    calibration: new CalibrationStore(new MemoryKeyValueStore(), PHONE),
    vin: VIN,
    roadGraph: graph,
    // GNSS cut on the long straight and through the turn: the dot is dead reckoning on the roads, then fixes come back.
    cuts: [{ fromS: 40, toS: 170 }],
    ...(worker ? { navigatorHost: new WorkerNavigatorHost(inProcessLink(nodeBytes), { nowMs: () => 0, error: (text) => errors.push(text) }) } : {}),
  });
  return {
    errors,
    published: r.published,
    // Measured times aside.
    mapMatch: r.publishedMapMatch.map(({ updateUs: _u, updates: _n, ...rest }) => rest),
    notes: r.notes.filter((n) => !n.text.startsWith("mm timing")),
    parkedCar: r.parkedCar,
  };
}

describe("WorkerNavigatorHost", () => {
  test("through the worker's protocol, the service publishes what it does with the navigator in-process", () => {
    const { trip } = syntheticDrive({ segments: JUNCTION_DRIVE, origin: GRAPH_ORIGIN, startHeadingRad: Math.PI / 2, gnss: "clean", obdScale: 0.99, seed: 5 });
    const local = replay(trip, false);
    const worker = replay(trip, true);
    expect(worker.errors).toEqual([]);
    expect(local.mapMatch.some((m) => m.state === "tracking")).toBe(true);
    expect(worker.published).toEqual(local.published);
    expect(worker.mapMatch).toEqual(local.mapMatch);
    expect(worker.notes).toEqual(local.notes);
    expect(worker.parkedCar).toEqual(local.parkedCar);
  });
});
