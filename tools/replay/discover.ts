// Discovery (VEHICLE-LINK-SPEC §16.6) on recorded drives: the app's search for a speed field among the ids the log's
// monitor heard (src/nav/odometry/can/discovery.ts), fed the frames and the OBD polls in time order, as if the car
// had no profile. Only stretches with both count: a log made with CAN primary has OBD speed only while standing.
//
//   npm run replay:discover -- tools/triplog/logs/*.ulg
//   npm run replay:discover -- trip.ulg --ids 228,82,78      # only these ids (hex), as one batch
import { readFileSync } from "node:fs";
import path from "node:path";

import { fieldKey, SpeedFieldFinder, tidy } from "../../src/nav/odometry/can/discovery";
import { retimeFrames } from "../../src/nav/odometry/can/frame-timing";
import { busTimedFrames } from "../../src/nav/replay/can";
import { readTripLog } from "../../src/triplog/trip-log-reader";

const args = process.argv.slice(2);
const idsAt = args.indexOf("--ids");
const only = idsAt >= 0 ? args[idsAt + 1].split(",").map((h) => parseInt(h, 16)) : null;
const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--ids");
if (!files.length) {
  console.error("usage: npm run replay:discover -- <logs>");
  process.exit(1);
}

for (const file of files) {
  const name = path.basename(file);
  let trip;
  try {
    trip = readTripLog(new Uint8Array(readFileSync(file)));
  } catch (e) {
    console.log(`${name}: unreadable (${(e as Error).message})`);
    continue;
  }
  if (!trip.can?.length) continue;
  const frames = retimeFrames(busTimedFrames(trip), trip.canWindows ?? []).filter((f) => !only || only.includes(f.id));
  const ids = [...new Set(frames.map((f) => f.id))];
  const obd = trip.obdSpeed.filter((s) => s.source !== "can");
  const finder = new SpeedFieldFinder(ids);
  let i = 0;
  let readyS: number | null = null;
  let verdict: ReturnType<SpeedFieldFinder["judge"]> = null;
  // Judged when the app would: as soon as the batch is ready.
  for (const f of frames) {
    while (i < obd.length && obd[i].tUs <= f.tUs) {
      finder.addObd(obd[i].tUs, obd[i].rawKph);
      i++;
    }
    finder.addFrame(f.id, f.tUs, f.data);
    verdict = finder.judge();
    if (verdict) {
      readyS = (f.tUs - trip.startUs) / 1e6;
      break;
    }
  }
  const d = verdict?.found ?? null;
  const head = `${name} ids ${ids.map((id) => id.toString(16)).join(" ")}`;
  if (!d) console.log(`${head}: nothing found${readyS === null ? " (no verdict by the log's end)" : ""}`);
  else
    console.log(
      `${head}: ${d.id.toString(16)} ${d.fields.length} field(s) ${tidy(d.fields).map((f) => `${fieldKey(f)} r ${f.r.toFixed(4)}`).join(", ")}; ` +
        `${d.pairs} pairs, range ${d.rangeKph.toFixed(0)} km/h, decided at ${readyS?.toFixed(0) ?? "-"} s`,
    );
}
