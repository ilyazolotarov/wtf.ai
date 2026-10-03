// Local trip replay viewer: `npm run replay:view` → http://127.0.0.1:5174
// Serves index.html, lists tools/triplog/logs/*.ulg, and replays one on request.
// Bound to localhost only: the logs hold the VIN and GPS tracks.

import { exec } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildViewerData } from "../../../src/nav/replay/viewer-data";
import { readTripLog } from "../../../src/triplog/trip-log-reader";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const LOG_DIR = path.resolve(flag("--logs") ?? path.join(HERE, "../../triplog/logs"));
const PORT = Number(flag("--port") ?? 5174);

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
    .map((c) => c.split(":").map(Number))
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > 0)
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
      const started = Date.now();
      const trip = readTripLog(new Uint8Array(readFileSync(path.join(LOG_DIR, file))));
      const data = buildViewerData(file, trip, {
        cuts: parseCuts(url.searchParams.get("cuts")),
        nav: lag ? { gnssLagS: Number(lag), estimateGnssLag: false } : {},
        openLoop: openLoop ? { delayS: Number(openLoop) } : undefined,
      });
      send(res, 200, "application/json", JSON.stringify(data));
      console.log(`replayed ${file} in ${Date.now() - started} ms`);
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
