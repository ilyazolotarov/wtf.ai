// The turn-anchored tracker (src/nav/mapmatch/turn-tracker.ts) on phone-only speed, each drawn drive started where its
// drawing starts, scored against the drawing like replay:regress (seconds the dot was > 30 m off the drawn route).
//
//   npm run replay:turns -- [--cfg '<tracker json>'] [--speed '<imu-speed json>'] [--logs <substr>] [--trace <id>]
//
// Best city setting so far: --speed '{"priorSigmaMps":5,"priorSpeedMps":12}'. Experiments on what limits it:
//   --obd                    OBD speed instead (what the tracker does with a good speed)
//   --obd-noise '<json>'     with --obd: a known error, {"scale":0.85} or {"stretchSigma":0.3} (per stop-to-stop stretch)
//   --phone-gaps             with --obd: unknown wherever the phone's speed is
//   --stretch-oracle         phone speed scaled per stretch to OBD's distance (the shape within a stretch stays)
//   --ensemble               also the navigator's particle filter on phone speed, and ways of choosing between them
//   --along                  where the dot was along the drawn route next to the car: ahead, behind, another road
//   --route '<json>'         the driver follows a planned route (the drawn one): RouteFollower instead of the tracker
//   --trace <id>             one drive second by second (env EVERY, FROM, TO; HYPS lists hypotheses, LEDGER compares
//                            where the leader's and the nearest-to-truth hypothesis' weights came from)

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { haversineM } from "../../src/nav/geo";
import { LocalFrame } from "../../src/nav/geo/local-frame";
import { RouteFollower, type RouteFollowerConfig } from "../../src/nav/mapmatch/route-follower";
import { TurnTracker, type TurnTrackerConfig } from "../../src/nav/mapmatch/turn-tracker";
import { ImuSpeedEstimator, type ImuSpeedConfig, type PhoneMount } from "../../src/nav/odometry/imu/imu-speed";
import type { ShownPoint } from "../../src/nav/replay/drive-report";
import { alongDrawn, drawnTruthTrack, scoreDrawn, type DrawnTruth } from "../../src/nav/replay/drawn-truth";
import { isSatelliteFix } from "../../src/nav/types";
import { readTripLog, type TripLog } from "../../src/triplog/trip-log-reader";
import { withPhoneSpeed } from "../../src/nav/replay/phone-speed";
import { appOutageCuts } from "../../src/nav/replay/replay";
import { MemoryKeyValueStore, phoneOf, replayTripInApp } from "../../src/services/navigation/app-replay";
import { CalibrationStore } from "../../src/services/navigation/calibration-store";
import { carOf, drawnStartPose, graphFor, regionPoint } from "./app-chain";
import { findGraph, openGraph } from "./graph-file";

const LOGS = path.resolve(import.meta.dirname, "../triplog/logs");
const argv = process.argv.slice(2);
const value = (f: string) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};
const cfg = JSON.parse(value("--cfg") ?? "{}") as Partial<TurnTrackerConfig>;
const speedCfg = JSON.parse(value("--speed") ?? "{}") as Partial<ImuSpeedConfig>;
const useObd = argv.includes("--obd");
// --route '<json>': the car follows a planned route, here the drawn one (the driver always follows the navigator):
// RouteFollower on it instead of the turn tracker.
const routeCfg = argv.includes("--route") ? (JSON.parse(value("--route") ?? "{}") as Partial<RouteFollowerConfig>) : null;
// --route-source log: the route the app planned first on the drive (its log) instead of the drawn one; drives without
// one are skipped. Every turn the follower reports is listed with its fit and whether the car was on that route then.
const routeFromLog = value("--route-source") === "log";
const turnFits: { on: boolean; fit: number }[] = [];
const movingVib = Number(value("--moving-vib") ?? 0.4);
// --stretch-oracle: phone speed scaled per stretch between OBD stops to OBD's distance over it (experiment).
const stretchOracle = argv.includes("--stretch-oracle");
// --phone-gaps (with --obd): OBD speed, but unknown wherever the phone's is.
const phoneGaps = argv.includes("--phone-gaps");
// --ensemble: also run the navigator's particle filter on the phone speed (its phone settings) and score ways of
// choosing between the two per second.
const ensemble = argv.includes("--ensemble");
const ensembleScores = new Map<string, { off: number; mv: number }>();

// --bumps '<json>': road jolts as landmarks. Places where jolts recur, from every other drive (positions by the drawn
// route's timing, as the app would take them from drives it navigated with OBD or GPS); the drive itself detects
// jolts from the phone alone. {"thresh":3,"clusterM":12,"minDrives":2}
const bumpCfg = argv.includes("--bumps") ? { thresh: 3, clusterM: 12, minDrives: 2, ...(JSON.parse(value("--bumps") ?? "{}") as object) } : null;
const bumpEvents: { drive: string; lat: number; lon: number }[] = [];

// --usage: roads used by every other drive (their drawn routes) weigh the hypotheses (`unusedExitLog`, `unusedLogPerM`).
const useUsage = argv.includes("--usage");
// --taps '{"offM":100,"afterS":30}': a simulated driver puts the car where it is (the drawn route's timed point and
// direction) once the dot has been more than `offM` off it for `afterS`; counted per 10 minutes of driving.
const tapCfg = argv.includes("--taps") ? { offM: 100, afterS: 30, ...(JSON.parse(value("--taps") ?? "{}") as object) } : null;
const tapAgg = { taps: 0, movingS: 0 };
/** Per drive, the edges (`${graph}:${id}`) its drawn route ran along. */
const usedEdges = new Map<string, Set<string>>();

function learnUsage(trip: TripLog, drawn: DrawnTruth, id: string): void {
  const region = regionPoint(trip);
  const graphFile = region ? findGraph(region) : null;
  if (!region || !graphFile) return;
  const { graph, close } = openGraph(graphFile, region);
  const frame = new LocalFrame(region);
  const mine = new Set<string>();
  try {
    for (const [, lat, lon] of drawnTruthTrack(trip, drawn).points) {
      const [e, n] = frame.toEnu({ lat, lon });
      const near = graph.edgesNear(e, n, 15).sort((a, b) => a.distanceM - b.distanceM)[0];
      if (near) mine.add(`${graphFile}:${near.edge.id}`);
    }
  } finally {
    close();
  }
  usedEdges.set(id, mine);
}

function roadUsedFor(id: string, graphFile: string): (edge: number) => boolean {
  const all = new Set<string>();
  for (const [other, set] of usedEdges) if (other !== id) for (const k of set) all.add(k);
  return (edge) => all.has(`${graphFile}:${edge}`);
}

/** Vertical jolts while moving (OBD ≥ 5 km/h), located by the drawn route's timing. */
function learnBumps(trip: TripLog, drawn: DrawnTruth, id: string): void {
  const track = drawnTruthTrack(trip, drawn);
  let oi = 0;
  let lastUs = -Infinity;
  for (const s of trip.imu) {
    const g = s.gravity;
    const n = Math.hypot(...g);
    const vert = (s.userAccel[0] * -g[0] + s.userAccel[1] * -g[1] + s.userAccel[2] * -g[2]) / n;
    if (Math.abs(vert) < bumpCfg!.thresh || s.tUs - lastUs < 2e6) continue;
    while (oi + 1 < trip.obdSpeed.length && trip.obdSpeed[oi + 1].tUs <= s.tUs) oi++;
    const ob = trip.obdSpeed[oi];
    if (!ob || ob.rawKph < 5 || s.tUs - ob.tUs > 2e6) continue;
    lastUs = s.tUs;
    const t = (s.tUs - trip.startUs) / 1e6;
    const p = track.points.find((x) => x[0] >= t);
    if (p) bumpEvents.push({ drive: id, lat: p[1], lon: p[2] });
  }
}

/** Places where jolts were felt on at least `minDrives` other drives. */
function bumpPlaces(except: string): { lat: number; lon: number }[] {
  const clusters: { lat: number; lon: number; drives: Set<string> }[] = [];
  for (const e of bumpEvents) {
    if (e.drive === except) continue;
    const c = clusters.find((x) => haversineM(x, e) <= bumpCfg!.clusterM);
    if (c) c.drives.add(e.drive);
    else clusters.push({ lat: e.lat, lon: e.lon, drives: new Set([e.drive]) });
  }
  return clusters.filter((c) => c.drives.size >= bumpCfg!.minDrives);
}
// --along: where the dot was along the drawn route next to the car (ahead, behind, or on another road), CITY drives.
const ALONG_BINS = [-Infinity, -1000, -300, -100, -30, 30, 100, 300, 1000, Infinity];
const ALONG_LABELS = ["behind > 1 km", "behind 300 m–1 km", "behind 100–300 m", "behind 30–100 m", "with the car (±30 m)", "ahead 30–100 m", "ahead 100–300 m", "ahead 300 m–1 km", "ahead > 1 km"];
const alongAgg = { bins: ALONG_BINS.slice(1).map(() => 0), off: 0, n: 0 };
const alongDrives: string[] = [];
const splitAgg = { earlyOff: 0, earlyMv: 0, lateOff: 0, lateMv: 0 };

/** The navigator (particle filter) on phone speed from the drawn start: per published estimate, position and state. */
function navigatorTrack(trip: TripLog, drawn: DrawnTruth, mounts: Map<string, PhoneMount>): { t: number; lat: number; lon: number; state: string; w: number }[] {
  const vin = carOf(trip, new Map());
  const graph = graphFor(trip);
  const calibration = new CalibrationStore(new MemoryKeyValueStore(), phoneOf(trip));
  const pose = vin ? drawnStartPose(trip, drawn) : null;
  if (pose && vin) calibration.saveParkedPose(vin, pose);
  try {
    const r = replayTripInApp(withPhoneSpeed(trip, {}, new Map(mounts)), {
      calibration,
      loop: "closed",
      roadGraph: graph?.active,
      vin,
      cuts: appOutageCuts(trip),
      nav: { obdSigmaMps: 1.5 },
      mapMatchConfig: { seed: 1, dksSigma: 0.15, dksWalk: 0.04, ekfPositionScale: 0, particles: 2000 },
    });
    let mi = 0;
    return r.published.map((p) => {
      while (mi + 1 < r.publishedMapMatch.length && r.publishedMapMatch[mi + 1].timestampUs <= p.timestampUs) mi++;
      const m = r.publishedMapMatch[mi];
      return { t: (p.timestampUs - trip.startUs) / 1e6, lat: p.latDeg, lon: p.lonDeg, state: m ? m.state : "off", w: m?.top[0]?.weight ?? 0 };
    });
  } finally {
    graph?.close();
  }
}

/** Per OBD stop-to-stop stretch: OBD distance / phone distance, as a step function over time. */
function stretchScales(trip: TripLog, speedCfgIn: Partial<ImuSpeedConfig>, mount: PhoneMount | null): { untilUs: number; k: number }[] {
  const est = new ImuSpeedEstimator(speedCfgIn, {}, mount);
  const out: { untilUs: number; k: number }[] = [];
  let oi = 0;
  let last: number | null = null;
  let obdM = 0;
  let phM = 0;
  for (const s of trip.imu) {
    const o = est.process(s);
    const dt = last === null ? 0 : Math.min(0.1, (s.tUs - last) / 1e6);
    last = s.tUs;
    while (oi + 1 < trip.obdSpeed.length && trip.obdSpeed[oi + 1].tUs <= s.tUs) oi++;
    const ob = trip.obdSpeed[oi];
    if (ob && ob.rawKph === 0 && obdM > 0) {
      out.push({ untilUs: s.tUs, k: phM > 5 ? Math.min(3, obdM / phM) : 1 });
      obdM = phM = 0;
    }
    if (ob) obdM += ob.speedMps * dt;
    phM += (Number.isFinite(o.speedMps) ? Math.max(0, o.speedMps) : 0) * dt;
  }
  out.push({ untilUs: Infinity, k: phM > 5 ? Math.min(3, obdM / phM) : 1 });
  return out;
}
const only = value("--logs");
const traceId = value("--trace");
// --obd-noise '{"scale":0.85,"stretchSigma":0.15,"seed":1}': OBD speed with a known error (with --obd): what the tracker
// tolerates. `stretchSigma`: a random scale per stretch between stops.
const obdNoise = JSON.parse(value("--obd-noise") ?? "{}") as { scale?: number; stretchSigma?: number; seed?: number };
let rng = obdNoise.seed ?? 1;
const gauss = () => {
  const u = () => ((rng = (rng * 1103515245 + 12345) % 2147483648) + 1) / 2147483649;
  return Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
};

/** Jammed city drives (no satellite fix while moving), the target; the rest are shown apart. */
const CITY = ["ng2n9z", "vwaz7t", "3afby6", "udvwff", "h5ivxa", "jyxdtb", "i7qmk4", "w6zckw", "df8nsk", "pxpcgw", "gaz9bc", "sfz6nv", "p7qgih"];

interface Result {
  id: string;
  movingS: number;
  offS: number;
  errM: number | null;
}

function run(trip: TripLog, drawn: DrawnTruth, mounts: Map<string, PhoneMount>, id: string): Result | null {
  const region = regionPoint(trip);
  const graphFile = region ? findGraph(region) : null;
  const pose = drawnStartPose(trip, drawn);
  if (!region || !graphFile || !pose) return null;
  const { graph, close } = openGraph(graphFile, region);
  const frame = new LocalFrame(region);
  try {
    const car = String(trip.info.vehicle_vin ?? trip.info.obd_protocol ?? "car");
    const est = new ImuSpeedEstimator(speedCfg, {}, mounts.get(car) ?? null);
    const tracker = new TurnTracker(graph, cfg, useUsage ? roadUsedFor(id, graphFile) : null);
    const places = bumpCfg ? bumpPlaces(id).map((q) => { const [e, n] = frame.toEnu(q); return { e, n }; }) : [];
    let lastJoltUs = -Infinity;
    let offSinceS: number | null = null;
    const scales = stretchOracle ? stretchScales(trip, speedCfg, mounts.get(car) ?? null) : null;
    let si = 0;
    const [e0, n0] = frame.toEnu(pose);
    tracker.start(e0, n0, pose.headingRad, pose.posSigmaM, pose.headingSigmaRad);
    const firstPlan = trip.navRoute[0];
    const planPts = firstPlan ? trip.navRoutePoints.filter((q) => q.planId === firstPlan.planId && q.tUs === firstPlan.tUs).map((q) => frame.toEnu({ lat: q.latDeg, lon: q.lonDeg })) : [];
    if (routeCfg && routeFromLog && planPts.length < 2) return null;
    const routeEnu = routeFromLog ? planPts : drawn.path.map(([lat, lon]) => frame.toEnu({ lat, lon }));
    // The car's distance from the route, to tell turns on it from turns off it.
    const offRouteM = (e: number, n: number) => {
      let best = Infinity;
      for (let i = 1; i < routeEnu.length; i++) {
        const [ax, ay] = routeEnu[i - 1];
        const [bx, by] = routeEnu[i];
        const dx = bx - ax, dy = by - ay;
        const l2 = dx * dx + dy * dy;
        const f = l2 > 0 ? Math.max(0, Math.min(1, ((e - ax) * dx + (n - ay) * dy) / l2)) : 0;
        best = Math.min(best, Math.hypot(e - ax - f * dx, n - ay - f * dy));
      }
      return best;
    };
    const follower = routeCfg ? new RouteFollower(routeEnu, routeCfg) : null;
    const fixes = trip.gnss;
    let fi = 0;
    let oi = 0;
    let acc = { dt: 0, yaw: 0, n: 0, valid: true, stopped: false, speed: NaN, vib: 0 };
    let lastUs: number | null = null;
    let stretchScale = 1;
    let nextOutS = 0;
    const track: ShownPoint[] = [];
    const shares: number[] = [];
    const truth = drawnTruthTrack(trip, drawn);
    for (const s of trip.imu) {
      const o = est.process(s);
      const dt = lastUs === null ? 0 : Math.min(0.1, (s.tUs - lastUs) / 1e6);
      lastUs = s.tUs;
      acc.dt += dt;
      acc.yaw += o.yawRate * dt;
      acc.valid &&= o.valid;
      acc.stopped = o.stopped;
      acc.speed = o.speedMps;
      acc.vib = o.vibrationMS2;
      if (bumpCfg && places.length && s.tUs - lastJoltUs > 2e6 && !o.stopped && o.vibrationMS2 >= movingVib) {
        const g = s.gravity;
        const gn = Math.hypot(...g);
        const vert = (s.userAccel[0] * -g[0] + s.userAccel[1] * -g[1] + s.userAccel[2] * -g[2]) / gn;
        if (Math.abs(vert) >= bumpCfg.thresh) {
          lastJoltUs = s.tUs;
          tracker.bump(places);
        }
      }
      if (scales) {
        while (si + 1 < scales.length && scales[si].untilUs < s.tUs) si++;
        acc.speed *= scales[si].k;
      }
      if (useObd) {
        while (oi + 1 < trip.obdSpeed.length && trip.obdSpeed[oi + 1].tUs <= s.tUs) oi++;
        const ob = trip.obdSpeed[oi];
        if (ob && ob.rawKph === 0) stretchScale = 1 + (obdNoise.stretchSigma ?? 0) * gauss();
        acc.speed = ob && s.tUs - ob.tUs < 2.5e6 ? ob.speedMps * (obdNoise.scale ?? 1) * Math.max(0.3, stretchScale) : NaN;
        if (phoneGaps && !Number.isFinite(o.speedMps)) acc.speed = NaN;
      }
      if (acc.dt < 0.1) continue;
      const step = { tUs: s.tUs, dtS: acc.dt, speedMps: acc.speed, yawRate: acc.yaw / acc.dt, valid: acc.valid, stopped: acc.stopped, moving: acc.vib >= movingVib };
      if (follower) {
        follower.step(step);
        for (const turn of follower.takeTurns()) {
          const tt = (turn.tUs - trip.startUs) / 1e6;
          const tp = truth.points.find((x) => x[0] >= tt - 4);
          const [te, tn] = tp ? frame.toEnu({ lat: tp[1], lon: tp[2] }) : [NaN, NaN];
          const on = tp ? offRouteM(te, tn) <= 30 : true;
          turnFits.push({ on, fit: turn.fit });
          if (process.env.TURNS) console.log(`    ${id} ${tt.toFixed(0).padStart(5)} s turn ${((turn.turnedRad * 180) / Math.PI).toFixed(0).padStart(4)}° fit ${turn.fit.toFixed(2)} ${on ? "on the route" : "OFF the route"}`);
        }
      } else tracker.step(step);
      acc = { dt: 0, yaw: 0, n: 0, valid: true, stopped: false, speed: NaN, vib: 0 };
      while (fi < fixes.length && fixes[fi].tUs <= s.tUs) {
        const f = fixes[fi++];
        const [fe, fn] = frame.toEnu(f);
        (follower ?? tracker).fix(f.tUs, fe, fn, isSatelliteFix(f) ? Math.max(5, f.hAccM) : f.hAccM);
      }
      const t = (s.tUs - trip.startUs) / 1e6;
      if (t >= nextOutS) {
        nextOutS = t + 1;
        const fe2 = follower?.estimate();
        const est2 = fe2 ? { e: fe2.e, n: fe2.n, headingRad: fe2.headingRad, sigmaM: 0, hypotheses: 1, share: fe2.share } : tracker.estimate();
        if (est2 && tapCfg) {
          const i = truth.points.findIndex((x) => x[0] >= t);
          const tp = truth.points[i];
          const c0 = frame.toCoordinate(est2.e, est2.n);
          if (tp && haversineM({ lat: tp[1], lon: tp[2] }, c0) > tapCfg.offM) offSinceS ??= t;
          else offSinceS = null;
          if (tp && offSinceS !== null && t - offSinceS >= tapCfg.afterS) {
            const ahead = truth.points[Math.min(truth.points.length - 1, i + 3)];
            const [te, tn] = frame.toEnu({ lat: tp[1], lon: tp[2] });
            const [ae, an] = frame.toEnu({ lat: ahead[1], lon: ahead[2] });
            const heading = Math.hypot(ae - te, an - tn) > 3 ? Math.atan2(ae - te, an - tn) : est2.headingRad;
            tracker.restart(te, tn, heading, 15, (15 * Math.PI) / 180);
            offSinceS = null;
            if (CITY.includes(id)) tapAgg.taps++;
          }
        }
        if (fe2 && traceId === id && Math.round(t) % Number(process.env.EVERY ?? 5) === 0) {
          const tp = truth.points.find((p) => p[0] >= t);
          const rh = (follower as unknown as { heading: Float64Array }).heading;
          const cell = tp ? Math.min(rh.length - 1, Math.round(tp[3] / 5)) : 0;
          console.log(`${t.toFixed(0).padStart(5)} along ${fe2.alongM.toFixed(0).padStart(5)} truth ${tp?.[3].toFixed(0).padStart(5)} share ${(fe2.share * 100).toFixed(0).padStart(3)}% k ${fe2.scale} σ ${fe2.sigmaM.toFixed(0)} heading ${((fe2.headingRad * 180) / Math.PI).toFixed(0).padStart(4)} route@truth ${((rh[cell] * 180) / Math.PI).toFixed(0).padStart(4)} speed ${step.speedMps.toFixed(1)}`);
        }
        if (est2) {
          const c = frame.toCoordinate(est2.e, est2.n);
          track.push({ t, lat: c.lat, lon: c.lon, acc: est2.sigmaM });
          shares.push(est2.share);
          const every = Number(process.env.EVERY ?? 5);
          if (traceId && id === traceId && Math.round(t) % every === 0 && t >= Number(process.env.FROM ?? 0) && t <= Number(process.env.TO ?? 1e9)) {
            if (process.env.HYPS) for (const x of tracker.hypotheses().sort((a, b) => b.logW - a.logW).slice(0, 6)) console.log(`      ${x.free ? "free" : "road"} logW ${x.logW.toFixed(2)} σ ${x.sigma.toFixed(0)} k ${x.k.toFixed(2)} overrun ${x.overrun.toFixed(0)} at ${x.e.toFixed(0)},${x.n.toFixed(0)} heading ${(x.heading * 57.3).toFixed(0)}`);
            const tp = truth.points.find((p) => p[0] >= t);
            const off = tp ? haversineM({ lat: tp[1], lon: tp[2] }, c) : NaN;
            let near = { d: Infinity, gap: NaN, free: false, sigma: 0, k: 0, ledger: {} as Record<string, number> };
            const leader = tracker.hypotheses().reduce((a, b) => (b.logW > a.logW ? b : a));
            if (tp) {
              const [te, tn] = frame.toEnu({ lat: tp[1], lon: tp[2] });
              const hs = tracker.hypotheses();
              const top = Math.max(...hs.map((x) => x.logW));
              for (const x of hs) {
                const d = Math.hypot(x.e - te, x.n - tn);
                if (d < near.d) near = { d, gap: top - x.logW, free: x.free, sigma: x.sigma, k: x.k, ledger: x.ledger };
              }
            }
            const top = (tracker as unknown as { hyps: { edge: number; dir: 1 | -1; offset: number; overrunM: number; k: number }[] }).hyps[0];
            const edge = top && top.edge >= 0 ? graph.edge(top.edge) : null;
            const exits = top && edge ? graph.exits(top.edge, top.dir).map((x) => `${Math.round((x.turnRad * 180) / Math.PI)}°${x.uTurn ? "u" : ""}${x.restricted ? "r" : ""}${x.againstOneway ? "o" : ""}`).join(",") : "";
            const node = edge && top ? graph.node(top.dir === 1 ? edge.to : edge.from) : null;
            if (process.env.LEDGER) {
              const keys = [...new Set([...Object.keys(leader.ledger), ...Object.keys(near.ledger)])].sort();
              console.log(`      ledger leader-nearest: ${keys.map((k) => `${k} ${((leader.ledger[k] ?? 0) - (near.ledger[k] ?? 0)).toFixed(1)}`).join("  ")}`);
            }
            console.log(
              `  top: edge ${top?.edge} dir ${top?.dir} at ${top?.offset.toFixed(0)}/${edge ? edge.cum[edge.cum.length - 1].toFixed(0) : "-"} m overrun ${top?.overrunM.toFixed(0)} k ${top?.k.toFixed(2)} cls ${edge?.cls} oneway ${edge?.oneway} node flags ${node?.flags} edges ${node?.edges.length} exits [${exits}]`,
            );
            console.log(
              `${t.toFixed(0).padStart(5)} hyps ${String(est2.hypotheses).padStart(3)} share ${(est2.share * 100).toFixed(0).padStart(3)}% σ ${est2.sigmaM.toFixed(0).padStart(3)} off truth ${off.toFixed(0).padStart(5)} m  nearest ${near.d.toFixed(0).padStart(4)} m ${near.free ? "free" : "road"} ${near.gap.toFixed(1).padStart(5)} below (σ ${near.sigma.toFixed(0)} k ${near.k.toFixed(2)}) turnOpen ${(tracker as unknown as { turn: unknown }).turn ? 1 : 0} psi ${(((tracker as unknown as { psi: number }).psi * 180) / Math.PI).toFixed(0)} rateLp ${(((tracker as unknown as { rateLp: number }).rateLp * 180) / Math.PI).toFixed(1)} leader ${leader.free ? "free" : "road"} σ ${leader.sigma.toFixed(0)} k ${leader.k.toFixed(2)} overrun ${leader.overrun.toFixed(0)}  turns ${tracker.stats.turns} snaps ${tracker.stats.snaps} emptied ${tracker.stats.emptied}`,
            );
          }
        }
      }
    }
    const m = est.mount;
    if (m) mounts.set(car, m);
    if (process.env.STATS) console.log(`  ${id} stats ${JSON.stringify(tracker.stats)}`);
    if (ensemble) {
      const nav = navigatorTrack(trip, drawn, mounts);
      let ni = 0;
      const navAt = (t: number) => {
        while (ni + 1 < nav.length && nav[ni + 1].t <= t) ni++;
        return nav[ni];
      };
      const truthAt = (t: number) => truth.points.find((p) => p[0] >= t);
      const rules: Record<string, (i: number, n: ReturnType<typeof navAt>) => boolean> = {
        tracker: () => true,
        navigator: () => false,
        oracle: (i, n) => {
          const tp = truthAt(track[i].t);
          return !tp || !n || haversineM({ lat: tp[1], lon: tp[2] }, track[i]) <= haversineM({ lat: tp[1], lon: tp[2] }, n);
        },
        navNotTracking: (_i, n) => !n || n.state !== "tracking",
        share50: (i) => shares[i] >= 0.5,
        navW90: (_i, n) => !n || n.w < 0.9,
      };
      for (const [name, useTracker] of Object.entries(rules)) {
        ni = 0;
        const combined: ShownPoint[] = track.map((p, i) => {
          const n = navAt(p.t);
          return useTracker(i, n) || !n ? p : { t: p.t, lat: n.lat, lon: n.lon, acc: 0 };
        });
        const sc2 = scoreDrawn(trip, truth, combined);
        const agg = ensembleScores.get(name) ?? { off: 0, mv: 0 };
        if (CITY.includes(id)) {
          agg.off += sc2.offPathS;
          agg.mv += sc2.movingS;
        }
        ensembleScores.set(name, agg);
        if (process.env.ENSEMBLE_DRIVES) console.log(`    ${id} ${name}: ${Math.round((100 * sc2.offPathS) / Math.max(1, sc2.movingS))}%`);
      }
    }
    const sc = scoreDrawn(trip, truth, track);
    if (argv.includes("--along") && CITY.includes(id)) {
      const along = alongDrawn(trip, truth, track);
      const on = along.filter((x) => x.aheadM !== null).map((x) => x.aheadM!);
      for (const a of on) alongAgg.bins[ALONG_BINS.findIndex((b, i) => a >= b && a < ALONG_BINS[i + 1])]++;
      alongAgg.off += along.length - on.length;
      alongAgg.n += along.length;
      const sorted = [...on].sort((a, b) => a - b);
      const pct = (f: (a: number) => boolean) => Math.round((100 * on.filter(f).length) / Math.max(1, along.length));
      alongDrives.push(
        `  ${id}: behind >30 m ${String(pct((a) => a < -30)).padStart(3)}%, ahead >30 m ${String(pct((a) => a > 30)).padStart(3)}%, other road ${String(Math.round((100 * (along.length - on.length)) / Math.max(1, along.length))).padStart(3)}%; on route median ${sorted.length ? Math.round(sorted[sorted.length >> 1]) : "–"} m`,
      );
    }
    if (tapCfg && CITY.includes(id)) tapAgg.movingS += sc.movingS;
    if (process.env.SPLIT) {
      const cut = Number(process.env.SPLIT);
      const early = scoreDrawn(trip, truth, track.filter((p) => p.t < cut));
      const late = scoreDrawn(trip, truth, track.filter((p) => p.t >= cut));
      if (CITY.includes(id)) {
        splitAgg.earlyOff += early.offPathS;
        splitAgg.earlyMv += early.movingS;
        splitAgg.lateOff += late.offPathS;
        splitAgg.lateMv += late.movingS;
      }
    }
    return { id, movingS: sc.movingS, offS: sc.offPathS, errM: sc.errorMedianM };
  } finally {
    close();
  }
}

if (useUsage)
  for (const f of readdirSync(LOGS).filter((x) => x.endsWith(".ulg")).sort()) {
    const truthFile = path.join(LOGS, f.replace(/\.ulg$/, ".truth.json"));
    if (!existsSync(truthFile)) continue;
    learnUsage(readTripLog(new Uint8Array(readFileSync(path.join(LOGS, f)))), JSON.parse(readFileSync(truthFile, "utf8")) as DrawnTruth, f.slice(16, 22));
  }

if (bumpCfg)
  for (const f of readdirSync(LOGS).filter((x) => x.endsWith(".ulg")).sort()) {
    const truthFile = path.join(LOGS, f.replace(/\.ulg$/, ".truth.json"));
    if (!existsSync(truthFile)) continue;
    learnBumps(readTripLog(new Uint8Array(readFileSync(path.join(LOGS, f)))), JSON.parse(readFileSync(truthFile, "utf8")) as DrawnTruth, f.slice(16, 22));
  }

const mounts = new Map<string, PhoneMount>();
const results: Result[] = [];
for (const f of readdirSync(LOGS).filter((x) => x.endsWith(".ulg")).sort()) {
  const id = f.slice(16, 22);
  const truthFile = path.join(LOGS, f.replace(/\.ulg$/, ".truth.json"));
  const trip = readTripLog(new Uint8Array(readFileSync(path.join(LOGS, f))));
  if (!existsSync(truthFile) || (only && !f.includes(only))) {
    // Keep the mount chain going.
    const car = String(trip.info.vehicle_vin ?? trip.info.obd_protocol ?? "car");
    const est = new ImuSpeedEstimator(speedCfg, {}, mounts.get(car) ?? null);
    for (const s of trip.imu) est.process(s);
    if (est.mount) mounts.set(car, est.mount);
    continue;
  }
  const r = run(trip, JSON.parse(readFileSync(truthFile, "utf8")) as DrawnTruth, mounts, id);
  if (!r || r.movingS < 30) continue;
  results.push(r);
  console.log(`${id}${CITY.includes(id) ? " city" : "     "}  off the drawn route ${String(Math.round((100 * r.offS) / r.movingS)).padStart(3)}% of ${r.movingS.toFixed(0).padStart(4)} s, median error ${r.errM?.toFixed(0) ?? "–"} m`);
}
const sum = (rs: Result[]) => {
  const mv = rs.reduce((a, r) => a + r.movingS, 0);
  const off = rs.reduce((a, r) => a + r.offS, 0);
  const worst = Math.max(...rs.map((r) => (100 * r.offS) / r.movingS));
  const errs = rs.map((r) => r.errM ?? 9999).sort((a, b) => a - b);
  return `${Math.round((100 * off) / mv)}% (worst ${Math.round(worst)}%, median error ${Math.round(errs[Math.floor((errs.length - 1) / 2)])} m)`;
};
const city = results.filter((r) => CITY.includes(r.id));
console.log(`\nCITY jammed (${city.length}): ${sum(city)}   others (${results.length - city.length}): ${sum(results.filter((r) => !CITY.includes(r.id)))}`);
if (tapCfg) console.log(`  taps: ${tapAgg.taps} over ${Math.round(tapAgg.movingS / 60)} min of city driving (${((10 * 60 * tapAgg.taps) / tapAgg.movingS).toFixed(1)} per 10 min)`);
if (process.env.SPLIT)
  console.log(
    `  first ${process.env.SPLIT} s: ${Math.round((100 * splitAgg.earlyOff) / splitAgg.earlyMv)}% of ${Math.round(splitAgg.earlyMv)} s; after: ${Math.round((100 * splitAgg.lateOff) / splitAgg.lateMv)}% of ${Math.round(splitAgg.lateMv)} s`,
  );
for (const [name, a] of ensembleScores) console.log(`  ensemble ${name}: CITY ${Math.round((100 * a.off) / a.mv)}%`);
if (argv.includes("--along")) {
  console.log(`
where the dot was along the drawn route, CITY moving time (${Math.round(alongAgg.n / 60)} min):`);
  ALONG_LABELS.forEach((l, i) => console.log(`  ${l.padEnd(22)} ${String(Math.round((100 * alongAgg.bins[i]) / alongAgg.n)).padStart(3)}%`));
  console.log(`  ${"on another road".padEnd(22)} ${String(Math.round((100 * alongAgg.off) / alongAgg.n)).padStart(3)}%`);
  for (const l of alongDrives) console.log(l);
}
if (routeCfg) {
  const q = (xs: number[], f: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(f * xs.length))].toFixed(2) : "–");
  for (const on of [true, false]) {
    const xs = turnFits.filter((x) => x.on === on).map((x) => x.fit);
    console.log(`  turns ${on ? "on the route " : "off the route"}: ${xs.length}, fit p5 ${q(xs, 0.05)} p10 ${q(xs, 0.1)} median ${q(xs, 0.5)} p90 ${q(xs, 0.9)}; below 0.3: ${xs.filter((x) => x < 0.3).length}, below 0.4: ${xs.filter((x) => x < 0.4).length}, below 0.5: ${xs.filter((x) => x < 0.5).length}`);
  }
}
