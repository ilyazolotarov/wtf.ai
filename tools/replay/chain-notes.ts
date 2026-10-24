/**
 * Every drive through the app on one storage, in order (regress's "parked" chain), printing the service notes that
 * match a pattern: how often a path of the service fires on real drives, before a regress run says what it changed.
 *
 *   npm run replay:chain-notes -- "parked pose (kept|not saved)|nav restart"
 *   npm run replay:chain-notes -- "parked pose" --testers
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appOutageCuts } from "../../src/nav/replay/replay";
import { MemoryKeyValueStore, phoneOf, replayTripInApp } from "../../src/services/navigation/app-replay";
import { CalibrationStore } from "../../src/services/navigation/calibration-store";
import { readTripLog } from "../../src/triplog/trip-log-reader";
import { carOf, graphFor, phoneRouteFor } from "./app-chain";

const LOGS = path.join(path.dirname(fileURLToPath(import.meta.url)), "../triplog/logs");
const args = process.argv.slice(2);
const pattern = new RegExp(args.find((a) => !a.startsWith("--")) ?? "parked pose");

const own = readdirSync(LOGS).filter((f) => f.endsWith(".ulg")).sort();
const chains: string[][] = [own];
if (args.includes("--testers")) {
  for (const d of readdirSync(path.join(LOGS, "testers"), { withFileTypes: true }).filter((d) => d.isDirectory())) {
    chains.push(readdirSync(path.join(LOGS, "testers", d.name)).filter((f) => f.endsWith(".ulg")).sort().map((f) => `testers/${d.name}/${f}`));
  }
}

let matched = 0;
for (const logs of chains) {
  // One phone's storage across its drives, as the app keeps it.
  const store = new MemoryKeyValueStore();
  const byProtocol = new Map<string, string>();
  for (const log of logs) {
    const trip = readTripLog(new Uint8Array(readFileSync(path.join(LOGS, log))));
    const vin = carOf(trip, byProtocol);
    const graph = graphFor(trip);
    try {
      const r = replayTripInApp(trip, {
        calibration: new CalibrationStore(store, phoneOf(trip)),
        roadGraph: graph?.active,
        vin,
        cuts: appOutageCuts(trip),
        phoneRoutes: phoneRouteFor(trip, null).routes,
      });
      const hits = r.notes.filter((n) => pattern.test(n.text));
      matched += hits.length;
      for (const n of hits) console.log(`${log} +${((n.tUs - trip.startUs) / 1e6).toFixed(1)} s: ${n.text}`);
    } finally {
      graph?.close();
    }
  }
}
console.log(`${matched} matching notes over ${chains.reduce((n, c) => n + c.length, 0)} drives`);
