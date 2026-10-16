// Simulated drives across Kyiv for the navigator's stress test (MAPMATCH-SPEC §9.4, §10.3): trips from one side of
// the city to the other, each on the route the app's router plans, driven by the simulator (src/nav/sim/city-drive.ts:
// a driver's speeds, turns, lanes and stops; the phone's sensors with their measured errors), and saved as trip logs
// with their exact truth, once per GPS scenario:
//
//   gps      GPS all the way
//   lost     GPS gone from `CUT_S` on (jammed to nothing)
//   spoof    GPS from `CUT_S` on reports a place abroad, standing (the app must refuse it and drive on without)
//   jam      GPS from `CUT_S` on jammed as iOS reports it: Wi-Fi/cell-like fixes every 5–10 s, as far off and for as
//            long as on the real jammed drives (src/nav/replay/jam.ts `MEASURED_JAM`); `lost` has none at all
//   jamstart jammed from the first second, the car starting from where it was parked (the replays give the app that
//            parked pose, as after the drive before): the start the real jammed drives fail on
//   unmapped jamstart, and two short roads the car drives are missing from the navigator's map (`hidden` in the
//            .sim.json; hidden-roads.ts): the car leaves the map as real cars do through yards and lanes OSM lacks
//
// Next to each `<trip>-<scenario>.ulg` in tools/triplog/logs/synthetic/: `.truth.json` (the path, as the viewer draws
// truth) and `.sim.json` (where the car was every 0.2 s along that path: exact timing, for the incident check).
// The route is in the log as the app logs a plan, so replays give it to the dot as the app does.
//
//   npm run sim:drives                         # every trip, seed 1
//   npm run sim:drives -- --trips north-south --seeds 2-3
//   npm run replay:incidents -- tools/triplog/logs/synthetic/*.ulg
//   npm run replay:view -- --logs tools/triplog/logs/synthetic

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { haversineM, type Coordinate } from "../../src/nav/geo";
import { LocalFrame } from "../../src/nav/geo/local-frame";
import { jamFixes, MEASURED_JAM } from "../../src/nav/replay/jam";
import { spoofFixes } from "../../src/nav/replay/spoof";
import { planRoute, type RoutePlan } from "../../src/nav/routing/router";
import { cityDrive, type CityDrive } from "../../src/nav/sim/city-drive";
import type { GnssFix } from "../../src/nav/types";
import { TRIP_EVENTS } from "../../src/triplog/schema";
import { TripLogWriter } from "../../src/triplog/trip-log-writer";
import { findGraph, openGraph } from "./graph-file";
import { isMainThread, Pool, serveJobs, threadsArg } from "./pool";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../triplog/logs/synthetic");

/** From one side of the city to the other, through the centre or around it: long, with many kinds of junction. */
export const TRIPS: { name: string; from: Coordinate; to: Coordinate }[] = [
  { name: "north-south", from: { lat: 50.5135, lon: 30.4985 }, to: { lat: 50.3745, lon: 30.4585 } },
  { name: "northeast-southwest", from: { lat: 50.5105, lon: 30.6035 }, to: { lat: 50.4175, lon: 30.3705 } },
  { name: "west-east", from: { lat: 50.4585, lon: 30.3555 }, to: { lat: 50.4635, lon: 30.6435 } },
  { name: "southeast-northwest", from: { lat: 50.3955, lon: 30.6325 }, to: { lat: 50.5005, lon: 30.4205 } },
  { name: "south-centre-north", from: { lat: 50.3905, lon: 30.5105 }, to: { lat: 50.4655, lon: 30.5145 } },
  { name: "east-centre", from: { lat: 50.4405, lon: 30.6305 }, to: { lat: 50.4501, lon: 30.5234 } },
  { name: "centre-southwest", from: { lat: 50.4475, lon: 30.5235 }, to: { lat: 50.3785, lon: 30.4475 } },
  { name: "old-town-loop", from: { lat: 50.4655, lon: 30.5145 }, to: { lat: 50.4295, lon: 30.5395 } },
  { name: "obolon-pechersk", from: { lat: 50.5105, lon: 30.4985 }, to: { lat: 50.4265, lon: 30.5495 } },
  { name: "borshchahivka-darnytsia", from: { lat: 50.4235, lon: 30.3795 }, to: { lat: 50.4465, lon: 30.6265 } },
  { name: "vynohradar-holosiiv", from: { lat: 50.5055, lon: 30.4215 }, to: { lat: 50.3855, lon: 30.5085 } },
  { name: "left-bank", from: { lat: 50.4645, lon: 30.6455 }, to: { lat: 50.4135, lon: 30.6505 } },
  { name: "podil-teremky", from: { lat: 50.4645, lon: 30.5175 }, to: { lat: 50.3685, lon: 30.4685 } },
  { name: "sviatoshyn-troieshchyna", from: { lat: 50.4565, lon: 30.3605 }, to: { lat: 50.5175, lon: 30.6025 } },
  { name: "poznyaky-obolon", from: { lat: 50.3975, lon: 30.6345 }, to: { lat: 50.5125, lon: 30.4975 } },
  { name: "pechersk-lukianivka", from: { lat: 50.4275, lon: 30.5455 }, to: { lat: 50.4605, lon: 30.4815 } },
  { name: "solomianka-rusanivka", from: { lat: 50.4305, lon: 30.4685 }, to: { lat: 50.4385, lon: 30.5965 } },
  { name: "syrets-osokorky", from: { lat: 50.4805, lon: 30.4335 }, to: { lat: 50.3955, lon: 30.6155 } },
  { name: "kurenivka-vydubychi", from: { lat: 50.4885, lon: 30.4705 }, to: { lat: 50.4045, lon: 30.5645 } },
  // The store video's drive (scripts/store-screenshots.py): the emulator showed the dot flip after its T-junction turns.
  { name: "demo", from: { lat: 50.42992, lon: 30.517 }, to: { lat: 50.45235, lon: 30.51706 } },
];

export const SCENARIOS = ["gps", "lost", "spoof", "jam", "jamstart", "unmapped"] as const;
type Scenario = (typeof SCENARIOS)[number];

/** GPS goes wrong this long into the log (the car has stood `START_STOP_S` = 20 s and driven the rest). */
const CUT_S = 200;
const UTC_START_US = Date.UTC(2026, 9, 1, 9, 0, 0) * 1000;
const TRUTH_STEP_S = 0.2;
/** Where the planned route is logged: while the car still stands at the start. */
const PLAN_AT_S = 10;

interface Job {
  trip: string;
  seed: number;
}

function scenarioFixes(drive: CityDrive, scenario: Scenario): GnssFix[] {
  const { gnss, startUs } = drive.trip;
  if (scenario === "lost") return gnss.filter((f) => f.tUs - startUs < CUT_S * 1e6);
  if (scenario === "spoof") return spoofFixes(gnss, startUs, [{ fromS: CUT_S, toS: Infinity, kind: "outside" }]).fixes;
  if (scenario === "jam") return jamFixes(gnss, startUs, [{ fromS: CUT_S, toS: Infinity }], { ...MEASURED_JAM, seed: drive.distanceM | 0 });
  if (scenario === "jamstart" || scenario === "unmapped") return jamFixes(gnss, startUs, [{ fromS: 0, toS: Infinity }], { ...MEASURED_JAM, seed: drive.distanceM | 0 });
  return gnss;
}

function writeLog(drive: CityDrive, plan: RoutePlan, fixes: GnssFix[], info: Record<string, string | number>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const { trip } = drive;
  const w = new TripLogWriter({ write: (b) => chunks.push(b), close: () => undefined }, {
    startUs: trip.startUs,
    utcUs: UTC_START_US,
    info: { sys_name: "wtf.ai", ver_sw: "sim", start_reason: "engine", adapter_transport: "emulator", imu_frame: "xArbitraryZVertical", ...info },
  }, { maxBufferBytes: Number.MAX_SAFE_INTEGER });
  const utc = (tUs: number) => UTC_START_US + (tUs - trip.startUs);
  w.tripEvent(trip.startUs, TRIP_EVENTS.start);
  w.engineState(trip.startUs, 3);
  // Every record in time order, flushing as the app does.
  type Ev = { tUs: number; write: () => void };
  const events: Ev[] = [];
  for (const s of trip.imu) events.push({ tUs: s.tUs, write: () => w.imuMotion({ timestampUs: s.tUs, gyro: s.gyro, userAccel: s.userAccel, gravity: s.gravity, attitude: [1, 0, 0, 0] }) });
  for (const s of trip.obdSpeed) {
    events.push({
      tUs: s.tUs,
      write: () => w.obd({ timestampUs: s.tUs, latencyUs: 0, mode: 1, pid: 0x0d, status: 0, data: [s.rawKph ?? Math.round(s.speedMps * 3.6)], ecu: 0x7e8, value: s.speedMps }),
    });
  }
  for (const f of fixes) {
    events.push({
      tUs: f.tUs,
      write: () =>
        w.gnss({
          timestampUs: f.tUs, utcUs: utc(f.tUs), latDeg: f.lat, lonDeg: f.lon, altMslM: 170, altEllipsoidM: 200, hAccM: f.hAccM, vAccM: f.hAccM * 1.5,
          speedMps: f.speedMps ?? -1, speedAccMps: f.speedAccMps ?? NaN, courseRad: f.courseRad ?? NaN, courseAccRad: f.courseAccRad ?? NaN,
          deliveryDelayUs: 0, flags: 0,
        }),
    });
  }
  const planUs = trip.startUs + PLAN_AT_S * 1e6;
  events.push({
    tUs: planUs,
    write: () => {
      const from = plan.coordinates[0];
      const to = plan.coordinates.at(-1)!;
      w.navRoute({
        timestampUs: planUs, planId: 1, reason: "new", status: "done", fromLatDeg: from.lat, fromLonDeg: from.lon, fromHeadingRad: NaN,
        toLatDeg: to.lat, toLonDeg: to.lon, lengthM: plan.lengthM, durationS: plan.durationS, offStartM: plan.offRoadM.start, offEndM: plan.offRoadM.end,
        states: 0, tiles: 0, planMs: 0, wallMs: 0, slices: 1, points: plan.coordinates.length, maneuvers: 0, graphBuilt: 0,
      });
      plan.coordinates.forEach((c, index) => w.navRoutePoint({ timestampUs: planUs, planId: 1, index, latDeg: c.lat, lonDeg: c.lon }));
    },
  });
  events.sort((a, b) => a.tUs - b.tUs);
  for (const e of events) {
    e.write();
    w.tick(e.tUs, utc(e.tUs));
  }
  const endUs = events.at(-1)!.tUs;
  w.engineState(endUs, 2);
  w.tripEvent(endUs, TRIP_EVENTS.end);
  w.close();
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  return bytes;
}

/** The car's line as a path (points at least 1 m apart), and where on it the car was every `TRUTH_STEP_S`. */
function truthPath(drive: CityDrive) {
  const path: [number, number][] = [];
  const cum: number[] = [];
  const along: number[] = [];
  for (const p of drive.truth) {
    const last = path.at(-1);
    const d = last ? haversineM({ lat: last[0], lon: last[1] }, p) : 0;
    if (!last || d >= 1) {
      path.push([p.lat, p.lon]);
      cum.push((cum.at(-1) ?? 0) + d);
    }
    along.push(cum.at(-1)!);
  }
  const startUs = drive.trip.startUs;
  const timeline: [number, number][] = [];
  const endS = (drive.truth.at(-1)!.tUs - startUs) / 1e6;
  for (let t = 0; t <= endS + 1e-9; t += TRUTH_STEP_S) {
    const i = Math.min(drive.truth.length - 1, Math.round(t * 10));
    timeline.push([Math.round(t * 10) / 10, Math.round(along[i] * 10) / 10]);
  }
  return { path, timeline };
}

/** Two short roads of the route, a third and two thirds along it, not its first or last: the map won't have them. */
function hiddenRoads(plan: RoutePlan, graph: { edge(id: number): { cum: ArrayLike<number> } }): number[] {
  const short = plan.legs.slice(1, -1).filter((l) => {
    const cum = graph.edge(l.edge).cum;
    return cum[cum.length - 1] < 200;
  });
  if (short.length < 2) return short.map((l) => l.edge);
  return [short[Math.floor(short.length / 3)].edge, short[Math.floor((2 * short.length) / 3)].edge];
}

function runJob(job: Job): { trip: string; lines: string[] } {
  const trip = TRIPS.find((t) => t.name === job.trip)!;
  const graphFile = findGraph(trip.from);
  if (!graphFile) throw new Error(`no road graph at ${trip.name}'s start`);
  const frame = new LocalFrame(trip.from);
  const g = openGraph(graphFile, trip.from);
  try {
    const planned = planRoute(g.graph, frame, trip.from, trip.to);
    if (planned.status !== "done") return { trip: trip.name, lines: [`${trip.name}: no route (${planned.reason})`] };
    const plan = planned.plan;
    const drive = cityDrive({ graph: g.graph, frame, legs: plan.legs, durationS: 4 * 3600, seed: job.seed });
    const { path: truth, timeline } = truthPath(drive);
    mkdirSync(OUT, { recursive: true });
    const lines: string[] = [];
    const minutes = (drive.truth.at(-1)!.tUs - drive.trip.startUs) / 60e6;
    for (const scenario of SCENARIOS) {
      const name = `sim-${trip.name}-s${job.seed}-${scenario}`;
      const file = `${name}.ulg`;
      writeFileSync(path.join(OUT, file), writeLog(drive, plan, scenarioFixes(drive, scenario), { sim_trip: trip.name, sim_seed: job.seed, sim_scenario: scenario, vehicle_vin: "SIMULATED0000000" }));
      const drawn = {
        version: 1, file, points: [{ lat: truth[0][0], lon: truth[0][1] }, { lat: truth.at(-1)![0], lon: truth.at(-1)![1] }], path: truth,
        legs: [{ lengthM: Math.round(timeline.at(-1)![1]), start: 0, kind: "road" }], graph: path.basename(graphFile), updatedAt: new Date().toISOString(),
      };
      writeFileSync(path.join(OUT, `${name}.truth.json`), JSON.stringify(drawn));
      const hidden = scenario === "unmapped" ? hiddenRoads(plan, g.graph) : [];
      writeFileSync(path.join(OUT, `${name}.sim.json`), JSON.stringify({ version: 1, trip: trip.name, seed: job.seed, scenario, cutS: scenario === "gps" ? null : CUT_S, hidden, timeline }));
    }
    lines.push(
      `${trip.name} seed ${job.seed}: ${(drive.distanceM / 1000).toFixed(1)} km in ${minutes.toFixed(0)} min, ${drive.junctions} junctions, ${drive.turns} turns, ` +
        `${drive.stopsMade} stops (route ${(plan.lengthM / 1000).toFixed(1)} km)`,
    );
    return { trip: trip.name, lines };
  } finally {
    g.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const threads = threadsArg(argv);
  const arg = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const names = arg("--trips")?.split(",") ?? TRIPS.map((t) => t.name);
  // Each seed is another drive of the same route: other stops, lanes, speeds and sensor errors.
  const [lo, hi = lo] = (arg("--seeds") ?? "1").split("-").map(Number);
  const seeds = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  for (const n of names) if (!TRIPS.some((t) => t.name === n)) throw new Error(`unknown trip ${n}: ${TRIPS.map((t) => t.name).join(", ")}`);
  const pool = new Pool(import.meta.url, threads);
  try {
    const results = await pool.map<Job, { trip: string; lines: string[] }>(names.flatMap((trip) => seeds.map((seed) => ({ trip, seed }))));
    for (const r of results) for (const l of r.lines) console.log(l);
  } finally {
    await pool.close();
  }
  console.log(`→ ${path.relative(process.cwd(), OUT)}`);
}

serveJobs(import.meta.url, runJob);
if (isMainThread) await main();
