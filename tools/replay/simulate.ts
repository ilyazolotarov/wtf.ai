// Hours of simulated city driving without GPS (MAPMATCH-SPEC §9.4): random routes on a real road
// graph (src/nav/sim/city-drive.ts), GPS for the first minutes, then none to the end. Each
// navigator version is scored against the exact truth every second.
//
//   npm run replay:sim                                   # Chernihiv, 60 min, seeds 1–3, open vs closed loop
//   npm run replay:sim -- --minutes 180 --seeds 2 --imu-hz 50
//   npm run replay:sim -- --at 50.4501,30.5234 --graph tools/tiles/out/release/kyiv-city.graph.bin

import path from "node:path";

import { haversineM, type Coordinate } from "../../src/nav/geo";
import { LocalFrame } from "../../src/nav/geo/local-frame";
import type { MapMatchConfig } from "../../src/nav/mapmatch/particle-filter";
import type { NavConfig } from "../../src/nav/navigator";
import { replayShownTrack } from "../../src/nav/replay/drive-report";
import { replayTrip } from "../../src/nav/replay/replay";
import { cityDrive } from "../../src/nav/sim/city-drive";
import { findGraph, openGraph } from "./graph-file";

function parseArgs(argv: string[]) {
  let at: Coordinate = { lat: 51.4939, lon: 31.2947 }; // Chernihiv centre
  let graph: string | undefined;
  let minutes = 60;
  let seeds = 3;
  let loops: NavConfig["mapMatchLoop"][] = ["open", "closed"];
  let gpsMin = 3;
  let imuHz = 100;
  let bucketMin = 10;
  let route: "city" | "arterial" = "city";
  let trace = false;
  let nav: Partial<NavConfig> = {};
  let mmConfig: Partial<MapMatchConfig> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--at") {
      const [lat, lon] = argv[++i].split(",").map(Number);
      at = { lat, lon };
    } else if (a === "--graph") graph = argv[++i];
    else if (a === "--minutes") minutes = Number(argv[++i]);
    else if (a === "--seeds") seeds = Number(argv[++i]);
    else if (a === "--loops") loops = argv[++i].split(",") as NavConfig["mapMatchLoop"][];
    else if (a === "--gps-min") gpsMin = Number(argv[++i]);
    else if (a === "--imu-hz") imuHz = Number(argv[++i]);
    else if (a === "--every") bucketMin = Number(argv[++i]);
    else if (a === "--route") route = argv[++i] as "city" | "arterial";
    else if (a === "--trace") trace = true;
    else if (a === "--nav") nav = JSON.parse(argv[++i]) as Partial<NavConfig>;
    else if (a === "--mm-config") mmConfig = JSON.parse(argv[++i]) as Partial<MapMatchConfig>;
    else if (a === "-h" || a === "--help") {
      console.log("replay:sim [--at lat,lon] [--graph <file>] [--minutes 60] [--seeds 3] [--loops open,heading,closed] [--gps-min 3] [--imu-hz 100] [--every 10] [--route city|arterial] [--trace] [--nav '<json NavConfig>'] [--mm-config '<json>']");
      process.exit(0);
    }
  }
  return { at, graph, minutes, seeds, loops, gpsMin, imuHz, bucketMin, route, trace, nav, mmConfig };
}

const quantile = (v: number[], q: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
};
const m = (v: number) => (Number.isFinite(v) ? `${v < 10 ? v.toFixed(1) : Math.round(v)} m` : "—");

const args = parseArgs(process.argv.slice(2));
const graphFile = args.graph ?? findGraph(args.at);
if (!graphFile) throw new Error("no road graph covers --at: build one with `tiles graph <region>`, or pass --graph");
console.log(
  `${path.basename(graphFile)} at ${args.at.lat},${args.at.lon}: ${args.minutes} min drives, seeds 1–${args.seeds}, ` +
    `GPS for the first ${args.gpsMin} min, then none; IMU ${args.imuHz} Hz; ${args.route} routes`,
);

/** Per loop: [minutes since the cut, dot error m][] pooled over seeds, and per-seed summaries. */
const pooled = new Map<string, { t: number; dot: number; ekf: number }[]>(args.loops.map((l) => [l, []]));
for (let seed = 1; seed <= args.seeds; seed++) {
  const frame = new LocalFrame(args.at);
  const simGraph = openGraph(graphFile, args.at);
  const started = performance.now();
  const drive = cityDrive({ graph: simGraph.graph, frame, durationS: args.minutes * 60, seed, imuHz: args.imuHz, route: args.route });
  simGraph.close();
  const cutS = 20 + args.gpsMin * 60;
  console.log(
    `\nseed ${seed}: ${(drive.distanceM / 1000).toFixed(1)} km, ${drive.junctions} junctions, ${drive.turns} turns ` +
      `(one per ${(drive.distanceM / Math.max(1, drive.turns) / 1000).toFixed(1)} km), ${drive.stopsMade} stops ` +
      `(generated in ${((performance.now() - started) / 1000).toFixed(1)} s)`,
  );
  for (const loop of args.loops) {
    const navGraph = openGraph(graphFile, args.at);
    const t0 = performance.now();
    const result = replayTrip(drive.trip, {
      nav: { ...args.nav, mapMatchLoop: loop },
      mapMatch: { graph: navGraph.graph, config: args.mmConfig },
      cuts: [{ fromS: cutS, toS: Infinity }],
      trackStepS: 1,
    });
    navGraph.close();
    const shown = replayShownTrack(result);
    const rows: { t: number; dot: number; ekf: number; along: number; across: number; kph: number }[] = [];
    for (let i = 0; i < result.track.length; i++) {
      const p = result.track[i];
      if (p.tS < cutS) continue;
      const truth = drive.truthAt(drive.trip.startUs + p.tS * 1e6);
      // The dot's error along the car's direction (ahead +) and across it (right +).
      const [de, dn] = frame.toEnu(shown[i]);
      const [te, tn] = frame.toEnu(truth);
      const along = (de - te) * Math.sin(truth.psi) + (dn - tn) * Math.cos(truth.psi);
      const across = (de - te) * Math.cos(truth.psi) - (dn - tn) * Math.sin(truth.psi);
      rows.push({ t: (p.tS - cutS) / 60, dot: haversineM(shown[i], truth), ekf: haversineM(p, truth), along, across, kph: truth.speedMps * 3.6 });
    }
    if (args.trace) {
      for (let k = 0; k < rows.length; k += 300) {
        const r = rows[k];
        console.log(`    ${loop} ${r.t.toFixed(0).padStart(4)} min: dot ${m(r.dot)} (along ${r.along.toFixed(0)} m, across ${r.across.toFixed(0)} m), navigator ${m(r.ekf)}, ${r.kph.toFixed(0)} km/h`);
      }
    }
    pooled.get(loop)!.push(...rows);
    // Lost: the dot more than 50 m off; the longest such stretch, and the share of time.
    let longest = 0;
    let run = 0;
    for (const r of rows) {
      run = r.dot > 50 ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    const dots = rows.map((r) => r.dot);
    const s = result.summary;
    console.log(
      `  ${loop.padEnd(7)} dot median ${m(quantile(dots, 0.5))}, p90 ${m(quantile(dots, 0.9))}, max ${m(Math.max(...dots))}, ` +
        `along / across median ${m(quantile(rows.map((r) => Math.abs(r.along)), 0.5))} / ${m(quantile(rows.map((r) => Math.abs(r.across)), 0.5))}` +
        ` (across > 15 m ${((100 * rows.filter((r) => Math.abs(r.across) > 15).length) / Math.max(1, rows.length)).toFixed(1)} %), ` +
        `navigator median ${m(quantile(rows.map((r) => r.ekf), 0.5))}, ` +
        `end ${m(dots.at(-1) ?? NaN)}; > 50 m ${((100 * dots.filter((d) => d > 50).length) / Math.max(1, dots.length)).toFixed(1)} % ` +
        `(longest ${Math.round(longest / 60)} min); road corrections ${s.roadHeading.accepted} + ${s.roadPosition.accepted}` +
        ` (refused ${s.roadHeading.rejected + s.roadPosition.rejected}); ${((performance.now() - t0) / 1000).toFixed(0)} s`,
    );
  }
}

console.log(`\nDot error by time without GPS (all seeds): median / p90 / max per ${args.bucketMin} min`);
const buckets = Math.ceil(args.minutes / args.bucketMin);
console.log(`${"minutes".padEnd(10)}${args.loops.map((l) => l.padStart(30)).join("")}`);
for (let b = 0; b < buckets; b++) {
  const from = b * args.bucketMin;
  const cells = args.loops.map((l) => {
    const d = pooled.get(l)!.filter((r) => r.t >= from && r.t < from + args.bucketMin).map((r) => r.dot);
    return d.length ? `${m(quantile(d, 0.5))} / ${m(quantile(d, 0.9))} / ${m(Math.max(...d))}`.padStart(30) : "—".padStart(30);
  });
  console.log(`${`${from}–${from + args.bucketMin}`.padEnd(10)}${cells.join("")}`);
}
