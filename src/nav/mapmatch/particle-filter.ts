// Road-constrained particle filter (MAPMATCH-SPEC §7): where on the road network the car is.
// Driven by the navigator's calibrated odometry (§6.1); weighted by how the road turns compared
// with how the car turned, weakly by the EKF heading, and by accepted GNSS fixes. Particles live
// in typed arrays (structure of arrays) for Hermes. Pure TS.

import type { OdometryStep } from "../odometry/odometry-output";
import { EdgeFlag, NodeFlag, Oneway, RoadClass } from "./graph/format";
import type { EdgeId, Exit, NearEdge, RoadEdge, RoadGraph } from "./graph/road-graph";

export interface MapMatchConfig {
  /** Particle count while tracking (N_track). */
  particles: number;
  /** Upper bound for an unknown-heading start (N_max, §7.2). */
  maxParticles: number;
  /** Unknown-heading start: one particle per this much road per direction, m. */
  initSpacingM: number;
  /** Unknown-heading start: wait while the anchor radius is larger than this (cost and hypothesis count), m. */
  unknownMaxRadiusM: number;
  /**
   * Until an unknown-heading start first tracks, this share of particles is re-seeded at each resampling
   * on all roads of the search region (the navigator's anchor), with a neutral turn history: a true road
   * pruned early (an unmapped yard, an unlucky turn sequence) can come back.
   */
  initReinjectShare: number;
  /**
   * Heading from the map (§8, the navigator): start the EKF once the heading has been settled over
   * `mapStartTrackingM`: the filter tracks one hypothesis, or one travel direction holds `trackingWeight`
   * with a heading spread ≤ `mapStartHeadingSpreadRad` and a position spread ≤ `mapStartSpreadM` (one
   * direction along one road: the turn that will fix the position along it hasn't come yet). σ floored
   * at the `mapStartMin*` values.
   */
  mapStartTrackingM: number;
  mapStartHeadingSpreadRad: number;
  /**
   * A map start also needs the start's travel direction to hold this share of the weight without the
   * compass (§8.2): the compass may tip a contest the roads already lean on, never overturn it.
   */
  mapStartCompassFreeShare: number;
  mapStartSpreadM: number;
  mapStartMinPosSigmaM: number;
  mapStartMinHeadingSigmaRad: number;
  /**
   * Heading σ at a map start grows by the position spread × this: roads bend, and a cloud ahead of or
   * behind the car along a bend carries the road heading of another place (rad per m).
   */
  mapStartCurvatureRadPerM: number;
  /**
   * A map start waits until most weight (`trackingWeight`) is where the road is straight: heading
   * within `mapStartRoadStraightRad` over ±(`mapStartRoadWindowM` + the position spread). A polyline
   * bends at a vertex, the car gradually, so near a bend the road heading is not the car's; and the car
   * may be anywhere within the spread.
   */
  mapStartRoadWindowM: number;
  mapStartRoadStraightRad: number;
  /**
   * An EKF started by a course, alignment or parked pose keeps a filter that is `tracking` with its top
   * cluster within 3σ of the EKF plus these margins; otherwise the filter restarts around the EKF.
   */
  agreeMarginM: number;
  agreeMarginRad: number;
  /** Minimum share of off-road particles (parking lots, roads missing from OSM). */
  offRoadShare: number;
  /**
   * Resample when the off-road particles hold less weight than this. Their penalty accumulates while
   * the car follows a road, and without resampling they drift away from it: when the car then leaves
   * the road, none would be near it or heavy enough to take over. Resampling makes fresh off-road
   * copies of the on-road particles.
   */
  offRoadMinWeight: number;
  /**
   * Minimum share of on-road particles while off-road dominates: off-road particles projected onto
   * the nearest aligned edge, so the car is re-locked where it comes back onto a road.
   */
  onRoadShare: number;
  onRoadProjectM: number;
  onRoadProjectHeadingRad: number;
  /** Share re-injected near the clusters at each resampling (recovers a pruned hypothesis). */
  reinjectShare: number;
  /** Weighting interval, m of travel. */
  evalIntervalM: number;
  /**
   * The relative-heading term compares turns between two moments when the car drives straight (turned
   * less than `straightTurnRad` over the last `straightWindowM`): then a whole turn is inside the
   * comparison for the car and for the road. Mid-turn the car turns gradually while a road polyline
   * turns at its vertex, and a few metres of along-track offset look like a large heading error.
   */
  straightTurnRad: number;
  straightWindowM: number;
  /** Without a straight moment for this long (a long curve), compare anyway with `curveShare` tolerance. */
  maxCompareM: number;
  /** OSM geometry error, rad, and the tolerance as a share of the turn (radius, lane, simplification). */
  roadSigmaRad: number;
  turnShare: number;
  curveShare: number;
  /** Absolute heading: EKF σ_ψ widened by this, and the term scaled down (its errors are correlated). */
  absHeadingInflation: number;
  absHeadingScale: number;
  /**
   * Compass (§8.2), only while the heading is unknown: one standing look. At each straight moment a
   * particle's compass factor, inlier · Gaussian(travel direction − compass, σ) + (1 − inlier), replaces
   * the one already in its weight (only the change is applied). Its error is a bias that lasts the drive,
   * so it must not add up; but it stays in force through resampling and follows particles that turn.
   * The best and the worst direction differ by at most 1 / (1 − inlier).
   */
  compassInlier: number;
  /** Lane offset: distance from the centre line up to this costs on-road particles nothing at a fix, m. */
  laneHalfWidthM: number;
  /** Lane offset beyond the dead zone, added to the fix σ, m. */
  laneSigmaM: number;
  /** Fixes count only this far apart along the track (their errors are correlated; a standing car adds nothing), m. */
  fixSpacingM: number;
  /** Coarse (Wi-Fi/cell) fixes: σ inflation, and their own spacing. */
  coarseInflation: number;
  coarseSpacingM: number;
  /**
   * The EKF position as a weak prior at each weighting (open loop): σ = max(inflation × EKF σ, floor),
   * term scaled down for correlation. It carries the absolute heading the EKF integrated, which keeps a
   * hypothesis on a road far from the dead-reckoned position from winning. 0 switches it off.
   */
  ekfPositionScale: number;
  ekfPositionInflation: number;
  ekfPositionFloorM: number;
  /** Per-particle distance scale: prior σ and jitter at resampling. */
  dksSigma: number;
  dksJitter: number;
  /** White along-track noise, share of each step. */
  alongNoise: number;
  /** Off-road heading noise, rad/√m. */
  offRoadHeadingNoise: number;
  /** Log-likelihood added to off-road particles at each weighting instead of the relative-heading term. */
  offRoadLogPenalty: number;
  /** An off-road particle this close to an edge and this aligned with it may snap onto it, with this chance per step. */
  snapRadiusM: number;
  snapHeadingRad: number;
  snapProbability: number;
  /** A U-turn on an edge: allowed when the car turned more than this over the last `uTurnWindowM`. */
  uTurnTurnRad: number;
  uTurnWindowM: number;
  uTurnShare: number;
  /** Soft OSM rules at nodes (§7.3): probability factors. */
  againstOnewayFactor: number;
  restrictedFactor: number;
  uTurnFactor: number;
  privateFactor: number;
  serviceFactor: number;
  /** Clustering (§7.6). Greedy clustering stops after `maxClusters` (the rest holds little weight). */
  clusterRadiusM: number;
  clusterHeadingRad: number;
  maxClusters: number;
  trackingWeight: number;
  trackingSpreadM: number;
  /** Init around a known pose: candidate radius (σ multiples, minimum) and heading margin. */
  initSigmas: number;
  initMinRadiusM: number;
  initHeadingMarginRad: number;
  /** Working set: tiles within 3 × spread + margin of each cluster, refreshed every `workingSetEveryM`. */
  workingSetMarginM: number;
  workingSetEveryM: number;
  /** A fix farther than this many σ from every particle means the filter lost the car. */
  lostSigmas: number;
  seed: number;
}

const DEG = Math.PI / 180;

export const DEFAULT_MAP_MATCH: MapMatchConfig = {
  particles: 500,
  maxParticles: 4000,
  initSpacingM: 10,
  unknownMaxRadiusM: 1000,
  initReinjectShare: 0.05,
  mapStartTrackingM: 100,
  mapStartHeadingSpreadRad: 10 * DEG,
  mapStartCompassFreeShare: 0.5,
  mapStartSpreadM: 150,
  mapStartMinPosSigmaM: 10,
  mapStartMinHeadingSigmaRad: 3 * DEG,
  mapStartCurvatureRadPerM: 0.1 * DEG,
  mapStartRoadWindowM: 15,
  mapStartRoadStraightRad: 5 * DEG,
  agreeMarginM: 30,
  agreeMarginRad: 30 * DEG,
  offRoadShare: 0.05,
  offRoadMinWeight: 1e-5,
  onRoadShare: 0.1,
  onRoadProjectM: 15,
  onRoadProjectHeadingRad: 30 * DEG,
  reinjectShare: 0.02,
  evalIntervalM: 10,
  straightTurnRad: 8 * DEG,
  straightWindowM: 10,
  maxCompareM: 20,
  roadSigmaRad: 5 * DEG,
  turnShare: 0.1,
  curveShare: 0.3,
  absHeadingInflation: 3,
  absHeadingScale: 0.3,
  compassInlier: 0.85,
  laneHalfWidthM: 3,
  laneSigmaM: 2,
  fixSpacingM: 10,
  coarseInflation: 2,
  coarseSpacingM: 25,
  ekfPositionScale: 0.3,
  ekfPositionInflation: 2,
  ekfPositionFloorM: 10,
  dksSigma: 0.02,
  dksJitter: 0.002,
  alongNoise: 0.03,
  offRoadHeadingNoise: 0.01,
  offRoadLogPenalty: Math.log(0.5),
  snapRadiusM: 5,
  snapHeadingRad: 20 * DEG,
  snapProbability: 0.02,
  uTurnTurnRad: 135 * DEG,
  uTurnWindowM: 20,
  uTurnShare: 0.2,
  againstOnewayFactor: 0.02,
  restrictedFactor: 0.05,
  uTurnFactor: 0.01,
  privateFactor: 0.3,
  serviceFactor: 0.5,
  clusterRadiusM: 30,
  clusterHeadingRad: 45 * DEG,
  maxClusters: 64,
  trackingWeight: 0.9,
  trackingSpreadM: 25,
  initSigmas: 3,
  initMinRadiusM: 20,
  initHeadingMarginRad: 10 * DEG,
  workingSetMarginM: 300,
  workingSetEveryM: 50,
  lostSigmas: 5,
  seed: 1,
};

export type MapMatchState = "off" | "init" | "tracking" | "multimodal" | "offroad";

export interface MapMatchCluster {
  /** Share of the total weight. */
  weight: number;
  /** Weighted mean position in the local frame, m. */
  e: number;
  n: number;
  /** Circular-mean travel heading, clockwise from north. */
  headingRad: number;
  /** Circular standard deviation of the travel headings. */
  headingSpreadRad: number;
  /** Weighted RMS distance from the mean, m. */
  spreadM: number;
  /** Weighted position covariance [EE, EN, NN], m² (the closed loop's position measurement, §9). */
  covariance: [number, number, number];
  /** Edge holding the most weight (null: off-road cluster). */
  edge: EdgeId | null;
  particles: number;
}

export interface MapMatchOutput {
  state: MapMatchState;
  /** Up to 5, heaviest first. */
  clusters: MapMatchCluster[];
  particles: number;
  /** Duration of the last update (odometry chunk or fix), ms. */
  updateMs: number;
}

/** EKF pose for the weak absolute-heading and position terms (mode dr). */
export interface EkfPrior {
  psi: number;
  psiSigma: number;
  e: number;
  n: number;
  posSigma: number;
}

const TWO_PI = 2 * Math.PI;
const wrap = (a: number) => a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI);
const edgeLength = (e: RoadEdge) => e.cum[e.cum.length - 1];
const now = () => globalThis.performance?.now() ?? Date.now();

function rng(seed: number) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(TWO_PI * uniform());
  return { uniform, gauss };
}

interface ExitChoice {
  exits: Exit[];
  /** Cumulative probabilities. */
  cum: number[];
}

/** A stretch [a, b] (m along the geometry) of an edge inside a circle. */
interface Span {
  edge: RoadEdge;
  a: number;
  b: number;
}

/** The parts of the edges that lie within `radius` of (e, n), segment by segment. */
function spansInCircle(near: NearEdge[], e: number, n: number, radius: number): Span[] {
  const out: Span[] = [];
  const r2 = radius * radius;
  for (const { edge } of near) {
    const { xy, cum } = edge;
    let open: Span | null = null;
    for (let s = 0; s + 1 < cum.length; s++) {
      const len = cum[s + 1] - cum[s];
      if (len <= 0) continue;
      // |p0 + t·d − c|² = r² for t in [0, 1], d the segment.
      const px = xy[2 * s] - e;
      const py = xy[2 * s + 1] - n;
      const dx = xy[2 * s + 2] - xy[2 * s];
      const dy = xy[2 * s + 3] - xy[2 * s + 1];
      const qa = dx * dx + dy * dy;
      const qb = px * dx + py * dy;
      const disc = qb * qb - qa * (px * px + py * py - r2);
      if (disc <= 0) {
        open = null;
        continue;
      }
      const root = Math.sqrt(disc);
      const t0 = Math.max(0, (-qb - root) / qa);
      const t1 = Math.min(1, (-qb + root) / qa);
      if (t1 <= t0) {
        open = null;
        continue;
      }
      const a = cum[s] + t0 * len;
      const b = cum[s] + t1 * len;
      // Consecutive segments inside the circle form one span.
      if (open && Math.abs(open.b - a) < 1e-6) open.b = b;
      else out.push((open = { edge, a, b }));
      if (t1 < 1) open = null;
    }
  }
  return out;
}

/** Per-particle state, one typed array per field. */
class Particles {
  readonly offRoad: Uint8Array;
  readonly edge: Float64Array;
  readonly offset: Float64Array;
  readonly dir: Int8Array;
  readonly e: Float64Array;
  readonly n: Float64Array;
  readonly psi: Float64Array;
  readonly dks: Float64Array;
  /** Cumulative unwrapped heading change along the particle's own path. */
  readonly roadTurn: Float64Array;
  /** `roadTurn` at the last comparison (the anchor of the relative-heading term). */
  readonly anchorTurn: Float64Array;
  /** The compass log-likelihood in this particle's weight (§8.2): replaced at each look, never added twice. */
  readonly compassLog: Float64Array;
  readonly logw: Float64Array;

  constructor(readonly size: number) {
    this.offRoad = new Uint8Array(size);
    this.edge = new Float64Array(size);
    this.offset = new Float64Array(size);
    this.dir = new Int8Array(size);
    this.e = new Float64Array(size);
    this.n = new Float64Array(size);
    this.psi = new Float64Array(size);
    this.dks = new Float64Array(size);
    this.roadTurn = new Float64Array(size);
    this.anchorTurn = new Float64Array(size);
    this.compassLog = new Float64Array(size);
    this.logw = new Float64Array(size);
  }

  copy(from: Particles, src: number, dst: number): void {
    this.offRoad[dst] = from.offRoad[src];
    this.edge[dst] = from.edge[src];
    this.offset[dst] = from.offset[src];
    this.dir[dst] = from.dir[src];
    this.e[dst] = from.e[src];
    this.n[dst] = from.n[src];
    this.psi[dst] = from.psi[src];
    this.dks[dst] = from.dks[src];
    this.roadTurn[dst] = from.roadTurn[src];
    this.anchorTurn[dst] = from.anchorTurn[src];
    this.compassLog[dst] = from.compassLog[src];
    this.logw[dst] = from.logw[src];
  }
}

export class ParticleFilter {
  readonly config: MapMatchConfig;
  private p: Particles;
  private spare: Particles;
  private readonly random: ReturnType<typeof rng>;
  private active = false;
  /** False after an unknown-heading start until the filter first tracks (state `init`, §7.6). */
  private resolved = true;
  /** Unknown heading: where the car can be (centre, radius at odometry distance `atM`), and its roads. */
  private region: { e: number; n: number; radiusM: number; atM: number } | null = null;
  private regionSpans: { e: number; n: number; radiusM: number; spans: Span[]; starts: number[]; total: number } | null = null;
  private readonly exitCache = new Map<string, ExitChoice>();

  /** Odometry totals at the last chunk (from the navigator: distance, turn, and a running sum of turn variance). */
  private distanceM = 0;
  private turnRad = 0;
  private turnVarSum = 0;
  private speedMps = 0;
  /** Weighting schedule; the anchor of the relative-heading term (navigator distance, turn, variance sum). */
  private nextEvalM = 0;
  private anchorM = 0;
  private anchorTurnRad = 0;
  private anchorVar = 0;
  private lastYawUnknownM = -Infinity;
  private nextWorkingSetM = 0;
  private lastCoarseM = -Infinity;
  private lastFixM = -Infinity;
  private compass: { psi: number; sigma: number } | null = null;
  /** The car moved since the last weighting: a stop then closes the turn comparison. */
  private movedSinceEval = false;
  /** Recent (distance, turn) for the U-turn and straight tests. */
  private recentTurns: { d: number; turn: number }[] = [];
  private cached: MapMatchOutput | null = null;
  private lastUpdateMs = 0;
  /** Durations of every update, ms (replay statistics). */
  readonly updateTimes: number[] = [];
  /**
   * Durations of every start (`init`, `initUnknown`), ms, apart from the updates: a start lays particles on every
   * road around the car, and the first one reads those roads from storage (several times an update's cost).
   */
  readonly startTimes: number[] = [];

  constructor(
    private readonly graph: RoadGraph,
    config: Partial<MapMatchConfig> = {},
  ) {
    this.config = { ...DEFAULT_MAP_MATCH, ...config };
    this.p = new Particles(this.config.particles);
    this.spare = new Particles(this.config.particles);
    this.random = rng(this.config.seed);
  }

  get isActive(): boolean {
    return this.active;
  }

  get size(): number {
    return this.p.size;
  }

  /** The heading was unknown at the start and the filter hasn't tracked yet (state `init`). */
  get initializing(): boolean {
    return this.active && !this.resolved;
  }

  /**
   * Start around a known pose (§7.2): particles on edges within 3σ whose direction fits the
   * heading, weighted by the position likelihood; the off-road share at the pose. `distanceM` /
   * `turnRad` are the odometry totals now, so turn comparisons start here.
   */
  init(e: number, n: number, posSigmaM: number, psi: number, psiSigma: number, odometry: { distanceM: number; turnRad: number }): void {
    const c = this.config;
    const t0 = now();
    this.allocate(c.particles);
    this.begin(odometry);
    this.resolved = true;
    const radius = Math.max(c.initMinRadiusM, c.initSigmas * posSigmaM);
    const margin = c.initSigmas * psiSigma + c.initHeadingMarginRad;
    const candidates: { edge: RoadEdge; dir: 1 | -1; along: number }[] = [];
    for (const near of this.graph.edgesNear(e, n, radius)) {
      for (const dir of [1, -1] as const) {
        const heading = dir === 1 ? near.headingRad : near.headingRad + Math.PI;
        if (Math.abs(wrap(heading - psi)) <= margin) candidates.push({ edge: near.edge, dir, along: near.alongM });
      }
    }
    const p = this.p;
    const offRoad = candidates.length ? Math.ceil(c.offRoadShare * p.size) : p.size;
    const sigma2 = posSigmaM * posSigmaM + c.laneSigmaM * c.laneSigmaM;
    for (let i = 0; i < p.size; i++) {
      p.dks[i] = c.dksSigma * this.random.gauss();
      p.logw[i] = 0;
      if (i < offRoad) {
        p.offRoad[i] = 1;
        p.e[i] = e + posSigmaM * this.random.gauss();
        p.n[i] = n + posSigmaM * this.random.gauss();
        p.psi[i] = psi + psiSigma * this.random.gauss();
      } else {
        const cand = candidates[Math.floor(this.random.uniform() * candidates.length)];
        const len = edgeLength(cand.edge);
        p.offRoad[i] = 0;
        p.edge[i] = cand.edge.id;
        p.dir[i] = cand.dir;
        p.offset[i] = Math.min(len, Math.max(0, cand.along + radius * (2 * this.random.uniform() - 1)));
        this.placeOnRoad(i, cand.edge);
        const de = p.e[i] - e;
        const dn = p.n[i] - n;
        p.logw[i] = (-0.5 * (de * de + dn * dn)) / sigma2;
        const dh = wrap(p.psi[i] - psi);
        p.logw[i] += (-0.5 * dh * dh) / (psiSigma * psiSigma + c.roadSigmaRad * c.roadSigmaRad);
      }
      p.anchorTurn[i] = p.roadTurn[i];
    }
    this.normalize();
    this.updateWorkingSet();
    this.startTimes.push(now() - t0);
  }

  /**
   * Start with the heading unknown (§7.2, §8): particles evenly along every road within `radiusM`
   * of (e, n), in both directions (against a one-way at its soft factor); off-road ones anywhere in
   * the circle, heading anywhere. One particle per `initSpacingM` of road and direction, within
   * [N_track, N_max]. Returns false, and doesn't start, when the radius exceeds `unknownMaxRadiusM`.
   */
  initUnknown(e: number, n: number, radiusM: number, odometry: { distanceM: number; turnRad: number }): boolean {
    const c = this.config;
    if (!(radiusM <= c.unknownMaxRadiusM)) return false;
    const t0 = now();
    const radius = Math.max(c.initMinRadiusM, radiusM);
    const { spans, starts, total } = this.roadsIn(e, n, radius);
    const size = Math.min(c.maxParticles, Math.max(c.particles, Math.round((2 * total) / c.initSpacingM)));
    this.allocate(size);
    this.begin(odometry);
    this.resolved = false;
    this.region = { e, n, radiusM: radius, atM: odometry.distanceM };
    const p = this.p;
    const offRoad = total > 0 ? Math.ceil(c.offRoadShare * size) : size;
    // Systematic placement over the roads twice: along their geometry, then against it.
    const step = (2 * total) / Math.max(1, size - offRoad);
    let u = this.random.uniform() * step;
    const againstOneway = Math.log(c.againstOnewayFactor);
    for (let i = 0; i < size; i++) {
      p.dks[i] = c.dksSigma * this.random.gauss();
      p.logw[i] = 0;
      if (i < offRoad) {
        const r = radius * Math.sqrt(this.random.uniform());
        const a = TWO_PI * this.random.uniform();
        p.offRoad[i] = 1;
        p.e[i] = e + r * Math.sin(a);
        p.n[i] = n + r * Math.cos(a);
        p.psi[i] = wrap(TWO_PI * this.random.uniform());
      } else {
        if (this.placeAlong(i, spans, starts, total, u)) p.logw[i] = againstOneway;
        u += step;
      }
      p.anchorTurn[i] = p.roadTurn[i];
    }
    this.normalize();
    this.updateWorkingSet();
    this.startTimes.push(now() - t0);
    return true;
  }

  /**
   * Unknown heading: the navigator's anchor moved or grew (centre and radius in the local frame). The
   * radius grows by the distance driven from here on, up to `unknownMaxRadiusM`.
   */
  setSearchRegion(e: number, n: number, radiusM: number): void {
    if (this.resolved) return;
    this.region = { e, n, radiusM: Math.max(this.config.initMinRadiusM, radiusM), atM: this.distanceM };
  }

  /** Road spans within a circle, laid end to end (cached for the search region). */
  private roadsIn(e: number, n: number, radiusM: number): { spans: Span[]; starts: number[]; total: number } {
    const cached = this.regionSpans;
    if (cached && Math.hypot(cached.e - e, cached.n - n) < 1 && Math.abs(cached.radiusM - radiusM) < 10) return cached;
    const spans = spansInCircle(this.graph.edgesNear(e, n, radiusM), e, n, radiusM);
    const starts: number[] = [];
    let total = 0;
    for (const s of spans) {
      starts.push(total);
      total += s.b - s.a;
    }
    this.regionSpans = { e, n, radiusM, spans, starts, total };
    return this.regionSpans;
  }

  /**
   * Put particle `i` at `u` along the spans laid end to end twice (along their geometry, then against
   * it). Returns true when that is against a one-way.
   */
  private placeAlong(i: number, spans: Span[], starts: number[], total: number, u: number): boolean {
    const p = this.p;
    const dir: 1 | -1 = u < total ? 1 : -1;
    const x = dir === 1 ? u : u - total;
    let lo = 0;
    let hi = spans.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= x) lo = mid;
      else hi = mid - 1;
    }
    const span = spans[lo];
    p.offRoad[i] = 0;
    p.edge[i] = span.edge.id;
    p.dir[i] = dir;
    p.offset[i] = Math.min(span.b, span.a + x - starts[lo]);
    this.placeOnRoad(i, span.edge);
    return span.edge.oneway === (dir === 1 ? Oneway.backward : Oneway.forward);
  }

  /** Unknown heading, not tracking yet: re-seed `initReinjectShare` of the particles on the region's roads. */
  private reinjectInRegion(): void {
    const c = this.config;
    const region = this.region;
    if (!region || c.initReinjectShare <= 0) return;
    const radius = Math.min(c.unknownMaxRadiusM, region.radiusM + Math.max(0, this.distanceM - region.atM));
    const { spans, starts, total } = this.roadsIn(region.e, region.n, radius);
    if (!(total > 0)) return;
    const p = this.p;
    const count = Math.round(c.initReinjectShare * p.size);
    for (let k = 0; k < count; k++) {
      const i = Math.floor(this.random.uniform() * p.size);
      this.placeAlong(i, spans, starts, total, 2 * total * this.random.uniform());
      this.neutralHistory(i);
    }
  }

  /** Common start: odometry totals now, the weighting schedule, no fix weighed yet. */
  private begin(odometry: { distanceM: number; turnRad: number }): void {
    this.active = true;
    this.cached = null;
    this.distanceM = odometry.distanceM;
    this.turnRad = odometry.turnRad;
    this.nextEvalM = this.distanceM + this.config.evalIntervalM;
    this.nextWorkingSetM = this.distanceM;
    this.recentTurns = [];
    this.lastFixM = -Infinity;
    this.lastCoarseM = -Infinity;
    this.p.compassLog.fill(0);
    this.movedSinceEval = false;
    this.setAnchor();
  }

  /** Particle arrays of `size` (kept when the size doesn't change). */
  private allocate(size: number): void {
    if (this.p.size !== size) this.p = new Particles(size);
    if (this.spare.size !== size) this.spare = new Particles(size);
  }

  stop(): void {
    this.active = false;
    this.cached = null;
  }

  /** The local frame moved by (dE, dN): shift off-road particles, re-project on-road ones. */
  reframe(dE: number, dN: number): void {
    const p = this.p;
    for (let i = 0; i < p.size; i++) {
      if (p.offRoad[i]) {
        p.e[i] -= dE;
        p.n[i] -= dN;
      } else {
        this.placeOnRoad(i, this.graph.edge(p.edge[i]));
      }
    }
    this.cached = null;
  }

  /** The compass heading for the next weightings (null: none, or not trusted). Used only in state `init`. */
  setCompass(compass: { psi: number; sigma: number } | null): void {
    this.compass = compass;
  }

  /** One odometry chunk: propagate (frozen when stopped), then weight every `evalIntervalM`. */
  onOdometry(step: OdometryStep, heading: EkfPrior | null): void {
    this.turnVarSum += step.dpsiVar;
    if (step.yawUnknown) this.lastYawUnknownM = step.distanceM;
    const dt = (step.t1Us - step.t0Us) / 1e6;
    if (dt > 0) this.speedMps = step.dsM / dt;
    this.distanceM = step.distanceM;
    this.turnRad = step.turnRad;
    if (!this.active) return;
    if (step.stopped) {
      // Coming to a halt: the car isn't turning, so compare the turns since the anchor now. A turn into
      // a parking space or yard is otherwise never weighed (no straight driving after it).
      if (this.movedSinceEval) {
        const t0 = now();
        this.evaluate(heading, true);
        this.cached = null;
        this.record(now() - t0);
      }
      return;
    }
    this.movedSinceEval = true;
    const t0 = now();
    this.recentTurns.push({ d: step.distanceM, turn: step.turnRad });
    const keepM = Math.max(this.config.uTurnWindowM, this.config.straightWindowM);
    while (this.recentTurns.length > 2 && this.recentTurns[1].d < step.distanceM - keepM) this.recentTurns.shift();
    const uTurned = Math.abs(step.turnRad - this.turnSince(this.config.uTurnWindowM)) >= this.config.uTurnTurnRad;
    this.propagate(step, uTurned);
    if (step.distanceM >= this.nextEvalM) {
      this.nextEvalM = step.distanceM + this.config.evalIntervalM;
      this.evaluate(heading);
    }
    if (step.distanceM >= this.nextWorkingSetM) this.updateWorkingSet();
    this.cached = null;
    this.record(now() - t0);
  }

  /**
   * An accepted fix at (e, n) in the local frame (§7.4). Returns false when it is farther than
   * `lostSigmas` from every particle: the filter has lost the car and should be started again.
   */
  onFix(e: number, n: number, sigmaM: number, coarse: boolean, lagS = 0): boolean {
    if (!this.active) return true;
    const c = this.config;
    if (coarse) {
      if (this.distanceM - this.lastCoarseM < c.coarseSpacingM) return true;
      this.lastCoarseM = this.distanceM;
    } else {
      if (this.distanceM - this.lastFixM < c.fixSpacingM) return true;
      this.lastFixM = this.distanceM;
    }
    const t0 = now();
    const s = coarse ? sigmaM * c.coarseInflation : Math.hypot(sigmaM, c.laneSigmaM);
    const s2 = s * s;
    const p = this.p;
    // The fix shows where the car was `lagS` ago.
    const back = this.speedMps * lagS;
    let nearest = Infinity;
    for (let i = 0; i < p.size; i++) {
      const de = p.e[i] - back * Math.sin(p.psi[i]) - e;
      const dn = p.n[i] - back * Math.cos(p.psi[i]) - n;
      const d = Math.sqrt(de * de + dn * dn);
      if (d < nearest) nearest = d;
      // On a road the car drives in a lane, not on the centre line.
      const r = p.offRoad[i] ? d : Math.max(0, d - c.laneHalfWidthM);
      p.logw[i] += (-0.5 * r * r) / s2;
    }
    if (nearest > c.lostSigmas * s + c.laneHalfWidthM) {
      this.record(now() - t0);
      return false;
    }
    this.normalize();
    this.maybeResample();
    this.cached = null;
    this.record(now() - t0);
    return true;
  }

  output(): MapMatchOutput {
    if (!this.active) return { state: "off", clusters: [], particles: this.p.size, updateMs: this.lastUpdateMs };
    if (!this.cached) {
      const clusters = this.clusters();
      const p = this.p;
      let offRoadWeight = 0;
      for (let i = 0; i < p.size; i++) if (p.offRoad[i]) offRoadWeight += Math.exp(p.logw[i]);
      const top = clusters[0];
      let state: MapMatchState =
        offRoadWeight > 0.5
          ? "offroad"
          : top && top.weight >= this.config.trackingWeight && top.spreadM <= this.config.trackingSpreadM
            ? "tracking"
            : "multimodal";
      // An unknown-heading start stays `init` until it first tracks.
      if (state === "tracking") this.resolved = true;
      else if (!this.resolved) state = "init";
      this.cached = { state, clusters: clusters.slice(0, 5), particles: p.size, updateMs: this.lastUpdateMs };
    }
    return this.cached;
  }

  /**
   * The dominant travel direction: particles within `clusterHeadingRad` of the circular-mean heading
   * (iterated once), with their weight, weighted mean position and RMS distance, and their heading
   * mean and circular spread. On one road in one direction the position along it may still be open.
   */
  dominantHeading(): { weight: number; e: number; n: number; spreadM: number; headingRad: number; headingSpreadRad: number } {
    const p = this.p;
    const c = this.config;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < p.size; i++) {
      const w = Math.exp(p.logw[i]);
      sx += w * Math.sin(p.psi[i]);
      sy += w * Math.cos(p.psi[i]);
    }
    let mean = Math.atan2(sx, sy);
    let weight = 0;
    let e = 0;
    let n = 0;
    for (let pass = 0; pass < 2; pass++) {
      weight = e = n = sx = sy = 0;
      for (let i = 0; i < p.size; i++) {
        if (Math.abs(wrap(p.psi[i] - mean)) > c.clusterHeadingRad) continue;
        const w = Math.exp(p.logw[i]);
        weight += w;
        e += w * p.e[i];
        n += w * p.n[i];
        sx += w * Math.sin(p.psi[i]);
        sy += w * Math.cos(p.psi[i]);
      }
      if (weight <= 0) return { weight: 0, e: 0, n: 0, spreadM: Infinity, headingRad: mean, headingSpreadRad: Math.PI };
      mean = Math.atan2(sx, sy);
    }
    e /= weight;
    n /= weight;
    let spread = 0;
    for (let i = 0; i < p.size; i++) {
      if (Math.abs(wrap(p.psi[i] - mean)) > c.clusterHeadingRad) continue;
      spread += Math.exp(p.logw[i]) * ((p.e[i] - e) ** 2 + (p.n[i] - n) ** 2);
    }
    const resultant = Math.min(1, Math.hypot(sx, sy) / weight);
    return {
      weight,
      e,
      n,
      spreadM: Math.sqrt(spread / weight),
      headingRad: wrap(mean),
      headingSpreadRad: Math.sqrt(-2 * Math.log(Math.max(resultant, 1e-12))),
    };
  }

  /** The car drove straight over the last `straightWindowM` (turned less than `straightTurnRad`). */
  get isStraight(): boolean {
    const c = this.config;
    return Math.abs(this.turnRad - this.turnSince(c.straightWindowM)) < c.straightTurnRad;
  }

  /**
   * Share of the weight on roads that are straight around the particle (heading within `toleranceRad`
   * over ±`windowM` along its edge; the part of the window beyond the edge's ends is not checked).
   */
  straightRoadWeight(windowM: number, toleranceRad: number): number {
    const p = this.p;
    let share = 0;
    for (let i = 0; i < p.size; i++) {
      if (p.offRoad[i]) continue;
      const { cum, xy } = this.graph.edge(p.edge[i]);
      const from = p.offset[i] - windowM;
      const to = p.offset[i] + windowM;
      const heading = p.dir[i] === 1 ? p.psi[i] : p.psi[i] + Math.PI;
      let straight = true;
      for (let s = 0; s + 1 < cum.length && straight; s++) {
        if (cum[s + 1] <= cum[s] || cum[s + 1] < from || cum[s] > to) continue;
        const h = Math.atan2(xy[2 * s + 2] - xy[2 * s], xy[2 * s + 3] - xy[2 * s + 1]);
        straight = Math.abs(wrap(h - heading)) <= toleranceRad;
      }
      if (straight) share += Math.exp(p.logw[i]);
    }
    return share;
  }

  /**
   * The road's travel direction under the particles near (`e`, `n`) (within `radiusM`), for the EKF
   * (MAPMATCH-SPEC §9): only on-road particles whose road is straight (within `toleranceRad` over
   * ±`windowM`) and at least `nodeMarginM` from both ends of their edge, where the next road may turn.
   * `share`: their part of all the weight. Null when none qualifies.
   */
  roadHeading(
    e: number,
    n: number,
    radiusM: number,
    windowM: number,
    toleranceRad: number,
    nodeMarginM: number,
  ): { headingRad: number; spreadRad: number; share: number } | null {
    const p = this.p;
    let total = 0;
    let weight = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < p.size; i++) {
      const w = Math.exp(p.logw[i]);
      total += w;
      if (p.offRoad[i] || Math.hypot(p.e[i] - e, p.n[i] - n) > radiusM) continue;
      const { cum, xy } = this.graph.edge(p.edge[i]);
      const length = cum[cum.length - 1];
      if (p.offset[i] < nodeMarginM || p.offset[i] > length - nodeMarginM) continue;
      const geometryHeading = p.dir[i] === 1 ? p.psi[i] : p.psi[i] + Math.PI;
      let straight = true;
      for (let s = 0; s + 1 < cum.length && straight; s++) {
        if (cum[s + 1] <= cum[s] || cum[s + 1] < p.offset[i] - windowM || cum[s] > p.offset[i] + windowM) continue;
        const h = Math.atan2(xy[2 * s + 2] - xy[2 * s], xy[2 * s + 3] - xy[2 * s + 1]);
        straight = Math.abs(wrap(h - geometryHeading)) <= toleranceRad;
      }
      if (!straight) continue;
      weight += w;
      sx += w * Math.sin(p.psi[i]);
      sy += w * Math.cos(p.psi[i]);
    }
    if (weight <= 0 || total <= 0) return null;
    const resultant = Math.min(1, Math.hypot(sx, sy) / weight);
    return {
      headingRad: wrap(Math.atan2(sx, sy)),
      spreadRad: Math.sqrt(-2 * Math.log(Math.max(resultant, 1e-12))),
      share: weight / total,
    };
  }

  /** Weight held by off-road particles (cheap; `output()` clusters). */
  offRoadWeight(): number {
    const p = this.p;
    let w = 0;
    for (let i = 0; i < p.size; i++) if (p.offRoad[i]) w += Math.exp(p.logw[i]);
    return w;
  }

  /** True when some on-road particle satisfies `test` (replay: is any particle on the true road?). */
  someParticle(test: (edge: EdgeId, offsetM: number) => boolean): boolean {
    const p = this.p;
    for (let i = 0; i < p.size; i++) if (!p.offRoad[i] && test(p.edge[i], p.offset[i])) return true;
    return false;
  }

  /** Particle positions and weights, heaviest first (viewer). */
  /**
   * Share of the weight travelling within `toleranceRad` of a heading. `withoutCompass`: as if there were
   * no compass, each particle's compass factor divided back out (§8.2).
   */
  directionShare(headingRad: number, toleranceRad: number, withoutCompass = false): number {
    const p = this.p;
    let share = 0;
    let total = 0;
    for (let i = 0; i < p.size; i++) {
      const w = Math.exp(p.logw[i] - (withoutCompass ? p.compassLog[i] : 0));
      total += w;
      if (Math.abs(wrap(p.psi[i] - headingRad)) <= toleranceRad) share += w;
    }
    return total > 0 ? share / total : 0;
  }

  particles(max = Infinity): { e: number; n: number; w: number; offRoad: boolean }[] {
    const p = this.p;
    const out = [];
    for (let i = 0; i < p.size; i++) out.push({ e: p.e[i], n: p.n[i], w: Math.exp(p.logw[i]), offRoad: p.offRoad[i] === 1 });
    out.sort((a, b) => b.w - a.w);
    return out.slice(0, max);
  }

  // ---- propagation ----

  private propagate(step: OdometryStep, uTurned: boolean): void {
    const c = this.config;
    const p = this.p;
    for (let i = 0; i < p.size; i++) {
      const ds = Math.max(0, step.dsM * (1 + p.dks[i]) + c.alongNoise * step.dsM * this.random.gauss());
      if (p.offRoad[i]) {
        this.offRoadStep(i, ds, step.dpsiRad);
        continue;
      }
      if (uTurned && this.random.uniform() < c.uTurnShare * (step.dsM / c.uTurnWindowM)) {
        p.dir[i] = p.dir[i] === 1 ? -1 : 1;
      }
      this.advanceOnRoad(i, ds);
    }
  }

  private advanceOnRoad(i: number, ds: number): void {
    const p = this.p;
    let edge = this.graph.edge(p.edge[i]);
    let dir = p.dir[i] as 1 | -1;
    let len = edgeLength(edge);
    let offset = p.offset[i] + dir * ds;
    for (let hops = 0; (offset > len || offset < 0) && hops < 50; hops++) {
      const over = offset > len ? offset - len : -offset;
      const node = this.graph.node(dir === 1 ? edge.to : edge.from);
      if (node.flags & NodeFlag.boundary) {
        // The way continues beyond the extract: carry on off the graph.
        p.offRoad[i] = 1;
        p.offset[i] = dir === 1 ? len : 0;
        this.placeOnRoad(i, edge);
        p.e[i] += over * Math.sin(p.psi[i]);
        p.n[i] += over * Math.cos(p.psi[i]);
        return;
      }
      const exit = this.chooseExit(edge.id, dir);
      if (!exit) {
        dir = dir === 1 ? -1 : 1;
        offset = dir === 1 ? over : len - over;
        continue;
      }
      edge = this.graph.edge(exit.edge);
      dir = exit.dir;
      len = edgeLength(edge);
      offset = dir === 1 ? over : len - over;
    }
    p.edge[i] = edge.id;
    p.dir[i] = dir;
    p.offset[i] = Math.min(len, Math.max(0, offset));
    this.placeOnRoad(i, edge);
  }

  /** Set e, n, psi from the edge geometry at the particle's offset; accumulate the heading change. */
  private placeOnRoad(i: number, edge: RoadEdge): void {
    const p = this.p;
    const { cum, xy } = edge;
    const off = p.offset[i];
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= off) lo = mid;
      else hi = mid;
    }
    // Skip zero-length segments for the heading.
    let s = lo;
    while (s < cum.length - 2 && cum[s + 1] <= cum[s]) s++;
    const segLen = cum[s + 1] - cum[s];
    const f = segLen > 0 ? (off - cum[s]) / segLen : 0;
    const dx = xy[2 * s + 2] - xy[2 * s];
    const dy = xy[2 * s + 3] - xy[2 * s + 1];
    p.e[i] = xy[2 * s] + f * dx;
    p.n[i] = xy[2 * s + 1] + f * dy;
    const heading = (segLen > 0 ? Math.atan2(dx, dy) : p.psi[i]) + (p.dir[i] === 1 ? 0 : Math.PI);
    p.roadTurn[i] += wrap(heading - p.psi[i]);
    p.psi[i] = wrap(heading);
  }

  private offRoadStep(i: number, ds: number, dpsi: number): void {
    const c = this.config;
    const p = this.p;
    const turn = dpsi + c.offRoadHeadingNoise * Math.sqrt(ds) * this.random.gauss();
    const mid = p.psi[i] + turn / 2;
    p.e[i] += ds * Math.sin(mid);
    p.n[i] += ds * Math.cos(mid);
    p.psi[i] = wrap(p.psi[i] + turn);
    p.roadTurn[i] += turn;
    if (ds > 0 && this.random.uniform() < c.snapProbability) {
      const near = this.graph.edgesNear(p.e[i], p.n[i], c.snapRadiusM)[0];
      if (!near) return;
      for (const dir of [1, -1] as const) {
        const heading = dir === 1 ? near.headingRad : near.headingRad + Math.PI;
        if (Math.abs(wrap(heading - p.psi[i])) <= c.snapHeadingRad) {
          p.offRoad[i] = 0;
          p.edge[i] = near.edge.id;
          p.dir[i] = dir;
          p.offset[i] = near.alongM;
          this.placeOnRoad(i, near.edge);
          return;
        }
      }
    }
  }

  private chooseExit(edge: EdgeId, dir: 1 | -1): Exit | null {
    const key = `${edge}:${dir}`;
    let choice = this.exitCache.get(key);
    if (!choice) {
      const c = this.config;
      const exits = this.graph.exits(edge, dir);
      const deadEnd = exits.length === 1 && exits[0].uTurn;
      const cum: number[] = [];
      let total = 0;
      for (const x of exits) {
        const to = this.graph.edge(x.edge);
        let f = 1;
        if (x.againstOneway) f *= c.againstOnewayFactor;
        if (x.restricted) f *= c.restrictedFactor;
        if (x.uTurn && !deadEnd) f *= c.uTurnFactor;
        if (to.flags & EdgeFlag.private) f *= c.privateFactor;
        if (to.cls === RoadClass.service) f *= c.serviceFactor;
        total += f;
        cum.push(total);
      }
      choice = { exits, cum: cum.map((v) => v / total) };
      if (this.exitCache.size > 20_000) this.exitCache.clear();
      this.exitCache.set(key, choice);
    }
    if (!choice.exits.length) return null;
    const u = this.random.uniform();
    let k = 0;
    while (k < choice.cum.length - 1 && choice.cum[k] < u) k++;
    return choice.exits[k];
  }

  // ---- weighting and resampling ----

  /**
   * Every `evalIntervalM`: the off-road penalty; when the car drives straight, the relative heading
   * since the last straight moment (the anchor) and the weak absolute heading.
   */
  private evaluate(heading: EkfPrior | null, halted = false): void {
    const c = this.config;
    const p = this.p;
    this.movedSinceEval = false;
    const straight = halted || Math.abs(this.turnRad - this.turnSince(c.straightWindowM)) < c.straightTurnRad;
    const sinceAnchor = this.distanceM - this.anchorM;
    const compare = straight || sinceAnchor >= c.maxCompareM;
    const gyroValid = this.lastYawUnknownM < this.anchorM;
    const measured = this.turnRad - this.anchorTurnRad;
    const share = straight ? c.turnShare : c.curveShare;
    const relVar = Math.max(0, this.turnVarSum - this.anchorVar) + c.roadSigmaRad ** 2 + (share * Math.abs(measured)) ** 2;
    const absVar = heading ? (c.absHeadingInflation * heading.psiSigma) ** 2 + c.roadSigmaRad ** 2 : 0;
    const posVar = heading ? Math.max(c.ekfPositionInflation * heading.posSigma, c.ekfPositionFloorM) ** 2 : 0;
    const compass = !this.resolved && straight ? this.compass : null;
    for (let i = 0; i < p.size; i++) {
      if (p.offRoad[i]) {
        p.logw[i] += c.offRoadLogPenalty;
      } else if (compare && gyroValid) {
        const d = wrap(measured - (p.roadTurn[i] - p.anchorTurn[i]));
        p.logw[i] += (-0.5 * d * d) / relVar;
      }
      if (heading && straight) {
        const d = wrap(p.psi[i] - heading.psi);
        p.logw[i] += (c.absHeadingScale * -0.5 * d * d) / absVar;
      }
      if (compass) {
        const d = wrap(p.psi[i] - compass.psi);
        const f = Math.log(c.compassInlier * Math.exp((-0.5 * d * d) / (compass.sigma * compass.sigma)) + 1 - c.compassInlier);
        p.logw[i] += f - p.compassLog[i];
        p.compassLog[i] = f;
      }
      if (heading && c.ekfPositionScale > 0) {
        const de = p.e[i] - heading.e;
        const dn = p.n[i] - heading.n;
        p.logw[i] += (c.ekfPositionScale * -0.5 * (de * de + dn * dn)) / posVar;
      }
      if (compare) p.anchorTurn[i] = p.roadTurn[i];
    }
    if (compare) this.setAnchor();
    this.normalize();
    this.maybeResample();
  }

  private setAnchor(): void {
    this.anchorM = this.distanceM;
    this.anchorTurnRad = this.turnRad;
    this.anchorVar = this.turnVarSum;
  }

  /** The navigator's cumulative turn `distanceM` back (from the recent history). */
  private turnSince(distanceM: number): number {
    const target = this.distanceM - distanceM;
    const r = this.recentTurns;
    for (let k = r.length - 1; k >= 0; k--) if (r[k].d <= target) return r[k].turn;
    return r.length ? r[0].turn : this.turnRad;
  }

  /** Anchor for a new particle: as if its road had turned exactly as the car did since the anchor. */
  private neutralHistory(i: number): void {
    const p = this.p;
    p.anchorTurn[i] = p.roadTurn[i] - (this.turnRad - this.anchorTurnRad);
    p.compassLog[i] = 0;
  }

  /** Shift log-weights so they sum to 1 (as weights). */
  private normalize(): void {
    const w = this.p.logw;
    let max = -Infinity;
    for (let i = 0; i < w.length; i++) if (w[i] > max) max = w[i];
    if (!Number.isFinite(max)) {
      w.fill(-Math.log(w.length));
      return;
    }
    let sum = 0;
    for (let i = 0; i < w.length; i++) sum += Math.exp(w[i] - max);
    const shift = max + Math.log(sum);
    for (let i = 0; i < w.length; i++) w[i] -= shift;
  }

  /** When the weights degenerate (ESS < N/2), the off-road particles go stale, or a start just resolved. */
  private maybeResample(): void {
    const p = this.p;
    const w = p.logw;
    let sum2 = 0;
    let offRoad = 0;
    for (let i = 0; i < w.length; i++) {
      const wi = Math.exp(w[i]);
      sum2 += wi * wi;
      if (p.offRoad[i]) offRoad += wi;
    }
    // A start that has just resolved shrinks to N_track.
    const shrink = this.resolved && p.size !== this.config.particles;
    if (1 / sum2 >= w.length / 2 && offRoad >= this.config.offRoadMinWeight && !shrink) return;
    this.resample();
  }

  /**
   * Systematic resampling, then the off-road floor, re-injection near the clusters, and `dks` jitter.
   * An unknown-heading start keeps its particle count until it first tracks, then shrinks to N_track.
   */
  private resample(): void {
    const c = this.config;
    const from = this.p;
    const size = this.resolved ? c.particles : from.size;
    if (this.spare.size !== size) this.spare = new Particles(size);
    const to = this.spare;
    const step = 1 / size;
    let u = this.random.uniform() * step;
    let cum = Math.exp(from.logw[0]);
    let src = 0;
    for (let dst = 0; dst < size; dst++) {
      while (cum < u && src < from.size - 1) cum += Math.exp(from.logw[++src]);
      to.copy(from, src, dst);
      to.logw[dst] = -Math.log(size);
      u += step;
    }
    this.p = to;
    this.spare = from;
    const p = this.p;
    for (let i = 0; i < size; i++) p.dks[i] += c.dksJitter * this.random.gauss();

    let offRoad = 0;
    for (let i = 0; i < size; i++) offRoad += p.offRoad[i];
    const wantOffRoad = Math.ceil(c.offRoadShare * size);
    for (let k = 0; offRoad < wantOffRoad && k < 4 * size; k++) {
      const i = Math.floor(this.random.uniform() * size);
      if (!p.offRoad[i]) {
        p.offRoad[i] = 1;
        offRoad++;
      }
    }
    this.keepOnRoad(size - offRoad);
    this.reinject();
    if (!this.resolved) this.reinjectInRegion();
    this.cached = null;
  }

  /** Project off-road particles onto the nearest aligned edge until `onRoadShare` of them are on a road. */
  private keepOnRoad(onRoad: number): void {
    const c = this.config;
    const p = this.p;
    const want = Math.ceil(c.onRoadShare * p.size);
    for (let k = 0; onRoad < want && k < 2 * want; k++) {
      const i = Math.floor(this.random.uniform() * p.size);
      if (!p.offRoad[i]) continue;
      for (const near of this.graph.edgesNear(p.e[i], p.n[i], c.onRoadProjectM).slice(0, 4)) {
        const dir: 1 | -1 = Math.abs(wrap(near.headingRad - p.psi[i])) <= Math.PI / 2 ? 1 : -1;
        const heading = dir === 1 ? near.headingRad : near.headingRad + Math.PI;
        if (Math.abs(wrap(heading - p.psi[i])) > c.onRoadProjectHeadingRad) continue;
        p.offRoad[i] = 0;
        p.edge[i] = near.edge.id;
        p.dir[i] = dir;
        p.offset[i] = near.alongM;
        this.placeOnRoad(i, near.edge);
        this.neutralHistory(i);
        onRoad++;
        break;
      }
    }
  }

  /** A few particles onto edges near the clusters, both directions: a pruned hypothesis can come back. */
  private reinject(): void {
    const c = this.config;
    const p = this.p;
    const count = Math.round(c.reinjectShare * p.size);
    if (!count) return;
    const clusters = this.clusters();
    if (!clusters.length) return;
    const nearby = clusters.slice(0, 3).map((cl) => ({ cl, near: this.graph.edgesNear(cl.e, cl.n, c.clusterRadiusM) }));
    for (let k = 0; k < count; k++) {
      const { near } = nearby[Math.floor(this.random.uniform() * nearby.length)];
      if (!near.length) continue;
      const cand = near[Math.floor(this.random.uniform() * near.length)];
      const i = Math.floor(this.random.uniform() * p.size);
      const len = edgeLength(cand.edge);
      p.offRoad[i] = 0;
      p.edge[i] = cand.edge.id;
      p.dir[i] = this.random.uniform() < 0.5 ? 1 : -1;
      p.offset[i] = Math.min(len, Math.max(0, cand.alongM + c.clusterRadiusM * 0.5 * (2 * this.random.uniform() - 1)));
      this.placeOnRoad(i, cand.edge);
      this.neutralHistory(i);
    }
  }

  // ---- output ----

  /** Greedy clusters in weight order (§7.6). */
  private clusters(): MapMatchCluster[] {
    const c = this.config;
    const p = this.p;
    const order = Array.from({ length: p.size }, (_, i) => i).sort((a, b) => p.logw[b] - p.logw[a]);
    let left = order;
    const out: MapMatchCluster[] = [];
    const r2 = c.clusterRadiusM * c.clusterRadiusM;
    let assigned = 0;
    // Spread-out starts have hundreds of tiny clusters; past the cap they hold almost no weight.
    while (left.length && out.length < c.maxClusters && assigned < 1 - 1e-4) {
      const seed = left[0];
      const members: number[] = [];
      const rest: number[] = [];
      for (const j of left) {
        const de = p.e[j] - p.e[seed];
        const dn = p.n[j] - p.n[seed];
        if (de * de + dn * dn <= r2 && Math.abs(wrap(p.psi[j] - p.psi[seed])) <= c.clusterHeadingRad) members.push(j);
        else rest.push(j);
      }
      left = rest;
      let w = 0;
      let e = 0;
      let n = 0;
      let sx = 0;
      let sy = 0;
      const edgeWeight = new Map<EdgeId, number>();
      for (const j of members) {
        const wj = Math.exp(p.logw[j]);
        w += wj;
        e += wj * p.e[j];
        n += wj * p.n[j];
        sx += wj * Math.sin(p.psi[j]);
        sy += wj * Math.cos(p.psi[j]);
        if (!p.offRoad[j]) edgeWeight.set(p.edge[j], (edgeWeight.get(p.edge[j]) ?? 0) + wj);
      }
      if (w <= 0) {
        // The remaining particles carry no weight at all.
        break;
      }
      assigned += w;
      e /= w;
      n /= w;
      let cee = 0;
      let cen = 0;
      let cnn = 0;
      for (const j of members) {
        const wj = Math.exp(p.logw[j]);
        const de = p.e[j] - e;
        const dn = p.n[j] - n;
        cee += wj * de * de;
        cen += wj * de * dn;
        cnn += wj * dn * dn;
      }
      const spread = cee + cnn;
      let edge: EdgeId | null = null;
      let best = 0;
      for (const [id, we] of edgeWeight) if (we > best) [edge, best] = [id, we];
      const resultant = Math.min(1, Math.hypot(sx, sy) / w);
      out.push({
        weight: w,
        e,
        n,
        headingRad: wrap(Math.atan2(sx, sy)),
        headingSpreadRad: Math.sqrt(-2 * Math.log(Math.max(resultant, 1e-12))),
        spreadM: Math.sqrt(spread / w),
        covariance: [cee / w, cen / w, cnn / w],
        edge,
        particles: members.length,
      });
    }
    return out.sort((a, b) => b.weight - a.weight);
  }

  private updateWorkingSet(): void {
    const c = this.config;
    this.nextWorkingSetM = this.distanceM + c.workingSetEveryM;
    const tiles = new Set<number>();
    for (const cl of this.clusters().slice(0, 5)) {
      for (const t of this.graph.tilesAround(cl.e, cl.n, 3 * cl.spreadM + c.workingSetMarginM)) tiles.add(t);
    }
    this.graph.pin(tiles);
  }

  private record(ms: number): void {
    this.lastUpdateMs = ms;
    this.updateTimes.push(ms);
  }
}
