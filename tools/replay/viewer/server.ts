// Local trip replay viewer: `npm run replay:view` → http://127.0.0.1:5174
// Serves index.html, lists tools/triplog/logs/*.ulg, replays one on request, and serves the
// road graph around it (tools/tiles/out/release/*.graph.bin, or --graph <file>).
// Bound to localhost only: the logs hold the VIN and GPS tracks.

import { exec } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildViewerData } from "../../../src/nav/replay/viewer-data";
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
      const lag = url.searchParams.get("lag");
      const openLoop = url.searchParams.get("openLoop");
      const start = Number(url.searchParams.get("start") || 0);
      const jam = parseCuts(url.searchParams.get("jam"));
      const started = Date.now();
      const trip = loadTrip(file);
      // Map matching on the trip's road graph, when there is one.
      const first = trip.gnss.find((f) => f.hAccM <= 500);
      const graphFile = first ? (GRAPH ?? findGraph(first)) : null;
      const opened = graphFile && first ? openGraph(graphFile, first) : null;
      try {
        const data = buildViewerData(file, trip, {
          cuts: parseCuts(url.searchParams.get("cuts")),
          nav: lag ? { gnssLagS: Number(lag), estimateGnssLag: false } : {},
          openLoop: openLoop ? { delayS: Number(openLoop) } : undefined,
          ...(opened ? { mapMatch: { graph: opened.graph } } : {}),
          ...(start > 0 ? { startAtS: start } : {}),
          ...(jam.length ? { jam } : {}),
        });
        send(res, 200, "application/json", JSON.stringify(data));
      } finally {
        opened?.close();
      }
      console.log(`replayed ${file} in ${Date.now() - started} ms`);
    } else if (url.pathname === "/api/roads") {
      const file = path.basename(url.searchParams.get("file") ?? "");
      if (!file.endsWith(".ulg")) return send(res, 400, "text/plain", "file must be a .ulg in the logs folder");
      const started = Date.now();
      const points = loadTrip(file).gnss.filter((f) => f.hAccM <= 500);
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
