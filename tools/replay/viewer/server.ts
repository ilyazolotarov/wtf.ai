// Local trip replay viewer: `npm run replay:view` → http://127.0.0.1:5174
// Serves index.html, lists tools/triplog/logs/*.ulg, replays one on request, and serves the
// road graph around it (tools/tiles/out/release/*.graph.bin, or --graph <file>).
// Bound to localhost only: the logs hold the VIN and GPS tracks.

import { exec } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import { tintDarkStyle, type MapStyleJson } from "../../../src/config/map-dark";

import { mergeCalibrations, type CompassCalibration } from "../../../src/nav/compass/compass";
import { LocalFrame } from "../../../src/nav/geo/local-frame";
import type { TiledRoadGraph } from "../../../src/nav/mapmatch/graph/road-graph";
import type { NavConfig } from "../../../src/nav/navigator";
import { puckTuning } from "../../../src/nav/position/puck";
import { obdFromCan } from "../../../src/nav/replay/can";
import { drawnTruthTrack, drawPath, type DrawnPoint, type DrawnTruth } from "../../../src/nav/replay/drawn-truth";
import { findIncidents, INCIDENT_STEP_S } from "../../../src/nav/replay/incidents";
import { appOutageCuts, replayTrip, type ReplayOptions } from "../../../src/nav/replay/replay";
import { buildViewerData } from "../../../src/nav/replay/viewer-data";
import { driverPlacings, replayTripInApp, MemoryKeyValueStore, phoneOf, seedFromLog } from "../../../src/services/navigation/app-replay";
import { CalibrationStore } from "../../../src/services/navigation/calibration-store";
import { PHONE_CAR, STORAGE_NOTE } from "../../../src/services/navigation/navigator-service";
import { readTripLog, type TripLog } from "../../../src/triplog/trip-log-reader";
import { carOf, drawnStartPose, graphFor as graphForTrip, odometryTrack, phoneRouteFor, regionPoint, routeBeforeLog } from "../app-chain";
import { deleteLog } from "../../triplog/deleted";
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
    if (other === file || !samePhone(other, file)) continue;
    if (!learned.has(other)) {
      const trip = readTripLog(new Uint8Array(readFileSync(path.join(LOG_DIR, other))));
      learned.set(other, trip.mag?.length ? replayTrip(trip).summary.compass.calibration : null);
    }
    const cal = learned.get(other);
    if (cal) cals.push(cal);
  }
  return cals.length ? { calibration: cals.reduce((a, b) => mergeCalibrations(a, b)), logs: cals.length } : null;
}

/** The road graph a log's region has (`--graph` overrides), opened for one replay. */
const graphFor = (trip: TripLog) => graphForTrip(trip, GRAPH);

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
 * NavigatorService (app-replay.ts) with one storage across them, as on the phone. Each log's state is a copy. The
 * first starts from what the phone had stored then (its `nav storage` notes), not from nothing: a phone's logs start
 * mid-life, and a driver's placing or a parked pose from before them is where its first drive started.
 */
const states = new Map<string, AppState>();
function appStateBefore(file: string): AppState {
  if (states.has(file)) return states.get(file)!;
  const store = new MemoryKeyValueStore();
  const byProtocol = new Map<string, string>();
  const parkedAfter = new Map<string, string>();
  let first = true;
  for (const { file: log } of [...listLogs()].reverse()) {
    if (!samePhone(log, file)) continue;
    if (path.basename(log) > path.basename(file)) break;
    const trip = readTripLog(new Uint8Array(readFileSync(path.join(LOG_DIR, log))));
    if (first) seedFromLog(trip, new CalibrationStore(store, phoneOf(trip)));
    first = false;
    const vin = carOf(trip, byProtocol);
    states.set(log, { store: store.copy(), vin, parkedAfter: vin ? (parkedAfter.get(vin) ?? null) : null });
    if (log === file) break;
    const graph = graphFor(trip);
    try {
      const calibration = new CalibrationStore(store, phoneOf(trip));
      const before = vin ? calibration.parkedPose(vin)?.savedAt : undefined;
      replayTripInApp(trip, { calibration, roadGraph: graph?.active, vin });
      const after = vin ? calibration.parkedPose(vin)?.savedAt : undefined;
      if (vin && after === undefined) parkedAfter.delete(vin);
      else if (vin && after !== before) parkedAfter.set(vin, log);
    } finally {
      graph?.close();
    }
  }
  return states.get(file) ?? { store: new MemoryKeyValueStore(), vin: null, parkedAfter: null };
}

/**
 * What the phone had stored when the drive started, from the log's `nav storage` notes (the app writes them at every
 * trip start): no earlier drive to replay. Null: the log has none (an app from before 2026-10-11).
 */
function appStateFromLog(trip: TripLog): AppState | null {
  const store = new MemoryKeyValueStore();
  if (!seedFromLog(trip, new CalibrationStore(store, phoneOf(trip)))) return null;
  const stored = trip.messages
    .filter((m) => m.text.startsWith(STORAGE_NOTE))
    .map((m) => {
      try {
        return (JSON.parse(m.text.slice(STORAGE_NOTE.length)) as { vin?: string }).vin;
      } catch {
        return undefined;
      }
    })
    .find(Boolean);
  return { store, vin: carOf(trip, new Map()) ?? stored ?? null, parkedAfter: null };
}

/** Ground truth drawn in the viewer, next to its log (git-ignored with it): `<log>.truth.json`. */
const drawnFile = (file: string) => path.join(LOG_DIR, file.replace(/\.ulg$/, ".truth.json"));
function readDrawn(file: string): DrawnTruth | null {
  const f = drawnFile(file);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as DrawnTruth) : null;
}
/** The drawn truth and where it puts the car every second (the odometer between the drive's ends and clean fixes). */
function drawnPayload(trip: TripLog, truth: DrawnTruth | null) {
  if (!truth || truth.path.length < 2) return { truth, timed: null };
  const { points, cum, pathM, odometerM, anchors, doubtM } = drawnTruthTrack(trip, truth);
  const round = (v: number, i: number) => (i === 1 || i === 2 ? Math.round(v * 1e6) / 1e6 : Math.round(v * 10) / 10);
  return { truth, timed: { points: points.map((p) => p.map(round)), cum, pathM, odometerM, anchors, doubtM } };
}
/** Liberty, tinted for dark mode as the app does it (src/config/map-dark.ts); fetched once per server run. */
const LIBERTY = "https://tiles.openfreemap.org/styles/liberty";
let darkStyleCache: Promise<MapStyleJson> | null = null;
function darkStyle(): Promise<MapStyleJson> {
  darkStyleCache ??= fetch(LIBERTY)
    .then((r) => {
      if (!r.ok) throw new Error(`${LIBERTY}: ${r.status}`);
      return r.json() as Promise<MapStyleJson>;
    })
    .then((style) => tintDarkStyle(style))
    .catch((error: unknown) => {
      darkStyleCache = null;
      throw error;
    });
  return darkStyleCache;
}
/** One graph kept open for drawing, so a click doesn't reopen the file and reread its tiles. */
let drawGraph: { file: string; graph: TiledRoadGraph; close(): void } | null = null;
function graphForDrawing(trip: TripLog): { file: string; graph: TiledRoadGraph } | null {
  const at = regionPoint(trip);
  const file = at ? (GRAPH ?? findGraph(at)) : null;
  if (!at || !file) return null;
  if (drawGraph?.file !== file) {
    drawGraph?.close();
    drawGraph = { file, ...openGraph(file, at) };
  }
  return drawGraph;
}
const isPoint = (p: unknown): p is DrawnPoint =>
  typeof p === "object" && p !== null && Number.isFinite((p as DrawnPoint).lat) && Number.isFinite((p as DrawnPoint).lon);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 2_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

// What went wrong, for the page: the message only. The stack stays in this console (console.error).
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Every log: the project's own in the logs folder, testers' uploads in testers/<name>/ (TRIP-LOGGER-SPEC §7.1).
 * `file` is the path inside the logs folder; `who` is the tester ("" for the project's phone). Newest first.
 */
function listLogs() {
  const folders = [{ dir: "", who: "" }];
  const testers = path.join(LOG_DIR, "testers");
  if (existsSync(testers)) {
    for (const e of readdirSync(testers, { withFileTypes: true })) if (e.isDirectory()) folders.push({ dir: `testers/${e.name}/`, who: e.name });
  }
  return folders
    .flatMap(({ dir, who }) =>
      readdirSync(path.join(LOG_DIR, dir))
        .filter((f) => f.endsWith(".ulg"))
        .map((f) => {
          const file = dir + f;
          const st = statSync(path.join(LOG_DIR, file));
          return { file, who, sizeMb: Math.round((st.size / 1e6) * 10) / 10, drawn: existsSync(drawnFile(file)) };
        }),
    )
    .sort((a, b) => path.basename(b.file).localeCompare(path.basename(a.file)));
}

/** The logs of one phone (its own storage on the device): the same folder. */
const samePhone = (a: string, b: string) => path.dirname(a) === path.dirname(b);

/** A `file` query parameter: a log inside the logs folder, or null (no escaping it with ../). */
function logParam(url: URL): string | null {
  const file = url.searchParams.get("file") ?? "";
  return /^(testers\/[a-z0-9][a-z0-9-]*\/)?[\w-]+\.ulg$/.test(file) ? file : null;
}

/**
 * Compare with the dot as it was before 2026-10-16: no heading cue, not steady along its road (position/puck.ts). Run
 * with those settings, then put back.
 */
const BEFORE_DOT = { label: "Before 2026-10-16", nav: {} as Partial<NavConfig> };
function withDotBefore<T>(run: () => T): T {
  const puck = { ...puckTuning };
  Object.assign(puckTuning, { headingCueFactor: 1, steady: false });
  try {
    return run();
  } finally {
    Object.assign(puckTuning, puck);
  }
}

function parseCuts(s: string | null): { fromS: number; toS: number }[] {
  if (!s) return [];
  return s
    .split(",")
    .map((c) => c.split(":").map((v) => (v === "inf" ? Infinity : Number(v))))
    .filter(([a, b]) => Number.isFinite(a) && b > 0)
    .map(([a, b]) => ({ fromS: a, toS: a + b }));
}

/** A reply: status, content type, body. */
interface Reply {
  status: number;
  type: string;
  body: string;
}

/**
 * One drive replayed for the page (/api/replay): the app replay, its incidents against the drawing, the placings, the
 * gyro path. Runs in the replay worker (below), so the server answers everything else meanwhile and a replay nobody
 * waits for any more is stopped at once.
 */
function replayReply(url: URL): Reply {
  const file = logParam(url);
  if (!file) return { status: 400, type: "text/plain", body: "file must be a .ulg in the logs folder" };
  let reply: Reply = { status: 500, type: "text/plain", body: "no reply" };
  const q = (name: string) => url.searchParams.get(name) ?? "";
  const lag = q("lag");
  const start = Number(q("start") || 0);
  // GPS scenario: as in the app (its "Cut GPS" windows withheld), all of it, cut where asked, jammed, or none.
  const gps = q("gps") || "app";
  // Start: from what the phone had stored (in the log), from where this navigator would have parked the car after
  // its previous drive (every earlier drive replayed), where the drawn truth starts, or cold.
  const startFrom = q("from") || "phone";
  // Adapter: as recorded (OBD or CAN, whichever the app took its speed from), or none (phone-only mode,
  // NAVIGATOR-SPEC §9.6: no OBD speed or engine).
  const phoneOnly = q("adapter") === "none";
  // With the adapter (app replay only): the speed as OBD polls would have read it instead of the CAN wheels, and the
  // turns from the phone's gyro instead of the rear wheels (can.ts `obdFromCan`; the service's wheel yaw off).
  const obdSpeed = !phoneOnly && q("speed") === "obd";
  const gyroTurns = !phoneOnly && q("turns") === "gyro";
  const compareLoop = q("compare") === "before" ? BEFORE_DOT : null;
  // Compass: off, or calibrated on the other logs, optionally turned (a wrong calibration).
  const compassArg = url.searchParams.get("compass") ?? "";
  const compass = compassArg ? compassFromOtherLogs(file) : null;
  const rotateDeg = Number(compassArg) || 0;
  const started = Date.now();
  const trip = loadTrip(file);
  // The app replay unless a research option asks for the navigator alone (a later start, a fixed GNSS lag, a compass).
  const inApp = phoneOnly || (!(start > 0) && !lag && !compassArg);
  const fresh = (): AppState => ({ store: new MemoryKeyValueStore(), vin: carOf(trip, new Map()), parkedAfter: null });
  const logged = inApp && startFrom === "phone" ? appStateFromLog(trip) : null;
  // A log without the stored state: the chain, as "parked".
  const chained = inApp && (startFrom === "parked" || (startFrom === "phone" && !logged));
  const state = !inApp ? null : logged ?? (chained ? appStateBefore(file) : fresh());
  // From the drawn start: its place and heading as the car's parked pose (and phone-only's own), nothing else kept.
  const drawnPose = inApp && startFrom === "drawn" ? drawnStartPose(trip, readDrawn(file)) : null;
  // Phone-only: the driver follows the routes the app planned, or the drawn one where they didn't (app-chain.ts).
  const phoneRoute = phoneOnly ? phoneRouteFor(trip, readDrawn(file)) : null;
  if (state && drawnPose) {
    const cal = new CalibrationStore(state.store, phoneOf(trip));
    if (state.vin) cal.saveParkedPose(state.vin, drawnPose);
    cal.saveParkedPose(PHONE_CAR, drawnPose);
  }
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
    const mainNav = navFor({});
    const compareNav = compareLoop ? navFor(compareLoop.nav) : null;
    // The main replay's dots, for the incidents against the drawing.
    let mainPublished: { timestampUs: number; latDeg: number; lonDeg: number; headingRad: number }[] | null = null;
    let mainFixes: { t: number; lat: number; lon: number; hAccM: number }[] = [];
    // Through the app: the service publishes the dot, starts from the stored parked pose, and runs the outages.
    const replay = (o: ReplayOptions) => {
      const run = () => replayTripInApp(obdSpeed ? obdFromCan(trip) : trip, {
        calibration: new CalibrationStore(state!.store.copy(), phoneOf(trip)),
        roadGraph: opened ? { key: graphFile!, region: path.basename(graphFile!, ".graph.bin"), graph: opened.graph } : null,
        vin: state!.vin,
        cuts: o.cuts ?? [],
        jam: o.jam,
        openLoop: o.openLoop,
        trackStepS: o.trackStepS,
        mapMatch: { particlesEveryS: o.mapMatch?.particlesEveryS },
        placings: q("placings") !== "off",
        ...(gyroTurns ? { wheelYaw: false } : {}),
        // The routes the driver had, as the app gives them to the service (the dot leans on them, puck.ts).
        ...(phoneOnly ? {} : { phoneRoutes: phoneRouteFor(trip, null).routes }),
        ...(phoneOnly
          ? {
              phoneOnly: {
                openGraph: () => {
                  const g = graphFor(trip);
                  return g ? { key: g.active.key, graph: g.active.graph, close: g.close } : null;
                },
              },
              phoneRoutes: phoneRoute?.routes ?? [],
            }
          : {}),
      });
      const r = o.nav === compareNav && compareLoop === BEFORE_DOT ? withDotBefore(run) : run();
      if (o.nav === mainNav) {
        mainPublished = r.published;
        mainFixes = r.fixes.filter((f) => f.satellite && f.status === "accepted").map((f) => ({ t: f.tS, lat: f.fix.lat, lon: f.fix.lon, hAccM: f.fix.hAccM }));
      }
      return r;
    };
    const data = buildViewerData(file, trip, { ...common, nav: mainNav }, {
      appCuts,
      ...(inApp ? { replay } : {}),
      phoneOnly,
      ...(compareLoop && compareNav ? { compare: { label: compareLoop.label, options: { ...common, nav: compareNav } } } : {}),
    });
    // What a driver would see go wrong (incidents.ts), against the drawing: each with its time, to jump to.
    const drawnNow = readDrawn(file);
    const found =
      drawnNow && drawnNow.path.length > 1 && mainPublished
        ? findIncidents(
            drawnTruthTrack(trip, drawnNow, INCIDENT_STEP_S),
            (mainPublished as { timestampUs: number; latDeg: number; lonDeg: number; headingRad: number }[])
              .filter((p) => Number.isFinite(p.latDeg))
              .map((p) => ({ t: (p.timestampUs - trip.startUs) / 1e6, lat: p.latDeg, lon: p.lonDeg, headingRad: Number.isFinite(p.headingRad) ? p.headingRad : undefined })),
            mainFixes,
          )
        : null;
    const incidents = found ? { list: found.incidents, coverage: found.coverage, unjudged: found.unjudged ?? null } : null;
    const compassInfo = compassArg ? { logs: compass?.logs ?? 0, rotateDeg, trust: data.summary.compass.trust } : null;
    const startNote =
      startFrom === "drawn" ? (drawnPose ? "drawn" : "no drawing: cold") : startFrom === "phone" && inApp ? (logged ? "phone" : "phone-missing") : null;
    // A route guided along before its plan reached the log: planned again and drawn as the plan then (reason
    // "rebuilt"), so the map has the route the driver followed.
    const rebuilt = routeBeforeLog(trip, readDrawn(file) ? drawnStartPose(trip, readDrawn(file)) : null);
    if (rebuilt) {
      data.routes.plans.unshift({
        t: 0, id: 0, reason: "rebuilt", status: "done", lengthM: rebuilt.lengthM, durationS: null, planMs: 0, wallMs: 0, states: 0, slices: 0,
        points: rebuilt.points.map((q): [number, number] => [Math.round(q.lat * 1e6) / 1e6, Math.round(q.lon * 1e6) / 1e6]),
        maneuvers: [],
      });
    }
    reply = { status: 200, type: "application/json", body: JSON.stringify({ ...data, incidents, compassInfo, placings: driverPlacings(trip).map((p) => ({ t: Math.round((p.tUs - trip.startUs) / 1e5) / 10, lat: p.lat, lon: p.lon, headingRad: p.headingRad })), odo: odometryTrack(trip), startNote, phoneRouteSource: phoneRoute?.source ?? null, appCuts: appCuts.length, parkedFrom: state && chained ? { file: state.parkedAfter, status: data.summary.startPose?.status ?? null } : null, inApp }) };
  } finally {
    opened?.close();
  }
  console.log(`replayed ${file} in ${Date.now() - started} ms`);
  return reply;
}

// ---------- the replay worker ----------
// One worker replays, and keeps its caches (the earlier drives replayed for a parked start, the compass learned on
// the other logs) from one replay to the next. A new replay request while one runs, or the page closing the request,
// terminates it and starts a fresh worker: replays are synchronous, and only a worker can be stopped mid-way.
let replayWorker: Worker | null = null;
let replayJob: { id: number; worker: Worker; resolve: (r: Reply) => void } | null = null;
let replaySeq = 0;
const CANCELLED: Reply = { status: 499, type: "text/plain", body: "cancelled: another replay was asked for" };

function startReplayWorker(): Worker {
  const w = new Worker(fileURLToPath(import.meta.url), { workerData: { role: "replay" }, argv: process.argv.slice(2) });
  w.on("message", (m: Reply & { id: number }) => {
    if (replayJob?.id !== m.id) return;
    const job = replayJob;
    replayJob = null;
    job.resolve({ status: m.status, type: m.type, body: m.body });
  });
  // A worker that failed or died fails its own job only: one terminated on purpose has none left.
  const lost = (why: string) => {
    if (replayWorker === w) replayWorker = null;
    if (replayJob?.worker === w) {
      const job = replayJob;
      replayJob = null;
      job.resolve({ status: 500, type: "text/plain", body: `the replay worker ${why}` });
    }
  };
  w.on("error", (e) => lost(`failed: ${errorText(e)}`));
  w.on("exit", (code) => code !== 0 && lost(`exited (${code})`));
  return w;
}

/** Stops the replay running (only `id`'s, when given): its request gets "cancelled", the worker starts afresh. */
function cancelReplay(id?: number): void {
  if (!replayJob || (id !== undefined && replayJob.id !== id)) return;
  const job = replayJob;
  replayJob = null;
  job.resolve(CANCELLED);
  const w = replayWorker;
  replayWorker = null;
  void w?.terminate();
  console.log("replay cancelled");
}

function runReplay(href: string): { id: number; reply: Promise<Reply> } {
  cancelReplay();
  replayWorker ??= startReplayWorker();
  const id = ++replaySeq;
  const reply = new Promise<Reply>((resolve) => {
    replayJob = { id, worker: replayWorker!, resolve };
    replayWorker!.postMessage({ id, href });
  });
  return { id, reply };
}

if (!isMainThread && (workerData as { role?: string } | null)?.role === "replay") {
  parentPort!.on("message", ({ id, href }: { id: number; href: string }) => {
    let r: Reply;
    try {
      r = replayReply(new URL(href));
    } catch (error) {
      console.error(error);
      r = { status: 500, type: "text/plain", body: errorText(error) };
    }
    parentPort!.postMessage({ id, ...r });
  });
}

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname === "/") {
      send(res, 200, "text/html; charset=utf-8", readFileSync(path.join(HERE, "index.html")));
    } else if (url.pathname === "/api/style/dark") {
      // The basemap in dark mode as the app draws it: OpenFreeMap Liberty re-tinted by the app's own palette.
      darkStyle()
        .then((style) => send(res, 200, "application/json", JSON.stringify(style)))
        .catch((error: unknown) => send(res, 502, "text/plain", `the dark map style: ${errorText(error)}`));
    } else if (url.pathname === "/api/logs") {
      send(res, 200, "application/json", JSON.stringify(listLogs()));
    } else if (url.pathname === "/api/replay") {
      // In the replay worker: a newer replay, or the page giving up on this one, stops it at once.
      const job = runReplay(url.href);
      res.on("close", () => {
        if (!res.writableEnded) cancelReplay(job.id);
      });
      void job.reply.then((r) => {
        if (!res.writableEnded && !res.destroyed) send(res, r.status, r.type, r.body);
      });
    } else if (url.pathname === "/api/roads") {
      const file = logParam(url);
      if (!file) return send(res, 400, "text/plain", "file must be a .ulg in the logs folder");
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
      const file = logParam(url);
      if (!file) return send(res, 400, "text/plain", "file must be a .ulg in the logs folder");
      const started = Date.now();
      const trip = loadTrip(file);
      const first = trip.gnss.find((f) => f.hAccM <= 10);
      const graphFile = first ? (GRAPH ?? findGraph(first)) : null;
      const empty = { type: "FeatureCollection", features: [] };
      const payload = graphFile ? truthRoute(graphFile, trip) : { graph: null, legs: empty, breaks: empty, summary: { fixes: 0, matched: 0, breaks: 0 } };
      send(res, 200, "application/json", JSON.stringify(payload));
      const s = payload.summary;
      console.log(`truth for ${file}: ${s.matched} of ${s.fixes} clean fixes matched, ${s.breaks} breaks, ${Date.now() - started} ms`);
    } else if (url.pathname === "/api/delete") {
      // Junk logs: the log and everything named after it go, listed so the next `logs:push` deletes them from the
      // bucket too (tools/triplog/deleted.ts). POST only, asked twice on the page.
      const file = logParam(url);
      if (!file) return send(res, 400, "text/plain", "file must be a .ulg in the logs folder");
      if (req.method !== "POST") return send(res, 405, "text/plain", "POST");
      if (lastTrip?.file === file) lastTrip = null;
      // The replay worker's caches (earlier drives replayed for a parked start) may hold this log: start it afresh.
      cancelReplay();
      void replayWorker?.terminate();
      replayWorker = null;
      const keys = deleteLog(LOG_DIR, file);
      console.log(`deleted ${keys.join(", ")}`);
      send(res, 200, "application/json", JSON.stringify({ deleted: keys }));
    } else if (url.pathname === "/api/drawn") {
      // Ground truth drawn by hand: GET it, POST the clicked points (the server lays the path on the roads and saves
      // it), DELETE it.
      const file = logParam(url);
      if (!file) return send(res, 400, "text/plain", "file must be a .ulg in the logs folder");
      const trip = loadTrip(file);
      if (req.method === "GET") return send(res, 200, "application/json", JSON.stringify(drawnPayload(trip, readDrawn(file))));
      if (req.method === "DELETE") {
        if (existsSync(drawnFile(file))) unlinkSync(drawnFile(file));
        return send(res, 200, "application/json", JSON.stringify(drawnPayload(trip, null)));
      }
      if (req.method !== "POST") return send(res, 405, "text/plain", "GET, POST or DELETE");
      readBody(req)
        .then((body) => {
          const points = (JSON.parse(body) as { points?: unknown }).points;
          if (!Array.isArray(points) || !points.every(isPoint) || points.length > 5000) return send(res, 400, "text/plain", "points: [{lat, lon, straight?, free?}]");
          const clean = points.map((p) => ({ lat: p.lat, lon: p.lon, ...(p.straight ? { straight: true } : {}), ...(p.free ? { free: true } : {}) }));
          if (!clean.length) {
            if (existsSync(drawnFile(file))) unlinkSync(drawnFile(file));
            return send(res, 200, "application/json", JSON.stringify(drawnPayload(trip, null)));
          }
          const started = Date.now();
          const g = graphForDrawing(trip);
          const frame = new LocalFrame(clean[0]);
          g?.graph.setFrame(frame);
          const drawn = drawPath(g?.graph ?? null, frame, clean);
          const truth: DrawnTruth = { version: 1, file, points: clean, ...drawn, graph: g ? `${path.basename(g.file)} (OSM ${g.graph.info.osmDate})` : null, updatedAt: new Date().toISOString() };
          writeFileSync(drawnFile(file), JSON.stringify(truth));
          send(res, 200, "application/json", JSON.stringify(drawnPayload(trip, truth)));
          console.log(`drawn truth for ${file}: ${clean.length} points, ${(truth.legs.reduce((m, l) => m + l.lengthM, 0) / 1000).toFixed(2)} km in ${Date.now() - started} ms`);
        })
        .catch((error: unknown) => {
          console.error(error);
          send(res, 500, "text/plain", errorText(error));
        });
    } else {
      send(res, 404, "text/plain", "not found");
    }
  } catch (error) {
    console.error(error);
    send(res, 500, "text/plain", errorText(error));
  }
});

// The replay worker loads this file too: only the main thread serves.
if (isMainThread) {
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
}
