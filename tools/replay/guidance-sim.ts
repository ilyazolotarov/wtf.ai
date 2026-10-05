// Route guidance on simulated city drives (ROUTING-SPEC §8.3), before a real one: does guidance say "off route"
// while the car is on it, dead-reckoning without GPS for an hour, and how soon does it notice when the car really
// leaves the route?
//
//   npm run route:sim                                     # Chernihiv, 60 min, seeds 1–3, GPS for the first 3 min
//   npm run route:sim -- --minutes 120 --seeds 2
//   npm run route:sim -- --at 50.4501,30.5234 --graph tools/tiles/out/release/kyiv-city.graph.bin
//   npm run route:sim -- --gps                            # with GPS all along (the baseline)
//
// Follow: the route is the car's own path from the cut on, so every "off" is false. Divert: every few minutes a route
// is planned from where the car is to a point 2–4 km away; the car keeps driving its own way, so it leaves the route
// at some junction (found from the true position), and guidance on the puck should say "off" soon after.

import path from "node:path";

import type { Coordinate } from "../../src/nav/geo";
import { haversineM } from "../../src/nav/geo";
import { LocalFrame } from "../../src/nav/geo/local-frame";
import { replayPuck, type PuckPoint } from "../../src/nav/replay/drive-report";
import { replayTrip } from "../../src/nav/replay/replay";
import { RouteGuidance, type GuidanceState } from "../../src/nav/routing/guidance";
import type { Maneuver } from "../../src/nav/routing/maneuvers";
import { routeManeuvers } from "../../src/nav/routing/maneuvers";
import { planRoute, type RoutePlan } from "../../src/nav/routing/router";
import { cityDrive, type CityTruth } from "../../src/nav/sim/city-drive";
import { findGraph, openGraph } from "./graph-file";

function parseArgs(argv: string[]) {
  let at: Coordinate = { lat: 51.4939, lon: 31.2947 };
  let graph: string | undefined;
  let minutes = 60;
  let seeds = 3;
  let gpsMin = 3;
  let gps = false;
  let divertEveryMin = 6;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--at") {
      const [lat, lon] = argv[++i].split(",").map(Number);
      at = { lat, lon };
    } else if (a === "--graph") graph = argv[++i];
    else if (a === "--minutes") minutes = Number(argv[++i]);
    else if (a === "--seeds") seeds = Number(argv[++i]);
    else if (a === "--gps-min") gpsMin = Number(argv[++i]);
    else if (a === "--gps") gps = true;
    else if (a === "--divert-every") divertEveryMin = Number(argv[++i]);
    else if (a === "-h" || a === "--help") {
      console.log("route:sim [--at lat,lon] [--graph <file>] [--minutes 60] [--seeds 3] [--gps-min 3] [--gps] [--divert-every 6]");
      process.exit(0);
    }
  }
  return { at, graph, minutes, seeds, gpsMin, gps, divertEveryMin };
}

const quantile = (v: number[], q: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
};
const f0 = (v: number) => (Number.isFinite(v) ? v.toFixed(0) : "—");
const pct = (n: number, d: number) => `${d ? ((100 * n) / d).toFixed(1) : "—"} %`;

/** The guidance input from the replay's puck at a sample (the app passes the published position the same way). */
const input = (p: PuckPoint) => ({
  lat: p.lat,
  lon: p.lon,
  tMs: p.t * 1000,
  accuracyM: p.acc,
  headingRad: p.headingRad,
  speedMps: p.speedMps,
  mapMatch: p.mapMatch,
});

/** Revisiting: a point within this of one more than `REVISIT_BACK_M` earlier along the path. */
const REVISIT_M = 60;
const REVISIT_BACK_M = 200;
const MIN_PLAN_M = 500;

interface PathPlan {
  plan: RoutePlan;
  fromS: number;
  toS: number;
  /** Distance along the plan where the car truly was at a time. */
  cumAt(tS: number): number;
}

/**
 * Plans along the car's own path from `fromS` on (a point every ~10 m), cut wherever the path comes back to where it
 * was: the simulator's random drives loop around blocks, which a planned route never does.
 */
function pathPlans(truth: CityTruth[], startUs: number, fromS: number): PathPlan[] {
  const out: PathPlan[] = [];
  let pts: Coordinate[] = [];
  let cum: number[] = [];
  let times: number[] = [];
  let d = 0;
  let prev: CityTruth | null = null;
  const close = () => {
    if (pts.length > 1 && cum.at(-1)! - cum[0] >= MIN_PLAN_M) {
      const base = cum[0];
      const c = cum.map((v) => v - base);
      const t = [...times];
      const plan: RoutePlan = { legs: [], lengthM: c.at(-1)!, durationS: t.at(-1)! - t[0], coordinates: pts, offRoadM: { start: 0, end: 0 } };
      const cumAt = (tS: number) => {
        let lo = 0;
        let hi = t.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (t[mid] <= tS) lo = mid;
          else hi = mid - 1;
        }
        return c[lo];
      };
      out.push({ plan, fromS: t[0], toS: t.at(-1)!, cumAt });
    }
    pts = [];
    cum = [];
    times = [];
  };
  for (const p of truth) {
    const tS = (p.tUs - startUs) / 1e6;
    if (tS < fromS) continue;
    if (prev) d += haversineM(prev, p);
    prev = p;
    if (pts.length && d - cum.at(-1)! < 10) continue;
    const revisit = pts.some((q, i) => cum[i] < d - REVISIT_BACK_M && haversineM(q, p) < REVISIT_M);
    if (revisit) close();
    pts.push({ lat: p.lat, lon: p.lon });
    cum.push(d);
    times.push(tS);
  }
  close();
  return out;
}

const args = parseArgs(process.argv.slice(2));
const graphFile = args.graph ?? findGraph(args.at);
if (!graphFile) throw new Error("no road graph covers --at: build one with `tiles graph <region>`, or pass --graph");
console.log(
  `${path.basename(graphFile)}: ${args.minutes} min drives, seeds 1–${args.seeds}, ` +
    (args.gps ? "GPS all along" : `GPS for the first ${args.gpsMin} min, then none`) +
    `; a diversion every ${args.divertEveryMin} min`,
);

const follow = { samples: 0, states: new Map<GuidanceState, number>(), falseOff: 0, falseAt: [] as string[], hours: 0, plans: 0, progressErr: [] as number[] };
const divert = { planned: 0, diverged: 0, detected: 0, delayS: [] as number[], delayM: [] as number[], falseOffBefore: 0, followedToEnd: 0, missed: [] as string[] };

for (let seed = 1; seed <= args.seeds; seed++) {
  const frame = new LocalFrame(args.at);
  const simGraph = openGraph(graphFile, args.at);
  const drive = cityDrive({ graph: simGraph.graph, frame, durationS: args.minutes * 60, seed });
  simGraph.close();
  const cutS = 20 + args.gpsMin * 60;
  const navGraph = openGraph(graphFile, args.at);
  const t0 = performance.now();
  const result = replayTrip(drive.trip, {
    nav: { mapMatchLoop: "closed" },
    mapMatch: { graph: navGraph.graph },
    cuts: args.gps ? [] : [{ fromS: cutS, toS: Infinity }],
    trackStepS: 1,
  });
  navGraph.close();
  const puck = replayPuck(result).filter((p) => p.t >= cutS);
  const startUs = drive.trip.startUs;
  const truthAtS = (tS: number) => drive.truthAt(startUs + tS * 1e6);
  // Distance driven by a time (the truth at 10 Hz).
  const driven: number[] = [0];
  for (let i = 1; i < drive.truth.length; i++) driven.push(driven[i - 1] + haversineM(drive.truth[i - 1], drive.truth[i]));
  const drivenAt = (tS: number) => driven[Math.max(0, Math.min(driven.length - 1, Math.round(((startUs + tS * 1e6 - drive.truth[0].tUs) / 1e6) * 10)))];

  // Follow: routes along the car's own path, so every "off" is false.
  let falseOff = 0;
  const plans = pathPlans(drive.truth, startUs, cutS);
  for (const { plan, fromS, toS, cumAt } of plans) {
    const ends: Maneuver[] = [
      { kind: "depart", atM: 0, ...plan.coordinates[0], turnRad: 0 },
      { kind: "arrive", atM: plan.lengthM, ...plan.coordinates.at(-1)!, turnRad: 0 },
    ];
    const g = new RouteGuidance(plan, ends);
    let prev: GuidanceState | null = null;
    for (const p of puck) {
      if (p.t < fromS || p.t > toS) continue;
      const s = g.update(input(p));
      follow.samples++;
      follow.states.set(s.state, (follow.states.get(s.state) ?? 0) + 1);
      if (s.state === "off" && prev !== "off") {
        falseOff++;
        follow.falseAt.push(`seed ${seed} at ${Math.round(p.t)} s`);
      }
      if (s.state !== "arrived") follow.progressErr.push(Math.abs(s.alongM - cumAt(p.t)));
      prev = s.state;
    }
    follow.hours += (toS - fromS) / 3600;
    follow.plans++;
  }
  follow.falseOff += falseOff;

  // Divert: plans to points 2–4 km away from where the car is, every few minutes.
  const routeGraph = openGraph(graphFile, args.at);
  let seedDiverted = 0;
  let seedDetected = 0;
  for (let tS = cutS + 120; tS < puck.at(-1)!.t - 300; tS += args.divertEveryMin * 60) {
    const truth = truthAtS(tS);
    if (truth.speedMps < 3) continue;
    const bearing = ((tS * 7919) % 360) * (Math.PI / 180);
    const distM = 2000 + ((tS * 104729) % 2000);
    const dest = new LocalFrame(truth).toCoordinate(distM * Math.sin(bearing), distM * Math.cos(bearing));
    const routeFrame = new LocalFrame(truth);
    routeGraph.graph.setFrame(routeFrame);
    const r = planRoute(routeGraph.graph, routeFrame, { lat: truth.lat, lon: truth.lon, headingRad: truth.psi }, dest);
    if (r.status !== "done") continue;
    divert.planned++;
    const maneuvers = routeManeuvers(routeGraph.graph, r.plan);
    // Where the car really left it: the true position more than 25 m off the route, by guidance on the truth.
    const onTruth = new RouteGuidance(r.plan, maneuvers, { offMinM: 25, offHoldS: 0, offHoldM: 0 });
    const onPuck = new RouteGuidance(r.plan, maneuvers);
    let divergedAt: number | null = null;
    let detectedAt: number | null = null;
    let arrived = false;
    let lastPuckState: GuidanceState | null = null;
    for (const p of puck) {
      if (p.t < tS) continue;
      if (p.t > tS + 600) break;
      const tr = truthAtS(p.t);
      const truthState = onTruth.update({ lat: tr.lat, lon: tr.lon, tMs: p.t * 1000, accuracyM: 3, headingRad: tr.psi, speedMps: tr.speedMps });
      if (truthState.state === "arrived") arrived = true;
      if (divergedAt === null && truthState.state === "off") divergedAt = p.t;
      const s = onPuck.update(input(p));
      if (s.state === "off" && lastPuckState !== "off" && divergedAt === null) divert.falseOffBefore++;
      if (divergedAt !== null && detectedAt === null && s.state === "off") detectedAt = p.t;
      lastPuckState = s.state;
      if (detectedAt !== null) break;
    }
    if (divergedAt === null) {
      if (arrived) divert.followedToEnd++;
      continue;
    }
    divert.diverged++;
    seedDiverted++;
    if (detectedAt === null || detectedAt - divergedAt > 180) {
      divert.missed.push(`seed ${seed} at ${Math.round(divergedAt)} s`);
      continue;
    }
    divert.detected++;
    seedDetected++;
    divert.delayS.push(detectedAt - divergedAt);
    divert.delayM.push(drivenAt(detectedAt) - drivenAt(divergedAt));
  }
  routeGraph.close();
  console.log(
    `seed ${seed}: ${(drive.distanceM / 1000).toFixed(1)} km; follow: ${falseOff} false "off"; ` +
      `divert: ${seedDetected} of ${seedDiverted} departures noticed; ${((performance.now() - t0) / 1000).toFixed(0)} s`,
  );
}

const n = follow.samples;
const share = (s: GuidanceState) => pct(follow.states.get(s) ?? 0, n);
console.log(
  `\nFollow (the car on its route: ${follow.plans} routes, ${follow.hours.toFixed(1)} h): false "off" ${follow.falseOff} (${(follow.falseOff / Math.max(0.01, follow.hours)).toFixed(1)} per hour); ` +
    `on ${share("on")}, leaving ${share("leaving")}, unsure ${share("unsure")}, off ${share("off")}; ` +
    `progress error p50 / p90 / max ${f0(quantile(follow.progressErr, 0.5))} / ${f0(quantile(follow.progressErr, 0.9))} / ${f0(Math.max(...follow.progressErr))} m` +
    (follow.falseAt.length ? `; false "off" at ${follow.falseAt.join(", ")}` : ""),
);
console.log(
  `Divert: ${divert.planned} routes, ${divert.diverged} left by the car (${divert.followedToEnd} followed to the end); ` +
    `noticed ${divert.detected} within 3 min, after ${f0(quantile(divert.delayS, 0.5))} s / ${f0(quantile(divert.delayM, 0.5))} m median, ` +
    `${f0(Math.max(...divert.delayS))} s / ${f0(Math.max(...divert.delayM))} m at most; false "off" before leaving ${divert.falseOffBefore}` +
    (divert.missed.length ? `; missed: ${divert.missed.join(", ")}` : ""),
);
