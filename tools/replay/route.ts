// Route planning on a region's road graph (ROUTING-SPEC §7).
//
//   npm run route -- --from 51.4939,31.2947 --to 51.5100,31.3300            # one route, Chernihiv
//   npm run route -- --from 51.4939,31.2947,90 --to ... --geojson route.geojson   # heading 90° at the start
//   npm run route -- --bench 50                                              # random routes in the region
//   npm run route -- --bench 50 --at 51.4939,31.2947 --radius 8             # ... within 8 km of a point
//   npm run route -- --bench 30 --graph tools/tiles/out/release/kyiv-city.graph.bin
//   npm run route -- --from ... --to ... --alternatives                       # alternative routes too (§8.7)
//   npm run route -- --bench 50 --alternatives                               # how often, how different, how long

import { writeFileSync } from "node:fs";
import path from "node:path";

import type { Coordinate } from "../../src/nav/geo";
import { LocalFrame } from "../../src/nav/geo/local-frame";
import { TiledRoadGraph } from "../../src/nav/mapmatch/graph/road-graph";
import { AlternativeSearch, sharedM } from "../../src/nav/routing/alternatives";
import { routeManeuvers } from "../../src/nav/routing/maneuvers";
import { planRoute, type RoutePlan, type RouteStart } from "../../src/nav/routing/router";
import { fileByteSource, findGraph } from "./graph-file";

function parseArgs(argv: string[]) {
  const point = (s: string) => {
    const [lat, lon, heading] = s.split(",").map(Number);
    return { lat, lon, ...(Number.isFinite(heading) ? { headingRad: (heading * Math.PI) / 180 } : {}) };
  };
  let from: RouteStart | undefined;
  let to: Coordinate | undefined;
  let graph: string | undefined;
  let geojson: string | undefined;
  let bench = 0;
  let at: Coordinate | undefined;
  let radiusKm: number | undefined;
  let seed = 1;
  let warm = false;
  let cacheTiles = 2048;
  let alternatives = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") from = point(argv[++i]);
    else if (a === "--to") to = point(argv[++i]);
    else if (a === "--graph") graph = argv[++i];
    else if (a === "--geojson") geojson = argv[++i];
    else if (a === "--bench") bench = Number(argv[++i]);
    else if (a === "--at") at = point(argv[++i]);
    else if (a === "--radius") radiusKm = Number(argv[++i]);
    else if (a === "--seed") seed = Number(argv[++i]);
    else if (a === "--warm") warm = true;
    else if (a === "--cache-tiles") cacheTiles = Number(argv[++i]);
    else if (a === "--alternatives") alternatives = true;
    else if (a === "-h" || a === "--help") {
      console.log(
        "route --from lat,lon[,headingDeg] --to lat,lon [--alternatives] [--graph <file>] [--geojson <out>]\n" +
          "route --bench <n> [--alternatives] [--at lat,lon] [--radius km] [--seed 1] [--warm] [--cache-tiles 2048] [--graph <file>]",
      );
      process.exit(0);
    }
  }
  return { from, to, graph, geojson, bench, at, radiusKm, seed, warm, cacheTiles, alternatives };
}

const args = parseArgs(process.argv.slice(2));
const CHERNIHIV = { lat: 51.4939, lon: 31.2947 };
const anchor = args.from ?? args.at ?? CHERNIHIV;
const graphFile = args.graph ?? findGraph(anchor);
if (!graphFile) throw new Error("no road graph covers the start: build one with `tiles graph <region>`, or pass --graph");

function openGraph(origin: Coordinate) {
  const source = fileByteSource(graphFile!);
  const frame = new LocalFrame(origin);
  return { graph: new TiledRoadGraph(source, frame, { cacheTiles: args.cacheTiles }), frame, close: source.close };
}

const km = (m: number) => `${(m / 1000).toFixed(1)} km`;

/** Alternatives to `main`, searched to the end; with each one's share on the main route's roads. */
function findAlternatives(g: ReturnType<typeof openGraph>, from: RouteStart, to: Coordinate, main: RoutePlan) {
  const r = new AlternativeSearch(g.graph, g.frame, from, to, main).run();
  if (r.status !== "done") throw new Error("unfinished");
  const mainEdges = new Set(main.legs.map((l) => l.edge));
  return { ...r, shared: r.alternatives.map((a) => sharedM(g.graph, a, mainEdges) / a.lengthM) };
}
const min = (s: number) => `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;

if (!args.bench) {
  if (!args.from || !args.to) throw new Error("pass --from and --to, or --bench <n>");
  const opened = openGraph(args.from);
  const { graph, frame, close } = opened;
  const r = planRoute(graph, frame, args.from, args.to);
  const maneuvers = r.status === "done" ? routeManeuvers(graph, r.plan) : [];
  const alts = r.status === "done" && args.alternatives ? findAlternatives(opened, args.from, args.to, r.plan) : null;
  close();
  console.log(`${path.basename(graphFile)}: ${r.stats.states} states, ${r.stats.tilesRead} tiles read, ${r.stats.ms.toFixed(0)} ms`);
  if (r.status === "failed") {
    console.log(`no route: ${r.reason}`);
    process.exit(1);
  }
  const { plan } = r;
  console.log(`${km(plan.lengthM)}, ${min(plan.durationS)}, ${plan.legs.length} edges; ends ${Math.round(plan.offRoadM.start)} m and ${Math.round(plan.offRoadM.end)} m off the points`);
  for (const m of maneuvers) {
    const extra = m.exit ? ` exit ${m.exit}` : m.kind === "depart" || m.kind === "arrive" ? "" : ` ${Math.round((m.turnRad * 180) / Math.PI)}°`;
    console.log(`  ${km(m.atM).padStart(9)}  ${m.kind}${extra}  ${m.lat.toFixed(5)},${m.lon.toFixed(5)}`);
  }
  if (alts) {
    console.log(`alternatives: ${alts.alternatives.length} from ${alts.stats.searches} searches, ${alts.stats.states} states, ${alts.stats.ms.toFixed(0)} ms`);
    alts.alternatives.forEach((a, i) =>
      console.log(`  ${i + 1}. ${km(a.lengthM)}, ${min(a.durationS)} (+${Math.round((a.durationS - plan.durationS) / 60)} min), ${Math.round(alts.shared[i] * 100)} % on the main route's roads`),
    );
  }
  if (args.geojson) {
    const lineOf = (p: RoutePlan, alternative?: number) => ({
      type: "Feature",
      properties: { lengthM: Math.round(p.lengthM), durationS: Math.round(p.durationS), ...(alternative ? { alternative } : {}) },
      geometry: { type: "LineString", coordinates: p.coordinates.map((c) => [c.lon, c.lat]) },
    });
    const points = maneuvers.map((m) => ({ type: "Feature", properties: { kind: m.kind, atM: Math.round(m.atM), ...(m.exit ? { exit: m.exit } : {}) }, geometry: { type: "Point", coordinates: [m.lon, m.lat] } }));
    const others = (alts?.alternatives ?? []).map((a, i) => lineOf(a, i + 1));
    writeFileSync(args.geojson, JSON.stringify({ type: "FeatureCollection", features: [lineOf(plan), ...others, ...points] }));
    console.log(`wrote ${args.geojson}`);
  }
} else {
  // Random routes between road points: within --radius of --at, or anywhere in the graph's tiles.
  let state = args.seed >>> 0;
  const uniform = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const probe = openGraph(anchor);
  const { x0, y0, nx, ny, zoom } = probe.graph.info;
  const tileLon = (x: number) => (x / 2 ** zoom) * 360 - 180;
  const tileLat = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** zoom))) * 180) / Math.PI;
  const randomPoint = (): Coordinate | null => {
    let p: Coordinate;
    if (args.radiusKm) {
      const c = args.at ?? anchor;
      const r = args.radiusKm * 1000 * Math.sqrt(uniform());
      const a = 2 * Math.PI * uniform();
      p = new LocalFrame(c).toCoordinate(r * Math.sin(a), r * Math.cos(a));
    } else {
      p = { lon: tileLon(x0 + nx * uniform()), lat: tileLat(y0 + ny * uniform()) };
    }
    // Only points with a road nearby (the region's tiles cover a rectangle, the region doesn't), moved onto it:
    // a car is on a road.
    if (probe.graph.tileAt(p) < 0) return null;
    const [e, n] = probe.frame.toEnu(p);
    const near = probe.graph.edgesNear(e, n, 200)[0];
    return near ? probe.frame.toCoordinate(near.e, near.n) : null;
  };
  const shared = args.warm ? openGraph(anchor) : null;
  const rows: {
    a: Coordinate;
    b: Coordinate;
    distKm: number;
    ms: number;
    states: number;
    tiles: number;
    ok: boolean;
    reason?: string;
    lengthKm?: number;
    alts?: { count: number; ms: number; extra: number[]; shared: number[] };
  }[] = [];
  console.log(`${path.basename(graphFile)}: ${args.bench} random routes${args.radiusKm ? ` within ${args.radiusKm} km of ${anchor.lat},${anchor.lon}` : " in the region"}, ${args.warm ? "warm" : "cold"} tile cache`);
  while (rows.length < args.bench) {
    const a = randomPoint();
    const b = randomPoint();
    if (!a || !b) continue;
    const g = shared ?? openGraph(a);
    const r = planRoute(g.graph, g.frame, a, b);
    const found = r.status === "done" && args.alternatives ? findAlternatives(g, a, b, r.plan) : null;
    if (!shared) g.close();
    const distKm = Math.hypot(...probe.frame.toEnu(b).map((v, i) => v - probe.frame.toEnu(a)[i])) / 1000;
    rows.push({
      a,
      b,
      distKm,
      ms: r.stats.ms,
      states: r.stats.states,
      tiles: r.stats.tilesRead,
      ok: r.status === "done",
      ...(r.status === "failed" ? { reason: r.reason } : { lengthKm: r.plan.lengthM / 1000 }),
      ...(found && r.status === "done"
        ? {
            alts: {
              count: found.alternatives.length,
              ms: found.stats.ms,
              extra: found.alternatives.map((x) => x.durationS / r.plan.durationS - 1),
              shared: found.shared,
            },
          }
        : {}),
    });
  }
  probe.close();
  shared?.close();
  const quantile = (v: number[], q: number) => {
    const s = [...v].sort((x, y) => x - y);
    return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
  };
  const buckets: [number, number][] = [[0, 5], [5, 15], [15, 50], [50, 100], [100, Infinity]];
  console.log(`${"straight line".padEnd(16)}${"routes".padStart(7)}${"ms p50 / p90 / max".padStart(24)}${"states p50 / max".padStart(22)}${"tiles p50".padStart(11)}${"route ÷ line".padStart(14)}`);
  for (const [lo, hi] of buckets) {
    const b = rows.filter((r) => r.distKm >= lo && r.distKm < hi);
    if (!b.length) continue;
    const ok = b.filter((r) => r.ok);
    const ms = b.map((r) => r.ms);
    const states = b.map((r) => r.states);
    const detour = ok.map((r) => r.lengthKm! / Math.max(0.01, r.distKm));
    console.log(
      `${`${lo}–${hi === Infinity ? "" : hi} km`.padEnd(16)}${`${b.length}`.padStart(7)}` +
        `${`${quantile(ms, 0.5).toFixed(0)} / ${quantile(ms, 0.9).toFixed(0)} / ${Math.max(...ms).toFixed(0)}`.padStart(24)}` +
        `${`${quantile(states, 0.5)} / ${Math.max(...states)}`.padStart(22)}${`${quantile(b.map((r) => r.tiles), 0.5)}`.padStart(11)}` +
        `${ok.length ? quantile(detour, 0.5).toFixed(2) : "—"}`.padStart(14),
    );
  }
  if (args.alternatives) {
    console.log(`\n${"alternatives".padEnd(16)}${"routes".padStart(7)}${"none / 1 / 2".padStart(16)}${"ms p50 / p90 / max".padStart(24)}${"slower p50 / max".padStart(20)}${"shared p50 / max".padStart(20)}`);
    for (const [lo, hi] of buckets) {
      const b = rows.filter((r) => r.alts && r.distKm >= lo && r.distKm < hi);
      if (!b.length) continue;
      const n = (k: number) => b.filter((r) => r.alts!.count === k).length;
      const ms = b.map((r) => r.alts!.ms);
      const extra = b.flatMap((r) => r.alts!.extra);
      const sh = b.flatMap((r) => r.alts!.shared);
      const pct = (v: number) => `${Math.round(v * 100)} %`;
      console.log(
        `${`${lo}–${hi === Infinity ? "" : hi} km`.padEnd(16)}${`${b.length}`.padStart(7)}${`${n(0)} / ${n(1)} / ${n(2)}`.padStart(16)}` +
          `${`${quantile(ms, 0.5).toFixed(0)} / ${quantile(ms, 0.9).toFixed(0)} / ${Math.max(...ms).toFixed(0)}`.padStart(24)}` +
          `${extra.length ? `${pct(quantile(extra, 0.5))} / ${pct(Math.max(...extra))}` : "—"}`.padStart(20) +
          `${sh.length ? `${pct(quantile(sh, 0.5))} / ${pct(Math.max(...sh))}` : "—"}`.padStart(20),
      );
    }
  }
  const failed = rows.filter((r) => !r.ok);
  const ll = (c: Coordinate) => `${c.lat.toFixed(5)},${c.lon.toFixed(5)}`;
  for (const r of failed) console.log(`failed: ${r.reason} (${r.distKm.toFixed(1)} km): --from ${ll(r.a)} --to ${ll(r.b)}`);
  console.log(`heap ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB`);
}
