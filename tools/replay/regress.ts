// Every drive through the app as the viewer replays it, from a cold start and from the parked chain (each drive
// starting from what the earlier ones left), with several filter seeds, scored drive by drive. With --against, each
// drive is set against a saved run, so a change that breaks one drive shows even when the averages improve
// (MAPMATCH-SPEC §10.2). Run it before and after any navigator or map-matching change.
//
//   npm run replay:regress -- --save before          # keep this run (tools/triplog/logs/regress/before.json)
//   npm run replay:regress -- --against before       # every drive against it: what got worse, what got better
//   npm run replay:regress -- --seeds 5 --starts parked --logs 20261005 --nav '<json>' --mm '<json>' --threads 8
//
// Truth per drive, best first: the roads drawn for it in the viewer (`<log>.truth.json`, drawn-truth.ts), else its
// clean satellite fixes (the dot when GPS came back after each gap, and through the app's Cut GPS stretches: the
// viewer's "Without GPS"), else its Wi-Fi fixes (10–150 m; the dot just before each, a rough check). And on every
// drive, truth or not: seconds the dot was away from every road above 20 km/h, and its jumps.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { APP_NAV_DEFAULTS } from "../../src/nav/app-defaults";
import { haversineM } from "../../src/nav/geo";
import { LocalFrame } from "../../src/nav/geo/local-frame";
import type { MapMatchConfig } from "../../src/nav/mapmatch/particle-filter";
import type { NavConfig } from "../../src/nav/navigator";
import { driveOutages, estimateTrack, obdDistanceM, type ShownPoint } from "../../src/nav/replay/drive-report";
import { drawnTruthTrack, scoreDrawn, type DrawnTruth } from "../../src/nav/replay/drawn-truth";
import { appOutageCuts } from "../../src/nav/replay/replay";
import { MemoryKeyValueStore, phoneOf, replayTripInApp } from "../../src/services/navigation/app-replay";
import { CalibrationStore } from "../../src/services/navigation/calibration-store";
import type { MapMatchLoop } from "../../src/services/navigation/navigator-service";
import { readTripLog, type TripLog } from "../../src/triplog/trip-log-reader";
import { carOf, graphFor } from "./app-chain";
import { isMainThread, Pool, serveJobs, threadsArg } from "./pool";

const LOGS = path.join(path.dirname(fileURLToPath(import.meta.url)), "../triplog/logs");
const SAVED = path.join(LOGS, "regress");
/** The dot farther than this from every road above `FAST_KPH` is drawn off the roads (no yard is driven that fast). */
const OFF_ROAD_M = 20;
const FAST_KPH = 20;
/** Faster than a car (45 m/s, plus 10 m for a correction): the dot jumped (the viewer's hollow circles). */
const JUMP_MPS = 45;
const JUMP_SLACK_M = 10;

type Start = "cold" | "parked";
interface Job {
  start: Start;
  seed: number;
  /** One log (cold), or every log in order (parked: one storage across them). */
  logs: string[];
  nav: Partial<NavConfig>;
  mm: Partial<MapMatchConfig>;
}

/** One drive, one start, one seed. Distances in m, times in s. */
export interface DriveResult {
  log: string;
  start: Start;
  seed: number;
  km: number;
  truth: "drawn" | "gps" | "wifi" | "none";
  drawn?: { offPathS: number; movingS: number; errorMedianM: number | null; endErrorM: number | null };
  /** Real gaps: the dot when GPS came back; the app's Cut GPS stretches: the dot at its worst inside. */
  gps?: { gaps: number; afterMaxM: number | null; afterMedianM: number | null; cutMaxM: number | null };
  wifi?: { fixes: number; medianM: number | null };
  offRoadS: number;
  fastS: number;
  jumps: number;
  /** Parked: from where the car's previous drive left the dot to this drive's first dot. */
  startGapM: number | null;
  /** What became of the parked pose the drive started from. */
  pose: string | null;
  error?: string;
}

const median = (v: number[]) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] : null);

function readDrawn(log: string): DrawnTruth | null {
  const f = path.join(LOGS, log.replace(/\.ulg$/, ".truth.json"));
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as DrawnTruth) : null;
}

/** A drive's scores from the dot the service published. */
function score(trip: TripLog, log: string, track: ShownPoint[], graph: ReturnType<typeof graphFor>): Omit<DriveResult, "start" | "seed" | "startGapM" | "pose"> {
  const durationS = Math.max(0, ...[trip.imu.at(-1), trip.obdSpeed.at(-1), trip.gnss.at(-1)].map((x) => (x ? (x.tUs - trip.startUs) / 1e6 : 0)));
  const km = Math.round(obdDistanceM(trip, 0, durationS)) / 1000;
  const out: Omit<DriveResult, "start" | "seed" | "startGapM" | "pose"> = { log, km, truth: "none", offRoadS: 0, fastS: 0, jumps: 0 };
  const drawn = readDrawn(log);
  if (drawn && drawn.path.length > 1) {
    const s = scoreDrawn(trip, drawnTruthTrack(trip, drawn), track);
    out.truth = "drawn";
    out.drawn = { offPathS: s.offPathS, movingS: s.movingS, errorMedianM: s.errorMedianM, endErrorM: s.endErrorM };
  }
  const outages = driveOutages(trip, durationS, appOutageCuts(trip).map((c) => ({ kind: "app-cut" as const, fromS: c.fromS, toS: c.toS })), { dot: track });
  const after = outages.flatMap((o) => (o.kind === "no-gps" && o.scores.dot?.afterErrorM != null ? [o.scores.dot.afterErrorM] : []));
  const cuts = outages.flatMap((o) => (o.kind === "app-cut" && o.scores.dot?.maxErrorM != null ? [o.scores.dot.maxErrorM] : []));
  if (after.length || cuts.length) {
    if (out.truth === "none") out.truth = "gps";
    out.gps = { gaps: after.length, afterMaxM: after.length ? Math.max(...after) : null, afterMedianM: median(after), cutMaxM: cuts.length ? Math.max(...cuts) : null };
  }
  const wifi: number[] = [];
  let k = 0;
  for (const f of trip.gnss) {
    if (!(f.hAccM > 10 && f.hAccM <= 150)) continue;
    const t = (f.tUs - trip.startUs) / 1e6;
    while (k + 1 < track.length && track[k + 1].t < t) k++;
    const p = track[k];
    if (p && p.t <= t && t - p.t <= 2) wifi.push(haversineM(p, f));
  }
  if (wifi.length) {
    if (out.truth === "none") out.truth = "wifi";
    out.wifi = { fixes: wifi.length, medianM: median(wifi) };
  }
  if (graph && track.length) {
    const frame = new LocalFrame(track[0]);
    graph.active.graph.setFrame(frame);
    const sp = trip.obdSpeed;
    let j = 0;
    for (let i = 1; i < track.length; i++) {
      const p = track[i];
      const prev = track[i - 1];
      const dt = p.t - prev.t;
      if (dt <= 3 && haversineM(prev, p) > JUMP_MPS * dt + JUMP_SLACK_M) out.jumps++;
      const tUs = trip.startUs + p.t * 1e6;
      while (j + 1 < sp.length && sp[j + 1].tUs <= tUs) j++;
      if (!sp[j] || tUs - sp[j].tUs > 3e6 || !(sp[j].speedMps * 3.6 > FAST_KPH)) continue;
      const step = Math.min(1, dt);
      out.fastS += step;
      const [e, n] = frame.toEnu(p);
      if (!graph.active.graph.edgesNear(e, n, OFF_ROAD_M).length) out.offRoadS += step;
    }
    out.fastS = Math.round(out.fastS);
    out.offRoadS = Math.round(out.offRoadS);
  }
  return out;
}

function runJob(job: Job): DriveResult[] {
  const store = new MemoryKeyValueStore();
  const byProtocol = new Map<string, string>();
  const lastDot = new Map<string, { lat: number; lon: number }>();
  const results: DriveResult[] = [];
  for (const log of job.logs) {
    const trip = readTripLog(new Uint8Array(readFileSync(path.join(LOGS, log))));
    const vin = carOf(trip, job.start === "parked" ? byProtocol : new Map());
    const graph = graphFor(trip);
    try {
      const r = replayTripInApp(trip, {
        calibration: new CalibrationStore(job.start === "parked" ? store : new MemoryKeyValueStore(), phoneOf(trip)),
        loop: (job.nav.mapMatchLoop ?? APP_NAV_DEFAULTS.mapMatchLoop ?? "closed") as MapMatchLoop,
        roadGraph: graph?.active,
        vin,
        cuts: appOutageCuts(trip),
        nav: job.nav,
        mapMatchConfig: { ...job.mm, seed: job.seed },
      });
      const track = estimateTrack(
        r.published.map((p) => ({ tUs: p.timestampUs, latDeg: p.latDeg, lonDeg: p.lonDeg, accuracyM: p.accuracyM })),
        trip.startUs,
      );
      const before = vin ? lastDot.get(vin) : undefined;
      const startGapM = job.start === "parked" && before && track[0] ? Math.round(haversineM(before, track[0])) : null;
      if (vin && track.length) lastDot.set(vin, track.at(-1)!);
      results.push({ ...score(trip, log, track, graph), start: job.start, seed: job.seed, startGapM, pose: r.summary.startPose?.status ?? null });
    } catch (e) {
      results.push({ log, start: job.start, seed: job.seed, km: 0, truth: "none", offRoadS: 0, fastS: 0, jumps: 0, startGapM: null, pose: null, error: String(e) });
    } finally {
      graph?.close();
    }
  }
  return results;
}

// ---------- the main thread ----------

interface Saved {
  version: 1;
  name: string;
  commit: string;
  createdAt: string;
  options: { seeds: number; starts: Start[]; nav: Partial<NavConfig>; mm: Partial<MapMatchConfig> };
  results: DriveResult[];
}

/** The number a drive is judged by, lower better: its best truth's main score. */
function mainScore(r: DriveResult): { value: number | null; what: string; unit: "m" | "s" } {
  if (r.drawn) return { value: r.drawn.offPathS, what: "off the drawn road", unit: "s" };
  if (r.gps) return { value: Math.max(r.gps.afterMaxM ?? 0, r.gps.cutMaxM ?? 0), what: "GPS back / cut, worst", unit: "m" };
  if (r.wifi) return { value: r.wifi.medianM, what: "from Wi-Fi fixes, median", unit: "m" };
  return { value: null, what: "no truth", unit: "m" };
}

type Group = { log: string; start: Start; runs: DriveResult[] };
function groups(results: DriveResult[]): Map<string, Group> {
  const out = new Map<string, Group>();
  for (const r of results) {
    const key = `${r.log}|${r.start}`;
    const g = out.get(key) ?? out.set(key, { log: r.log, start: r.start, runs: [] }).get(key)!;
    g.runs.push(r);
  }
  for (const g of out.values()) g.runs.sort((a, b) => a.seed - b.seed);
  return out;
}

const fmt = (v: number | null, unit: string) => (v === null ? "—" : unit === "s" ? `${Math.round(v)}` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`);
const seedsOf = (g: Group, f: (r: DriveResult) => number | null, unit: string) => g.runs.map((r) => fmt(f(r), unit)).join("/");
const name = (log: string) => log.slice(0, 15) + " " + log.slice(16, 22);

/** Worse beyond what seeds move by: half again as much plus a floor. */
const worse = (a: number | null, b: number | null, floor: number) => a !== null && b !== null && b > a * 1.5 + floor;

function compare(before: Group, now: Group): { worse: string[]; better: string[] } {
  const w: string[] = [];
  const b: string[] = [];
  const checks: [string, (r: DriveResult) => number | null, number, string][] = [];
  const m = mainScore(now.runs[0]);
  if (mainScore(before.runs[0]).what === m.what && m.value !== null) checks.push([m.what, (r) => mainScore(r).value, m.unit === "s" ? 10 : 20, m.unit]);
  checks.push(["off the roads above 20 km/h", (r) => r.offRoadS, 10, "s"], ["jumps", (r) => r.jumps, 2, ""]);
  for (const [what, f, floor, unit] of checks) {
    const a = before.runs.map(f).filter((v): v is number => v !== null);
    const c = now.runs.map(f).filter((v): v is number => v !== null);
    const [ma, mc, xa, xc] = [median(a), median(c), a.length ? Math.max(...a) : null, c.length ? Math.max(...c) : null];
    const line = `${what} ${seedsOf(before, f, unit)} → ${seedsOf(now, f, unit)}${unit ? " " + unit : ""}`;
    if (worse(ma, mc, floor) || worse(xa, xc, 2.5 * floor)) w.push(line);
    else if (worse(mc, ma, floor) || worse(xc, xa, 2.5 * floor)) b.push(line);
  }
  return { worse: w, better: b };
}

function totals(results: DriveResult[]) {
  const sum = (f: (g: Group) => number | null) => {
    let s = 0;
    for (const g of groups(results).values()) s += f(g) ?? 0;
    return Math.round(s);
  };
  const med = (f: (r: DriveResult) => number | null | undefined) => (g: Group) => median(g.runs.map(f).filter((v): v is number => v != null));
  return {
    drawnOffS: sum(med((r) => r.drawn?.offPathS)),
    gpsWorstM: sum(med((r) => (r.gps ? Math.max(r.gps.afterMaxM ?? 0, r.gps.cutMaxM ?? 0) : null))),
    wifiM: sum(med((r) => r.wifi?.medianM)),
    offRoadS: sum(med((r) => r.offRoadS)),
    jumps: sum(med((r) => r.jumps)),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const threads = threadsArg(argv);
  const arg = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const seeds = Number(arg("--seeds") ?? 3);
  const starts = (arg("--starts") ?? "cold,parked").split(",") as Start[];
  const only = arg("--logs");
  const nav = JSON.parse(arg("--nav") ?? "{}") as Partial<NavConfig>;
  const mm = JSON.parse(arg("--mm") ?? "{}") as Partial<MapMatchConfig>;
  const saveAs = arg("--save");
  const against = arg("--against");

  const all = readdirSync(LOGS).filter((f) => f.endsWith(".ulg")).sort();
  const picked = only ? all.filter((f) => f.startsWith(only) || f.includes(only)) : all;
  if (!picked.length) throw new Error(`no logs match ${only}`);
  // The parked chain replays every log up to the last one picked: those before it set its storage.
  const chain = all.filter((f) => f <= picked.at(-1)!);
  const jobs: Job[] = [];
  for (let seed = 1; seed <= seeds; seed++) if (starts.includes("parked")) jobs.push({ start: "parked", seed, logs: chain, nav, mm });
  for (let seed = 1; seed <= seeds; seed++) if (starts.includes("cold")) for (const log of picked) jobs.push({ start: "cold", seed, logs: [log], nav, mm });
  const started = Date.now();
  const pool = new Pool(import.meta.url, threads);
  let results: DriveResult[];
  try {
    results = (await pool.map<Job, DriveResult[]>(jobs)).flat().filter((r) => picked.includes(r.log));
  } finally {
    await pool.close();
  }
  const commit = (() => {
    try {
      const head = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
      return execSync("git status --porcelain -- src", { encoding: "utf8" }).trim() ? `${head}+changes` : head;
    } catch {
      return "unknown";
    }
  })();
  console.log(`${picked.length} drives × ${starts.join(", ")} × ${seeds} seeds in ${Math.round((Date.now() - started) / 1000)} s (${commit})`);
  for (const r of results) if (r.error) console.log(`  ${name(r.log)} ${r.start} seed ${r.seed}: ${r.error.split("\n")[0]}`);

  const now = groups(results);
  if (against) {
    const saved = JSON.parse(readFileSync(path.join(SAVED, `${against}.json`), "utf8")) as Saved;
    if (saved.options.seeds !== seeds || saved.options.starts.join() !== starts.join()) {
      console.log(`note: "${against}" ran ${saved.options.seeds} seeds × ${saved.options.starts.join(", ")}; this run ${seeds} × ${starts.join(", ")}`);
    }
    const before = groups(saved.results);
    const worseRows: string[] = [];
    const betterRows: string[] = [];
    let same = 0;
    for (const [key, g] of now) {
      const b = before.get(key);
      if (!b) continue;
      const c = compare(b, g);
      const head = `  ${name(g.log)} ${g.start.padEnd(6)} `;
      if (c.worse.length) worseRows.push(head + c.worse.join(" · ") + (c.better.length ? `  (better: ${c.better.join(" · ")})` : ""));
      else if (c.better.length) betterRows.push(head + c.better.join(" · "));
      else same++;
    }
    console.log(`against "${against}" (${saved.commit}, ${saved.createdAt.slice(0, 16)}): per drive, the seeds before → now`);
    console.log(`worse (${worseRows.length}):${worseRows.length ? "\n" + worseRows.join("\n") : " none"}`);
    console.log(`better (${betterRows.length}):${betterRows.length ? "\n" + betterRows.join("\n") : " none"}`);
    console.log(`unchanged: ${same} of ${now.size}`);
    const [ta, tb] = [totals(saved.results.filter((r) => picked.includes(r.log))), totals(results)];
    console.log(
      `totals (median over seeds, summed over drives): off the drawn road ${ta.drawnOffS} → ${tb.drawnOffS} s · GPS back / cut worst ${ta.gpsWorstM} → ${tb.gpsWorstM} m · ` +
        `from Wi-Fi fixes ${ta.wifiM} → ${tb.wifiM} m · off the roads above 20 km/h ${ta.offRoadS} → ${tb.offRoadS} s · jumps ${ta.jumps} → ${tb.jumps}`,
    );
  } else {
    console.log("drive                  start   km    truth: main score per seed          off the roads >20 km/h s   jumps   start gap m   pose");
    for (const g of now.values()) {
      const m = mainScore(g.runs[0]);
      const truth = m.value === null ? "no truth" : `${g.runs[0].truth}: ${m.what} ${seedsOf(g, (r) => mainScore(r).value, m.unit)} ${m.unit}`;
      console.log(
        `  ${name(g.log)} ${g.start.padEnd(6)} ${g.runs[0].km.toFixed(1).padStart(5)}  ${truth.padEnd(46)} ${seedsOf(g, (r) => r.offRoadS, "s").padEnd(26)} ` +
          `${seedsOf(g, (r) => r.jumps, "").padEnd(7)} ${g.start === "parked" ? seedsOf(g, (r) => r.startGapM, "m").padEnd(13) : "".padEnd(13)} ${g.runs.map((r) => r.pose ?? "-").join("/")}`,
      );
    }
    const t = totals(results);
    console.log(`totals (median over seeds, summed over drives): off the drawn road ${t.drawnOffS} s · GPS back / cut worst ${t.gpsWorstM} m · from Wi-Fi fixes ${t.wifiM} m · off the roads above 20 km/h ${t.offRoadS} s · jumps ${t.jumps}`);
  }
  if (saveAs) {
    mkdirSync(SAVED, { recursive: true });
    const saved: Saved = { version: 1, name: saveAs, commit, createdAt: new Date().toISOString(), options: { seeds, starts, nav, mm }, results };
    writeFileSync(path.join(SAVED, `${saveAs}.json`), JSON.stringify(saved));
    console.log(`saved as "${saveAs}" (${path.relative(process.cwd(), path.join(SAVED, `${saveAs}.json`))})`);
  }
}

serveJobs(import.meta.url, runJob);
if (isMainThread) await main();
