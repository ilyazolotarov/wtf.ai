// Local trip replay viewer: `npm run replay:view` → http://127.0.0.1:5174
// Serves index.html, lists tools/triplog/logs/*.ulg, replays one on request, and serves the
// road graph around it (tools/tiles/out/release/*.graph.bin, or --graph <file>).
// Bound to localhost only: the logs hold the VIN and GPS tracks.

import { exec } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mergeCalibrations, type CompassCalibration } from "../../../src/nav/compass/compass";
import type { NavConfig } from "../../../src/nav/navigator";
import { appOutageCuts, replayTrip, type ReplayOptions } from "../../../src/nav/replay/replay";
import { buildViewerData } from "../../../src/nav/replay/viewer-data";
import { replayTripInApp, MemoryKeyValueStore, phoneOf } from "../../../src/services/navigation/app-replay";
import { CalibrationStore } from "../../../src/services/navigation/calibration-store";
import type { MapMatchLoop } from "../../../src/services/navigation/navigator-service";
import type { ActiveRoadGraph } from "../../../src/services/offline-map/road-graph-file";
import { readTripLog, type TripLog } from "../../../src/triplog/trip-log-reader";
import { findGraph, openGraph, roadsAround, truthRoute } from "../graph-file";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const LOG_DIR = path.resolve(flag("--logs") ?? path.join(HERE, "../../triplog/logs"));
const PORT = Number(flag("--port") ?? 5174);
const GRAPH = flag("--graph");

// The last log read: /api/roads follows /api/replay for the same file.
let lastTrip: { file: string; trip: TripLog } | null = null;
function loadTrip(file: string): TripLog {
  if (lastTrip?.file !== file) lastTrip = { file, trip: readTripLog(new Uint8Array(readFileSync(path.join(LOG_DIR, file)))) };
  return lastTrip.trip;
}

// What each log's compass learns on its own (NAVIGATOR-SPEC §7.6), replayed once per log and kept.
const learned = new Map<string, CompassCalibration | null>();
/** The compass calibration for a log: pooled from every other log in the folder (null: none learned). */
function compassFromOtherLogs(file: string): { calibration: CompassCalibration; logs: number } | null {
  const cals: CompassCalibration[] = [];
  for (const { file: other } of listLogs()) {
    if (other === file) continue;
    if (!learned.has(other)) {
      const trip = readTripLog(new Uint8Array(readFileSync(path.join(LOG_DIR, other))));
      learned.set(other, trip.mag?.length ? replayTrip(trip).summary.compass.calibration : null);
    }
    const cal = learned.get(other);
    if (cal) cals.push(cal);
  }
  return cals.length ? { calibration: cals.reduce((a, b) => mergeCalibrations(a, b)), logs: cals.length } : null;
}

/**
 * Where a log's region is, to pick its road graph: the first fix within 500 m, else any fix, else the first
 * position the app published. The app has its region's graph whatever the fixes, so a jammed log without one good
 * fix must still get it here, or its replay runs without map matching and drives through the blocks.
 */
function regionPoint(trip: TripLog): { lat: number; lon: number } | null {
  const fix = trip.gnss.find((f) => f.hAccM <= 500) ?? trip.gnss[0];
  if (fix) return fix;
  const shown = trip.navEstimate.find((r) => Number.isFinite(r.latDeg) && Number.isFinite(r.lonDeg));
  return shown ? { lat: shown.latDeg, lon: shown.lonDeg } : null;
}

/** The road graph a log's region has (null: none), opened for one replay. */
function graphFor(trip: TripLog): { active: ActiveRoadGraph; close(): void } | null {
  const first = regionPoint(trip);
  const graphFile = first ? (GRAPH ?? findGraph(first)) : null;
  if (!first || !graphFile) return null;
  const opened = openGraph(graphFile, first);
  return { active: { key: graphFile, region: path.basename(graphFile, ".graph.bin"), graph: opened.graph }, close: opened.close };
}

/** The car as the app identifies it (vehicle-link-core): its VIN, else the car last seen on the same OBD protocol. */
function carOf(trip: TripLog, byProtocol: Map<string, string>): string | null {
  const vin = typeof trip.info.vehicle_vin === "string" && trip.info.vehicle_vin ? trip.info.vehicle_vin : null;
  const protocol = String(trip.info.obd_protocol ?? "").replace(/^A/, "");
  if (vin && protocol) byProtocol.set(protocol, vin);
  return vin ?? (protocol ? (byProtocol.get(protocol) ?? null) : null);
}

interface AppState {
  /** The app's storage before the log: parked poses, speed scales, compass calibrations, GNSS lag. */
  store: MemoryKeyValueStore;
  /** The car (VIN) the app takes the log's to be. */
  vin: string | null;
  /** The drive whose end saved the car's parked pose (null: none stored). */
  parkedAfter: string | null;
}

/**
 * The app's state before a log (NAVIGATOR-SPEC §6.1): every earlier log replayed in order through the app's own
 * NavigatorService (app-replay.ts) with this navigator version and one storage across them, as on the phone. Kept
 * per navigator version; each log's state is a copy.
 */
const appStates = new Map<string, Map<string, AppState>>();
function appStateBefore(file: string, loop: MapMatchLoop): AppState {
  const states = appStates.get(loop) ?? appStates.set(loop, new Map()).get(loop)!;
  if (states.has(file)) return states.get(file)!;
  const store = new MemoryKeyValueStore();
  const byProtocol = new Map<string, string>();
  const parkedAfter = new Map<string, string>();
  for (const { file: log } of [...listLogs()].reverse()) {
    if (log > file) break;
    const trip = readTripLog(new Uint8Array(readFileSync(path.join(LOG_DIR, log))));
    const vin = carOf(trip, byProtocol);
    states.set(log, { store: store.copy(), vin, parkedAfter: vin ? (parkedAfter.get(vin) ?? null) : null });
    if (log === file) break;
    const graph = graphFor(trip);
    try {
      const calibration = new CalibrationStore(store, phoneOf(trip));
      const before = vin ? calibration.parkedPose(vin)?.savedAt : undefined;
      replayTripInApp(trip, { calibration, loop, roadGraph: graph?.active, vin });
      const after = vin ? calibration.parkedPose(vin)?.savedAt : undefined;
      if (vin && after === undefined) parkedAfter.delete(vin);
      else if (vin && after !== before) parkedAfter.set(vin, log);
    } finally {
      graph?.close();
    }
  }
  return states.get(file) ?? { store: new MemoryKeyValueStore(), vin: null, parkedAfter: null };
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function listLogs() {
  return readdirSync(LOG_DIR)
    .filter((f) => f.endsWith(".ulg"))
    .map((f) => {
      const st = statSync(path.join(LOG_DIR, f));
      return { file: f, sizeMb: Math.round((st.size / 1e6) * 10) / 10 };
    })
    .sort((a, b) => b.file.localeCompare(a.file));
}

/** Navigator versions (MAPMATCH-SPEC §9): the open-loop baseline (what the app runs), and the closed-loop steps. */
const LOOPS: Record<string, { label: string; nav: Partial<NavConfig> }> = {
  open: { label: "Open loop", nav: { mapMatchLoop: "open" } },
  heading: { label: "Road heading", nav: { mapMatchLoop: "heading" } },
  closed: { label: "Full correction", nav: { mapMatchLoop: "closed" } },
};

function parseCuts(s: string | null): { fromS: number; toS: number }[] {
  if (!s) return [];
  return s
    .split(",")
    .map((c) => c.split(":").map((v) => (v === "inf" ? Infinity : Number(v))))
    .filter(([a, b]) => Number.isFinite(a) && b > 0)
    .map(([a, b]) => ({ fromS: a, toS: a + b }));
}

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname === "/") {
      send(res, 200, "text/html; charset=utf-8", readFileSync(path.join(HERE, "index.html")));
    } else if (url.pathname === "/api/logs") {
      send(res, 200, "application/json", JSON.stringify(listLogs()));
    } else if (url.pathname === "/api/replay") {
      const file = path.basename(url.searchParams.get("file") ?? "");
      if (!file.endsWith(".ulg")) return send(res, 400, "text/plain", "file must be a .ulg in the logs folder");
      const q = (name: string) => url.searchParams.get(name) ?? "";
      const lag = q("lag");
      const start = Number(q("start") || 0);
      // GPS scenario: as in the app (its "Cut GPS" windows withheld), all of it, cut where asked, jammed, or none.
      const gps = q("gps") || "app";
      // Start: from where the car parked after its previous drive (as the app does now), or cold.
      const startFrom = q("from") || "parked";
      const compareLoop = LOOPS[q("compare")] ?? null;
      // Compass: off, or calibrated on the other logs, optionally turned (a wrong calibration).
      const compassArg = url.searchParams.get("compass") ?? "";
      const compass = compassArg ? compassFromOtherLogs(file) : null;
      const rotateDeg = Number(compassArg) || 0;
      const started = Date.now();
      const trip = loadTrip(file);
      // The navigator version the phone ran (trip log header, from the app's developer setting); default open.
      const phoneLoop = typeof trip.info.nav_mapmatch_loop === "string" ? trip.info.nav_mapmatch_loop : null;
      const loopKey = q("loop") || phoneLoop || "open";
      const loop = LOOPS[loopKey] ?? LOOPS.open;
      // The app replay unless a research option asks for the navigator alone (a later start, a fixed GNSS lag, a compass).
      const inApp = !(start > 0) && !lag && !compassArg;
      const appLoop = (loop.nav.mapMatchLoop ?? "open") as MapMatchLoop;
      const state = inApp ? (startFrom === "parked" ? appStateBefore(file, appLoop) : { store: new MemoryKeyValueStore(), vin: carOf(trip, new Map()), parkedAfter: null }) : null;
      // Map matching on the trip's road graph, when there is one.
      const first = regionPoint(trip);
      const graphFile = first ? (GRAPH ?? findGraph(first)) : null;
      const opened = graphFile && first ? openGraph(graphFile, first) : null;
      try {
        const appCuts = appOutageCuts(trip);
        const asked = parseCuts(q("cut"));
        const common: ReplayOptions = {
          cuts: gps === "app" ? appCuts : gps === "cut" ? asked : [],
          ...(gps === "nogps" ? { openLoop: { delayS: 0 } } : {}),
          ...(gps === "jam" ? { jam: asked.length ? asked : [{ fromS: 0, toS: Infinity }] } : {}),
          ...(opened ? { mapMatch: { graph: opened.graph } } : {}),
          ...(start > 0 ? { startAtS: start } : {}),
          ...(compass ? { compass: { calibration: compass.calibration, rotateRad: (rotateDeg * Math.PI) / 180 } } : {}),
        };
        const navFor = (nav: Partial<NavConfig>): Partial<NavConfig> => ({ ...nav, ...(lag ? { gnssLagS: Number(lag), estimateGnssLag: false } : {}) });
        // Through the app: the service publishes the dot, starts from the stored parked pose, and runs the outages.
        const replay = (o: ReplayOptions) =>
          replayTripInApp(trip, {
            calibration: new CalibrationStore(state!.store.copy(), phoneOf(trip)),
            loop: (o.nav?.mapMatchLoop ?? appLoop) as MapMatchLoop,
            roadGraph: opened ? { key: graphFile!, region: path.basename(graphFile!, ".graph.bin"), graph: opened.graph } : null,
            vin: state!.vin,
            cuts: o.cuts ?? [],
            jam: o.jam,
            openLoop: o.openLoop,
            trackStepS: o.trackStepS,
            mapMatch: { particlesEveryS: o.mapMatch?.particlesEveryS },
          });
        const data = buildViewerData(file, trip, { ...common, nav: navFor(loop.nav) }, {
          appCuts,
          ...(inApp ? { replay } : {}),
          ...(compareLoop ? { compare: { label: compareLoop.label, options: { ...common, nav: navFor(compareLoop.nav) } } } : {}),
        });
        const compassInfo = compassArg ? { logs: compass?.logs ?? 0, rotateDeg, trust: data.summary.compass.trust } : null;
        send(res, 200, "application/json", JSON.stringify({ ...data, compassInfo, loopLabel: loop.label, phoneLoopLabel: phoneLoop ? (LOOPS[phoneLoop]?.label ?? phoneLoop) : null, appCuts: appCuts.length, parkedFrom: state && startFrom === "parked" ? { file: state.parkedAfter, status: data.summary.startPose?.status ?? null } : null, inApp }));
      } finally {
        opened?.close();
      }
      console.log(`replayed ${file} in ${Date.now() - started} ms`);
    } else if (url.pathname === "/api/roads") {
      const file = path.basename(url.searchParams.get("file") ?? "");
      if (!file.endsWith(".ulg")) return send(res, 400, "text/plain", "file must be a .ulg in the logs folder");
      const started = Date.now();
      const trip = loadTrip(file);
      const fixes = trip.gnss.filter((f) => f.hAccM <= 500);
      // Without one good fix, around where the app drew the car.
      const points = fixes.length ? fixes : trip.navEstimate.filter((_, i) => i % 10 === 0).map((r) => ({ lat: r.latDeg, lon: r.lonDeg }));
      const graphFile = points.length ? (GRAPH ?? findGraph(points[0])) : null;
      const payload = graphFile
        ? roadsAround(graphFile, points)
        : { graph: null, osmDate: null, tiles: 0, roads: { type: "FeatureCollection", features: [] }, nodes: { type: "FeatureCollection", features: [] } };
      send(res, 200, "application/json", JSON.stringify(payload));
      console.log(`roads for ${file}: ${payload.graph ?? "no graph"}, ${payload.roads.features.length} edges in ${Date.now() - started} ms`);
    } else if (url.pathname === "/api/truth") {
      const file = path.basename(url.searchParams.get("file") ?? "");
      if (!file.endsWith(".ulg")) return send(res, 400, "text/plain", "file must be a .ulg in the logs folder");
      const started = Date.now();
      const trip = loadTrip(file);
      const first = trip.gnss.find((f) => f.hAccM <= 10);
      const graphFile = first ? (GRAPH ?? findGraph(first)) : null;
      const empty = { type: "FeatureCollection", features: [] };
      const payload = graphFile ? truthRoute(graphFile, trip) : { graph: null, legs: empty, breaks: empty, summary: { fixes: 0, matched: 0, breaks: 0 } };
      send(res, 200, "application/json", JSON.stringify(payload));
      const s = payload.summary;
      console.log(`truth for ${file}: ${s.matched} of ${s.fixes} clean fixes matched, ${s.breaks} breaks, ${Date.now() - started} ms`);
    } else {
      send(res, 404, "text/plain", "not found");
    }
  } catch (error) {
    console.error(error);
    send(res, 500, "text/plain", String(error));
  }
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EADDRINUSE") throw error;
  console.error(`port ${PORT} is busy: is the viewer already running? Stop it, or use --port <n>.`);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`trip replay viewer: ${url}  (logs: ${LOG_DIR})`);
  if (args.includes("--open")) exec(process.platform === "win32" ? `start "" ${url}` : `open ${url}`);
});
