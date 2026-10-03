// Replay trip logs through src/nav (SPEC §3.10). Usage: see tools/replay/README.md.

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import { replayToGeoJson } from "../../src/nav/replay/geojson";
import { replayTrip, type ReplayCut, type ReplayResult } from "../../src/nav/replay/replay";
import { readTripLog, type TripLog } from "../../src/triplog/trip-log-reader";

interface Args {
  files: string[];
  cuts: ReplayCut[];
  lagS?: number;
  sweepLag: boolean;
  geojson?: string;
  json: boolean;
  openLoopDelayS?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { files: [], cuts: [], sweepLag: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cut") {
      const [from, len] = argv[++i].split(":").map(Number);
      args.cuts.push({ fromS: from, toS: from + len });
    } else if (a === "--lag") args.lagS = Number(argv[++i]);
    else if (a === "--sweep-lag") args.sweepLag = true;
    else if (a === "--geojson") args.geojson = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--open-loop") {
      // Optional delay: `--open-loop 60`; a following flag or file means no delay.
      const next = argv[i + 1];
      args.openLoopDelayS = next !== undefined && /^\d+(\.\d+)?$/.test(next) ? Number(argv[++i]) : 0;
    }
    else if (a === "-h" || a === "--help") {
      console.log(
        "replay <trip.ulg...> [--cut <startS>:<lengthS>]... [--open-loop [delayS]] [--lag <s>] [--sweep-lag] [--geojson <out>] [--json]",
      );
      process.exit(0);
    } else args.files.push(a);
  }
  if (!args.files.length) throw new Error("no trip log given (see --help)");
  return args;
}

const m = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${Math.round(v)} m`);

function print(name: string, trip: TripLog, r: ReplayResult): void {
  const s = r.summary;
  const f = s.fixes;
  console.log(`== ${name}  (${s.durationS.toFixed(0)} s, OBD ${(s.obdDistanceM / 1000).toFixed(2)} km, VIN ${trip.info.vehicle_vin || "—"})`);
  console.log(
    `  init:     ${s.init ? `${s.init.method} at ${s.init.tS.toFixed(0)} s` : "never (no course and not enough spread in coarse fixes)"}`,
  );
  console.log(
    `  fixes:    ${f.total} (${f.satellite} satellite) — accepted ${f.accepted}, rejected ${f.rejected}, anchored ${f.anchored}, skipped ${f.skipped}, cut ${f.cut}`,
  );
  console.log(
    `  pre-fix error (median): satellite ${m(s.medianErrorM.satellite)}, coarse ${m(s.medianErrorM.coarse)}` +
      (s.coarseInsideAccuracy === null ? "" : `; coarse fixes within their accuracy: ${(s.coarseInsideAccuracy * 100).toFixed(0)} %`),
  );
  if (s.params) {
    console.log(
      `  params:   speed scale ${s.params.speedScale.toFixed(4)}, gyro bias ${s.params.gyroBiasDegS.toFixed(4)} °/s, gyro scale ${s.params.gyroScale.toFixed(4)}`,
    );
  }
  console.log(
    `  gnss lag: ${s.gnssLag ? `${s.gnssLag.lagS.toFixed(2)} s measured (${s.gnssLag.windows} turn windows, fit ${s.gnssLag.rmsM.toFixed(1)} m)` : "not measured (needs turns with satellite fixes)"}`,
  );
  console.log(`  imu invalid ${s.imuInvalidS.toFixed(0)} s, standstill ${s.standstillS.toFixed(0)} s, resets ${s.resets}`);
  for (const c of s.cuts) {
    console.log(
      `  ${c.openLoop ? "open loop" : "cut"} ${c.fromS.toFixed(0)}–${c.toS.toFixed(0)} s: ${(c.distanceM / 1000).toFixed(2)} km driven, ${c.truthFixes} truth fixes, error max ${m(c.maxErrorM)} last ${m(c.lastErrorM)} (predicted σ ${m(c.meanSigmaM)})`,
    );
  }
  const last = r.track.at(-1);
  if (last) console.log(`  end:      ${last.mode}, ±${Math.round(last.accuracyM)} m`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  for (const file of args.files) {
    const trip = readTripLog(new Uint8Array(readFileSync(file)));
    const name = basename(file);
    if (args.sweepLag) {
      console.log(`== ${name}: median pre-fix error of satellite fixes by GNSS lag`);
      for (let lag = 0; lag <= 2.001; lag += 0.25) {
        const r = replayTrip(trip, { nav: { gnssLagS: lag, estimateGnssLag: false }, cuts: args.cuts });
        console.log(`  lag ${lag.toFixed(2)} s: ${m(r.summary.medianErrorM.satellite)} (${r.summary.fixes.accepted} accepted)`);
      }
      continue;
    }
    const result = replayTrip(trip, {
      nav: args.lagS === undefined ? {} : { gnssLagS: args.lagS, estimateGnssLag: false },
      cuts: args.cuts,
      openLoop: args.openLoopDelayS === undefined ? undefined : { delayS: args.openLoopDelayS },
    });
    if (args.json) console.log(JSON.stringify({ file: name, ...result.summary }, null, 2));
    else print(name, trip, result);
    if (args.geojson) {
      const out = args.files.length > 1 ? args.geojson.replace(/(\.geojson)?$/, `.${name.replace(/\.ulg$/, "")}.geojson`) : args.geojson;
      writeFileSync(out, JSON.stringify(replayToGeoJson(result)));
      console.log(`  geojson:  ${out}`);
    }
  }
}

main();
