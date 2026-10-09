// Map matching for a speed known only roughly (the phone alone, no OBD): the car is tracked as a set of road
// hypotheses, each a position along a road with its own uncertainty and speed scale. Between turns a hypothesis
// drives on along its road (straight on at junctions); a turn the gyro sees must have been taken at a junction whose
// exit turns the same way, within the hypothesis' uncertainty: the hypothesis branches into each such junction and its
// position snaps to it, which also teaches its speed scale. Off the mapped roads (yards, car parks, lanes the map
// lacks) a free hypothesis dead-reckons and rejoins roads that run its way. Road headings and coarse fixes weigh them.

import type { EdgeId, Exit, RoadEdge, RoadGraph } from "./graph/road-graph";

export interface TurnTrackerConfig {
  maxHypotheses: number;
  /** Hypotheses more than this below the best (log weight) are dropped. */
  pruneLog: number;
  /** Two hypotheses on the same road and direction this close merge. */
  mergeM: number;
  /** Start: roads within this of the start position (plus 2σ), heading within this of the start heading (plus 2σ). */
  initRadiusM: number;
  initHeadingRad: number;
  /** A turn no hypothesis can explain (a yard, a car park, a road the map lacks): start again on the roads this far
   *  around the best guess (plus 2σ), heading the way the car now does. */
  reseedRadiusM: number;
  /** Speed scale (true distance / phone distance): prior mean and σ, random walk per √s, its σ at least this from
   *  each stop (the phone's error in a new stretch is its own), and its bounds. */
  scaleInit: number;
  scaleSigma: number;
  scaleWalk: number;
  scaleStopSigma: number;
  scaleMin: number;
  scaleMax: number;
  /** Along-road position noise, m² per m driven. */
  alongNoise: number;
  /** Speed unknown (the phone doesn't know its axes yet, or no reading): the last one if recent, else this while the
   *  road shakes the phone (else 0), its σ growing the position doubt linearly. */
  unknownSpeedMps: number;
  unknownSigmaMps: number;
  unknownHoldS: number;
  /** Heading check against the road: σ, and how often (m driven); the term counts once per `headingCorrM`. */
  headingSigmaRad: number;
  headingEveryM: number;
  headingCorrM: number;
  /** A heading change this large from the last steady heading starts a turn; it ends steady (rate below, held). */
  turnStartRad: number;
  turnSteadyRateRad: number;
  turnSteadyS: number;
  /** A turn still open after this long or this far (a long curve, a roundabout) is closed as it stands. */
  turnMaxS: number;
  turnMaxM: number;
  /** A turn at least this large must be a junction (or a bend the road itself makes). */
  turnMinRad: number;
  /** Where no exit goes straight, the road may still go on round a bend this sharp at the node; the heading checks
   *  judge it (log weight added: `bendLog`), next to waiting at the node for the turn. */
  bendMaxRad: number;
  bendLog: number;
  /** Junction exit angle vs the measured turn: σ. */
  turnSigmaRad: number;
  /** Position σ right after a junction snap, m. */
  snapSigmaM: number;
  /** How far to search for junctions: the expected distance ± this many σ, plus `searchSlackM`. */
  searchSigmas: number;
  searchSlackM: number;
  /** Driving on into a road that only turns: log weight lost per σ² overrun. */
  overrunWeight: number;
  /** All hypotheses waiting at their nodes longer than this many σ (and `overrunMinM`): the car drove on where the map
   *  has no road; start again around where it must be. */
  overrunDeadSigmas: number;
  overrunMinM: number;
  /** Driving against a one-way road: log weight once. */
  againstOnewayLog: number;
  /** Coarse fixes: σ = max(accuracy × inflation, floor), outlier share, spacing, and the largest accuracy used. */
  fixInflation: number;
  fixFloorM: number;
  fixOutlier: number;
  fixSpacingS: number;
  fixMaxAccM: number;
  /** Gyro bias learned while stopped: time constant. */
  biasTauS: number;
  /**
   * How much a hypothesis' gyro-to-world heading offset follows its own road: per heading check on straight road, and
   * at a junction snap. Needed: a phone handled on its mount loses the gyro's heading (keeping the offset fixed from
   * the start cost 9 → 19 % off the route with OBD speed).
   */
  thetaFollow: number;
  thetaSnapFollow: number;
  /**
   * Off the mapped roads: a hypothesis that dead-reckons freely. Its log weight at a seed, its cost per m, and every
   * `rejoinEveryM` it seeds road hypotheses on roads within `rejoinRadiusM` (plus 2σ) running its way (within
   * `rejoinHeadingRad`), at `rejoinLog` below its own weight.
   */
  freeSeedLog: number;
  freeLogPerM: number;
  rejoinEveryM: number;
  rejoinRadiusM: number;
  rejoinHeadingRad: number;
  rejoinLog: number;
  /**
   * Road jolts (speed bumps, rail crossings, manholes) at places learned from earlier drives: a jolt weighs each
   * hypothesis by its distance to the nearest known place (σ `bumpSigmaM` plus its own doubt; `bumpOutlier` of jolts
   * are at no known place) and pulls its position along the road towards that place.
   */
  bumpSigmaM: number;
  bumpOutlier: number;
  /** Also pull the along-road position towards the place. */
  bumpSnap: boolean;
  /**
   * With roads known to be driven (`roadUsed`, from earlier drives): a road no earlier drive used costs this much
   * when a hypothesis turns onto it, and per m driven on it.
   */
  unusedExitLog: number;
  unusedLogPerM: number;
}

const DEG = Math.PI / 180;

export const DEFAULT_TURN_TRACKER_CONFIG: TurnTrackerConfig = {
  maxHypotheses: 400,
  pruneLog: 14,
  mergeM: 8,
  initRadiusM: 60,
  reseedRadiusM: 60,
  initHeadingRad: 40 * DEG,
  scaleInit: 1.1,
  scaleSigma: 0.25,
  scaleWalk: 0.01,
  scaleStopSigma: 0.1,
  scaleMin: 0.6,
  scaleMax: 2,
  alongNoise: 0.5,
  unknownSpeedMps: 5,
  unknownSigmaMps: 3,
  unknownHoldS: 3,
  headingSigmaRad: 18 * DEG,
  headingEveryM: 5,
  headingCorrM: 20,
  turnStartRad: 12 * DEG,
  turnSteadyRateRad: 4 * DEG,
  turnSteadyS: 1,
  turnMaxS: 15,
  turnMaxM: 150,
  turnMinRad: 35 * DEG,
  bendMaxRad: 75 * DEG,
  bendLog: Math.log(0.3),
  turnSigmaRad: 20 * DEG,
  snapSigmaM: 15,
  searchSigmas: 3,
  searchSlackM: 25,
  overrunWeight: 0.5,
  overrunDeadSigmas: 3,
  overrunMinM: 40,
  againstOnewayLog: Math.log(0.05),
  fixInflation: 1.5,
  fixFloorM: 30,
  fixOutlier: 0.2,
  fixSpacingS: 5,
  fixMaxAccM: 400,
  biasTauS: 5,
  thetaFollow: 0.05,
  thetaSnapFollow: 0.5,
  freeSeedLog: Math.log(0.1),
  freeLogPerM: Math.log(0.5) / 100,
  rejoinEveryM: 20,
  rejoinRadiusM: 20,
  rejoinHeadingRad: 25 * DEG,
  rejoinLog: Math.log(0.5),
  bumpSigmaM: 12,
  bumpOutlier: 0.4,
  bumpSnap: true,
  unusedExitLog: Math.log(0.3),
  unusedLogPerM: Math.log(0.7) / 100,
};

/** Whether earlier drives used a road (edge). */
export type RoadUsed = (edge: EdgeId) => boolean;

/** One step of the phone's odometry. */
export interface TrackerStep {
  tUs: number;
  dtS: number;
  /** Phone speed, m/s (NaN: unknown). */
  speedMps: number;
  /** Rotation about the vertical, rad/s, counter-clockwise positive (the IMU's convention). */
  yawRate: number;
  /** The gyro is the car's (not handled). */
  valid: boolean;
  stopped: boolean;
  /** The road shakes the phone like a moving car (else, with the speed unknown, the car is taken to stand). */
  moving?: boolean;
}

interface Hyp {
  edge: EdgeId;
  dir: 1 | -1;
  /** Offset along the edge's geometry, m. */
  offset: number;
  /** Along-position variance, scale variance and covariance. */
  pss: number;
  pkk: number;
  psk: number;
  k: number;
  /** Absolute heading = gyro heading + theta. */
  theta: number;
  logW: number;
  /** Where the log weight came from (relative; normalisation not counted), for diagnosis. */
  ledger: Record<string, number>;
  /** Distance driven by this hypothesis (scaled), for the heading checks. */
  drivenM: number;
  nextHeadingM: number;
  /** Driven past a node whose exits all turn, m. */
  overrunM: number;
  /** Off the mapped roads: dead-reckoned position (edge, dir and offset unused). */
  free: boolean;
  fe: number;
  fn: number;
}

export interface TrackerEstimate {
  e: number;
  n: number;
  headingRad: number;
  /** Along-position σ of the best hypothesis, m. */
  sigmaM: number;
  hypotheses: number;
  /** Weight share of the best hypothesis. */
  share: number;
}

export interface TrackerHypothesis {
  e: number;
  n: number;
  heading: number;
  logW: number;
  free: boolean;
  sigma: number;
  k: number;
  overrun: number;
  ledger: Record<string, number>;
}

const wrap = (a: number) => {
  let x = (a + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
};

/** Point and heading (in geometry direction) at `offset` along an edge. */
function pointAt(edge: RoadEdge, offset: number): { e: number; n: number; heading: number } {
  const { xy, cum } = edge;
  const last = cum.length - 1;
  const s = Math.max(0, Math.min(cum[last], offset));
  let i = 0;
  while (i < last - 1 && cum[i + 1] < s) i++;
  const seg = cum[i + 1] - cum[i];
  const f = seg > 0 ? (s - cum[i]) / seg : 0;
  const e = xy[2 * i] + f * (xy[2 * i + 2] - xy[2 * i]);
  const n = xy[2 * i + 1] + f * (xy[2 * i + 3] - xy[2 * i + 1]);
  // Heading of the nearest non-degenerate segment.
  let j = i;
  while (j < last - 1 && cum[j + 1] - cum[j] <= 0) j++;
  const heading = Math.atan2(xy[2 * j + 2] - xy[2 * j], xy[2 * j + 3] - xy[2 * j + 1]);
  return { e, n, heading };
}

const edgeLen = (edge: RoadEdge) => edge.cum[edge.cum.length - 1];

/** Add to a hypothesis' log weight, booked under `key`. */
function credit(h: { logW: number; ledger: Record<string, number> }, key: string, v: number): void {
  h.logW += v;
  h.ledger[key] = (h.ledger[key] ?? 0) + v;
}

export class TurnTracker {
  readonly config: TurnTrackerConfig;
  private hyps: Hyp[] = [];
  /** Gyro heading, clockwise, rad (relative to the start). */
  private psi = 0;
  private bias = 0;
  /** Phone distance (unscaled), m. */
  private phoneM = 0;
  private lastSpeed = 0;
  private unknownForS = 0;
  private wasStopped = false;
  // Turn detection.
  private steadyPsi = 0;
  private steadyForS = 0;
  /** Yaw rate smoothed (the 0.1 s steps are noisy on rough roads), for the steadiness tests. */
  private rateLp = 0;
  private turn: { startPsi: number; startPhoneM: number; startUs: number; midPhoneM: number | null; snapshot: Hyp[] } | null = null;
  private lastFixUs = -Infinity;
  readonly stats = { turns: 0, snaps: 0, emptied: 0 };

  constructor(
    private readonly graph: RoadGraph,
    config: Partial<TurnTrackerConfig> = {},
    private readonly roadUsed: RoadUsed | null = null,
  ) {
    this.config = { ...DEFAULT_TURN_TRACKER_CONFIG, ...config };
  }

  /** Start at a pose (graph frame, heading clockwise from north). */
  start(e: number, n: number, headingRad: number, posSigmaM: number, headingSigmaRad: number): void {
    this.psi = 0;
    this.steadyPsi = 0;
    this.seed(e, n, headingRad, posSigmaM, headingSigmaRad, this.config.initRadiusM, this.config.scaleInit, this.config.scaleSigma ** 2);
  }

  /** The driver put the car here (keeps the gyro heading and the learned scale). */
  restart(e: number, n: number, headingRad: number, posSigmaM: number, headingSigmaRad: number): void {
    const best = this.bestHyp();
    this.seed(e, n, headingRad, posSigmaM, headingSigmaRad, this.config.initRadiusM / 2, best?.k ?? this.config.scaleInit, this.config.scaleSigma ** 2);
  }

  get size(): number {
    return this.hyps.length;
  }

  step(s: TrackerStep): void {
    const c = this.config;
    const dt = s.dtS;
    if (s.stopped) {
      const a = Math.min(1, dt / c.biasTauS);
      this.bias += (s.yawRate - this.bias) * a;
      if (!this.wasStopped) for (const h of this.hyps) h.pkk = Math.max(h.pkk, c.scaleStopSigma ** 2);
    }
    this.wasStopped = s.stopped;
    // Heading clockwise: the yaw rate is counter-clockwise positive.
    const rate = s.valid && !s.stopped ? -(s.yawRate - this.bias) : 0;
    this.psi += rate * dt;
    const known = Number.isFinite(s.speedMps);
    this.unknownForS = known || s.stopped ? 0 : this.unknownForS + dt;
    const guess = this.unknownForS > c.unknownHoldS && s.moving !== false;
    const v = s.stopped ? 0 : known ? Math.max(0, s.speedMps) : guess ? c.unknownSpeedMps : s.moving === false ? 0 : this.lastSpeed;
    if (known) this.lastSpeed = v;
    if (guess)
      for (const h of this.hyps) {
        const sd = Math.sqrt(h.pss) + c.unknownSigmaMps * dt;
        h.pss = sd * sd;
      }
    const ds = v * dt;
    this.phoneM += ds;

    this.detectTurn(s, rate);
    for (const h of this.hyps) this.propagate(h, ds, dt, known);
    if (!this.turn) for (const h of this.hyps) this.checkHeading(h);
    this.prune();
    this.reseedIfStuck();
  }

  /**
   * A jolt now; `places` are where jolts were felt on earlier drives (graph frame). Hypotheses near one gain, and move
   * along their road towards it (a Kalman update of the along-road position).
   */
  bump(places: readonly { e: number; n: number }[]): void {
    const c = this.config;
    if (!places.length || !this.hyps.length) return;
    for (const h of this.hyps) {
      const p = this.position(h);
      let best: { e: number; n: number } | null = null;
      let bd = Infinity;
      for (const q of places) {
        const d = Math.hypot(q.e - p.e, q.n - p.n);
        if (d < bd) {
          bd = d;
          best = q;
        }
      }
      const s2 = c.bumpSigmaM ** 2 + Math.min(h.pss, 100 ** 2);
      credit(h, "bump", Math.log(c.bumpOutlier + (1 - c.bumpOutlier) * Math.exp(-0.5 * (bd * bd) / s2)));
      if (!c.bumpSnap || h.free || !best || bd > 3 * Math.sqrt(s2)) continue;
      // Along the road: the place's offset from here in the direction of travel.
      const along = (best.e - p.e) * Math.sin(p.heading) + (best.n - p.n) * Math.cos(p.heading);
      const across = Math.abs(-(best.e - p.e) * Math.cos(p.heading) + (best.n - p.n) * Math.sin(p.heading));
      if (across > 2 * c.bumpSigmaM) continue;
      const sv = h.pss + c.bumpSigmaM ** 2;
      const ks = h.pss / sv;
      const kk = h.psk / sv;
      const len = edgeLen(this.graph.edge(h.edge));
      const fwd = h.dir === 1 ? len - h.offset : h.offset;
      const back = h.dir === 1 ? h.offset : len - h.offset;
      const move = Math.max(-back, Math.min(fwd, ks * along));
      h.offset += h.dir * move;
      h.k = Math.max(c.scaleMin, Math.min(c.scaleMax, h.k + kk * along));
      const pss = h.pss;
      const psk = h.psk;
      h.pkk -= kk * psk;
      h.psk = psk - ks * psk;
      h.pss = pss - ks * pss;
    }
    this.normalise();
  }

  /** A coarse fix (Wi-Fi/cell) in the graph frame. */
  fix(tUs: number, e: number, n: number, accM: number): void {
    const c = this.config;
    if (accM > c.fixMaxAccM || tUs - this.lastFixUs < c.fixSpacingS * 1e6 || !this.hyps.length) return;
    this.lastFixUs = tUs;
    const sigma = Math.max(c.fixFloorM, accM * c.fixInflation);
    for (const h of this.hyps) {
      const p = this.position(h);
      const d2 = ((p.e - e) ** 2 + (p.n - n) ** 2) / sigma ** 2;
      credit(h, "fix", Math.log((1 - c.fixOutlier) * Math.exp(-0.5 * d2) + c.fixOutlier * Math.exp(-0.5 * 9)));
    }
    this.normalise();
  }

  estimate(): TrackerEstimate | null {
    const best = this.bestHyp();
    if (!best) return null;
    let total = 0;
    for (const h of this.hyps) total += Math.exp(h.logW);
    const p = this.position(best);
    return { e: p.e, n: p.n, headingRad: p.heading, sigmaM: Math.sqrt(best.pss), hypotheses: this.hyps.length, share: Math.exp(best.logW) / total };
  }

  /** Every hypothesis: position, weight and its ledger (diagnosis). */
  hypotheses(): TrackerHypothesis[] {
    return this.hyps.map((h) => ({ ...this.position(h), logW: h.logW, free: h.free, sigma: Math.sqrt(h.pss), k: h.k, overrun: h.overrunM, ledger: h.ledger }));
  }

  // ---- internals ----

  /** Hypotheses on the roads around (e, n) heading `headingRad` (absolute), and a free one there. */
  private seed(e: number, n: number, headingRad: number, posSigmaM: number, headingSigmaRad: number, radiusM: number, k: number, pkk: number): void {
    const c = this.config;
    this.hyps = [];
    const radius = radiusM + 2 * posSigmaM;
    const tol = c.initHeadingRad + 2 * headingSigmaRad;
    const base = { pkk, psk: 0, k, drivenM: 0, overrunM: 0 };
    for (const near of this.graph.edgesNear(e, n, radius)) {
      for (const dir of [1, -1] as const) {
        const heading = dir === 1 ? near.headingRad : near.headingRad + Math.PI;
        const dh = wrap(heading - headingRad);
        if (Math.abs(dh) > tol) continue;
        const s2 = posSigmaM ** 2 + 10 ** 2;
        const logW = -0.5 * (near.distanceM ** 2 / s2) - 0.5 * (dh / Math.max(headingSigmaRad, 10 * DEG)) ** 2;
        this.hyps.push({
          ...base,
          edge: near.edge.id,
          dir,
          offset: near.alongM,
          pss: s2,
          theta: heading - this.psi,
          logW,
          ledger: { seed: logW },
          nextHeadingM: c.headingEveryM,
          free: false,
          fe: 0,
          fn: 0,
        });
      }
    }
    this.hyps.push({
      ...base,
      edge: -1,
      dir: 1,
      offset: 0,
      pss: posSigmaM ** 2 + 10 ** 2,
      theta: headingRad - this.psi,
      logW: c.freeSeedLog,
      ledger: { seed: c.freeSeedLog },
      nextHeadingM: c.rejoinEveryM,
      free: true,
      fe: e,
      fn: n,
    });
    this.normalise();
  }

  /** Every hypothesis stuck at a node the car drove past: seed again ahead of the best one, along the gyro heading. */
  private reseedIfStuck(): void {
    const c = this.config;
    if (!this.hyps.length || this.turn) return;
    for (const h of this.hyps) if (h.free || h.overrunM < Math.max(c.overrunMinM, c.overrunDeadSigmas * Math.sqrt(h.pss))) return;
    const best = this.bestHyp()!;
    const p = this.position(best);
    const heading = this.psi + best.theta;
    this.stats.emptied++;
    this.seed(
      p.e + best.overrunM * Math.sin(heading),
      p.n + best.overrunM * Math.cos(heading),
      heading,
      Math.sqrt(best.pss),
      0,
      c.reseedRadiusM,
      best.k,
      Math.max(best.pkk, (c.scaleSigma / 2) ** 2),
    );
  }

  private bestHyp(): Hyp | null {
    let best: Hyp | null = null;
    for (const h of this.hyps) if (!best || h.logW > best.logW) best = h;
    return best;
  }

  private position(h: Hyp): { e: number; n: number; heading: number } {
    if (h.free) return { e: h.fe, n: h.fn, heading: wrap(this.psi + h.theta) };
    const p = pointAt(this.graph.edge(h.edge), h.offset);
    return { e: p.e, n: p.n, heading: h.dir === 1 ? p.heading : wrap(p.heading + Math.PI) };
  }

  private propagate(h: Hyp, ds: number, dt: number, known: boolean): void {
    const c = this.config;
    // Along position: s += k · ds; P = F P Fᵀ + Q, F = [[1, ds], [0, 1]].
    h.pss += 2 * ds * h.psk + ds * ds * h.pkk + c.alongNoise * ds * (known ? 1 : 10);
    h.psk += ds * h.pkk;
    h.pkk += c.scaleWalk ** 2 * dt;
    const step = h.k * ds;
    h.drivenM += step;
    if (h.free) {
      const heading = this.psi + h.theta;
      h.fe += step * Math.sin(heading);
      h.fn += step * Math.cos(heading);
      credit(h, "free", c.freeLogPerM * step);
      return;
    }
    if (this.roadUsed && step > 0 && !this.roadUsed(h.edge)) credit(h, "unused", c.unusedLogPerM * step);
    if (h.overrunM > 0) {
      // Waiting at a node whose exits all turn: the car can't be past it.
      const before = h.overrunM;
      h.overrunM += step;
      credit(h, "overrun", -(c.overrunWeight * (h.overrunM ** 2 - before ** 2)) / h.pss);
      return;
    }
    this.advance(h, step);
  }

  /** Move along the road, straight on at nodes (forking where several exits go straight). */
  private advance(h: Hyp, step: number): void {
    const c = this.config;
    let left = step;
    for (let hops = 0; hops < 20 && left > 0; hops++) {
      const edge = this.graph.edge(h.edge);
      const len = edgeLen(edge);
      const toEnd = h.dir === 1 ? len - h.offset : h.offset;
      if (left <= toEnd) {
        h.offset += h.dir * left;
        return;
      }
      left -= toEnd;
      h.offset = h.dir === 1 ? len : 0;
      const all = this.exits(h.edge, h.dir);
      const straight = all.filter((x) => Math.abs(x.turnRad) < c.turnMinRad);
      if (!straight.length) {
        // The car may wait here for its turn, or the road bends on: one hypothesis per bending exit.
        for (const x of all.filter((y) => Math.abs(y.turnRad) < c.bendMaxRad)) {
          const bend: Hyp = { ...h, ledger: { ...h.ledger }, edge: x.edge, dir: x.dir };
          credit(bend, "nodeBend", c.bendLog + (x.againstOneway ? c.againstOnewayLog : 0));
          bend.offset = x.dir === 1 ? 0 : edgeLen(this.graph.edge(x.edge));
          this.advance(bend, left);
          this.hyps.push(bend);
        }
        h.overrunM = left;
        return;
      }
      // Forks: the others become hypotheses of their own.
      for (const x of straight.slice(1)) {
        const fork: Hyp = { ...h, ledger: { ...h.ledger }, edge: x.edge, dir: x.dir };
        credit(fork, "fork", Math.log(1 / straight.length) + (x.againstOneway ? c.againstOnewayLog : 0));
        fork.offset = x.dir === 1 ? 0 : edgeLen(this.graph.edge(x.edge));
        this.advance(fork, left);
        this.hyps.push(fork);
      }
      const x = straight[0];
      credit(h, "fork", Math.log(1 / straight.length) + (x.againstOneway ? c.againstOnewayLog : 0));
      h.edge = x.edge;
      h.dir = x.dir;
      h.offset = x.dir === 1 ? 0 : edgeLen(this.graph.edge(x.edge));
    }
  }

  private exits(edge: EdgeId, dir: 1 | -1): Exit[] {
    return this.graph.exits(edge, dir).filter((x) => !x.uTurn && !x.restricted);
  }

  /** Road heading vs the gyro's, every few metres between turns; a free hypothesis looks for roads to rejoin. */
  private checkHeading(h: Hyp): void {
    const c = this.config;
    if (h.drivenM < h.nextHeadingM || h.overrunM > 0) return;
    if (h.free) {
      h.nextHeadingM = h.drivenM + c.rejoinEveryM;
      this.rejoin(h);
      return;
    }
    h.nextHeadingM = h.drivenM + c.headingEveryM;
    const p = this.position(h);
    const err = wrap(p.heading - (this.psi + h.theta));
    // Near a bend the road's heading depends on where along it the car is: widen by the position's doubt.
    const ahead = this.position({ ...h, offset: Math.max(0, Math.min(edgeLen(this.graph.edge(h.edge)), h.offset + h.dir * 15)) });
    const bend = Math.abs(wrap(ahead.heading - p.heading)) / 15;
    const sigma2 = c.headingSigmaRad ** 2 + bend * bend * h.pss;
    credit(h, "heading", -(0.5 * (err * err) / sigma2) * (c.headingEveryM / c.headingCorrM));
    // Slow gyro drift: follow the road on straight stretches.
    if (bend < 0.2 * DEG) h.theta += c.thetaFollow * err;
  }

  /** Road hypotheses on the roads near a free one that run its way. */
  private rejoin(h: Hyp): void {
    const c = this.config;
    const heading = this.psi + h.theta;
    const sigma = Math.sqrt(h.pss);
    for (const near of this.graph.edgesNear(h.fe, h.fn, c.rejoinRadiusM + 2 * sigma)) {
      for (const dir of [1, -1] as const) {
        const road = dir === 1 ? near.headingRad : near.headingRad + Math.PI;
        const dh = wrap(road - heading);
        if (Math.abs(dh) > c.rejoinHeadingRad) continue;
        const joined: Hyp = {
          ...h,
          ledger: { ...h.ledger },
          free: false,
          edge: near.edge.id,
          dir,
          offset: near.alongM,
          pss: Math.min(h.pss, c.rejoinRadiusM ** 2) + 5 ** 2,
          psk: 0,
          nextHeadingM: h.drivenM + c.headingEveryM,
          overrunM: 0,
        };
        credit(joined, "rejoin", c.rejoinLog - 0.5 * (near.distanceM ** 2 / (h.pss + 25)) - 0.5 * (dh / c.headingSigmaRad) ** 2);
        this.hyps.push(joined);
      }
    }
  }

  private detectTurn(s: TrackerStep, rawRate: number): void {
    const c = this.config;
    this.rateLp += (rawRate - this.rateLp) * Math.min(1, s.dtS / 0.7);
    const rate = this.rateLp;
    if (!this.turn) {
      if (Math.abs(rate) < c.turnSteadyRateRad) this.steadyPsi += (this.psi - this.steadyPsi) * Math.min(1, s.dtS / 0.5);
      if (Math.abs(wrap(this.psi - this.steadyPsi)) >= c.turnStartRad) {
        this.turn = { startPsi: this.steadyPsi, startPhoneM: this.phoneM, startUs: s.tUs, midPhoneM: null, snapshot: this.hyps.map((h) => ({ ...h, ledger: { ...h.ledger } })) };
        this.steadyForS = 0;
      }
      return;
    }
    const t = this.turn;
    const turned = wrap(this.psi - t.startPsi);
    this.steadyForS = Math.abs(rate) < c.turnSteadyRateRad ? this.steadyForS + s.dtS : 0;
    if (t.midPhoneM === null && Math.abs(turned) >= c.turnMinRad / 2) t.midPhoneM = this.phoneM;
    const timedOut = (s.tUs - t.startUs) / 1e6 > c.turnMaxS || this.phoneM - t.startPhoneM > c.turnMaxM;
    if (this.steadyForS < c.turnSteadyS && !timedOut) return;
    this.turn = null;
    this.steadyPsi = this.psi;
    if (Math.abs(turned) < c.turnMinRad) return;
    this.stats.turns++;
    this.snap(t, turned);
  }

  /**
   * A turn of `turned` ended: each hypothesis as it was when the turn began searches the junctions around where it
   * expected the turn's middle, and branches into the exits that turn that way. Hypotheses whose own road bent the
   * same way without a junction stay as they are.
   */
  private snap(t: NonNullable<TurnTracker["turn"]>, turned: number): void {
    const c = this.config;
    const mid = (t.midPhoneM ?? t.startPhoneM) - t.startPhoneM;
    const sinceMid = this.phoneM - (t.midPhoneM ?? t.startPhoneM);
    const out: Hyp[] = [];
    // Bends: the propagated hypotheses whose road now heads where the car does.
    for (const h of this.hyps) {
      if (h.free) {
        out.push(h);
        continue;
      }
      if (h.overrunM > 0) continue;
      const p = this.position(h);
      const err = wrap(p.heading - (this.psi + h.theta));
      if (Math.abs(err) < 2 * c.turnSigmaRad) {
        const kept = { ...h, ledger: { ...h.ledger } };
        credit(kept, "roadBend", -0.5 * (err / c.turnSigmaRad) ** 2);
        out.push(kept);
      }
    }
    for (const h of t.snapshot) {
      if (h.free) continue;
      const expected = h.k * mid;
      // The junction's distance measures (δs, k): H = [1, mid].
      const sv = h.pss + mid * mid * h.pkk + 2 * mid * h.psk;
      const sigma = Math.sqrt(sv);
      const reach = expected + c.searchSigmas * sigma + c.searchSlackM;
      const behind = c.searchSigmas * sigma + c.searchSlackM;
      for (const j of this.junctions(h, -behind, reach)) {
        for (const x of this.exits(j.edge, j.dir)) {
          const dTurn = wrap(x.turnRad - turned);
          if (Math.abs(dTurn) > 2.5 * c.turnSigmaRad) continue;
          // A hypothesis waiting at a node believed the car `overrunM` past it.
          const resid = j.atM - h.overrunM - expected;
          const hk = h.psk + mid * h.pkk;
          const gk = hk / sv;
          const k = Math.max(c.scaleMin, Math.min(c.scaleMax, h.k + gk * resid));
          const branch: Hyp = {
            edge: x.edge,
            dir: x.dir,
            offset: x.dir === 1 ? 0 : edgeLen(this.graph.edge(x.edge)),
            pss: c.snapSigmaM ** 2,
            pkk: Math.max(1e-4, h.pkk - gk * hk),
            psk: 0,
            k,
            theta: h.theta,
            logW: h.logW,
            ledger: { ...h.ledger },
            drivenM: h.drivenM,
            nextHeadingM: h.drivenM + c.headingEveryM,
            overrunM: 0,
            free: false,
            fe: 0,
            fn: 0,
          };
          credit(branch, "snapDist", -0.5 * (resid * resid) / sv);
          credit(branch, "snapVague", -0.5 * Math.log(sv / c.snapSigmaM ** 2));
          credit(branch, "snapTurn", -0.5 * (dTurn / c.turnSigmaRad) ** 2 + (x.againstOneway ? c.againstOnewayLog : 0));
          if (this.roadUsed && !this.roadUsed(x.edge)) credit(branch, "unused", c.unusedExitLog);
          this.advance(branch, k * sinceMid);
          // The exit road's heading re-anchors the gyro's, partly (junction geometry is rough).
          const ph = this.position(branch);
          branch.theta += c.thetaSnapFollow * wrap(ph.heading - (this.psi + branch.theta));
          out.push(branch);
          this.stats.snaps++;
        }
      }
    }
    if (out.length) this.hyps = out;
    else {
      this.stats.emptied++;
      const best = this.bestHyp();
      if (best) {
        const p = this.position(best);
        this.seed(p.e, p.n, this.psi + best.theta, Math.sqrt(best.pss), 0, c.reseedRadiusM, best.k, Math.max(best.pkk, (c.scaleSigma / 2) ** 2));
      }
    }
    this.normalise();
    this.prune();
  }

  /**
   * Nodes reachable from a hypothesis from `fromM` (negative: behind it, back along its own road) to `toM` ahead,
   * driving straight on: each with the edge and direction that arrive at it and the distance to it.
   */
  private junctions(h: Hyp, fromM: number, toM: number): { edge: EdgeId; dir: 1 | -1; atM: number }[] {
    const c = this.config;
    const out: { edge: EdgeId; dir: 1 | -1; atM: number }[] = [];
    // Behind: the node this edge starts at (in the direction of travel), arrived at along the road that runs
    // straight on into this one; the car may have turned there already if the hypothesis is ahead of it.
    const edge = this.graph.edge(h.edge);
    const back = h.dir === 1 ? h.offset : edgeLen(edge) - h.offset;
    if (-back >= fromM) {
      const node = this.graph.node(h.dir === 1 ? edge.from : edge.to);
      for (const { edge: id, end } of node.edges) {
        if (id === h.edge) continue;
        const dir = (end === 1 ? 1 : -1) as 1 | -1;
        const into = this.graph.exits(id, dir).find((x) => x.edge === h.edge && x.dir === h.dir);
        if (into && Math.abs(into.turnRad) < c.turnMinRad) {
          out.push({ edge: id, dir, atM: -back });
          break;
        }
      }
    }
    // Ahead: walk straight on (at a fork, the first straight exit).
    let cur = { edge: h.edge, dir: h.dir, at: h.dir === 1 ? edgeLen(edge) - h.offset : h.offset };
    for (let hops = 0; hops < 30 && cur.at <= toM; hops++) {
      if (cur.at >= fromM) out.push({ edge: cur.edge, dir: cur.dir, atM: cur.at });
      const straight = this.exits(cur.edge, cur.dir).filter((x) => Math.abs(x.turnRad) < c.turnMinRad);
      if (!straight.length) break;
      const x = straight[0];
      cur = { edge: x.edge, dir: x.dir, at: cur.at + edgeLen(this.graph.edge(x.edge)) };
    }
    return out;
  }

  private normalise(): void {
    if (!this.hyps.length) return;
    let max = -Infinity;
    for (const h of this.hyps) max = Math.max(max, h.logW);
    let sum = 0;
    for (const h of this.hyps) sum += Math.exp(h.logW - max);
    const norm = max + Math.log(sum);
    for (const h of this.hyps) h.logW -= norm;
  }

  private prune(): void {
    const c = this.config;
    if (!this.hyps.length) return;
    this.normalise();
    let max = -Infinity;
    for (const h of this.hyps) max = Math.max(max, h.logW);
    const kept = this.hyps.filter((h) => h.logW >= max - c.pruneLog);
    // Merge duplicates: same road and direction, close along it.
    kept.sort((a, b) => b.logW - a.logW);
    const merged: Hyp[] = [];
    for (const h of kept) {
      const twin = merged.find((m) =>
        m.free || h.free
          ? m.free && h.free && Math.hypot(m.fe - h.fe, m.fn - h.fn) < 2 * c.mergeM
          : m.edge === h.edge && m.dir === h.dir && Math.abs(m.offset - h.offset) < c.mergeM && (m.overrunM > 0) === (h.overrunM > 0),
      );
      if (twin) {
        const a = Math.max(twin.logW, h.logW);
        twin.logW = a + Math.log(Math.exp(twin.logW - a) + Math.exp(h.logW - a));
      } else merged.push(h);
    }
    this.hyps = merged.slice(0, c.maxHypotheses);
    this.normalise();
  }
}
