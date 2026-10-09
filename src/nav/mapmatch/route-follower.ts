// Phone-only position on a planned route (experiment, SPEC §3.10): the car is taken to drive the route, so its
// position is one number, the distance along it. A grid over (distance, speed scale) moved by the phone's speed and
// weighed by how the gyro's heading matches the route's there: every turn of the route the car makes pins where it
// is, whatever the phone's speed did since the last one. Pure TS, local ENU metres.

import type { TrackerStep } from "./turn-tracker";

export interface RouteFollowerConfig {
  /** Grid cell along the route, m. */
  cellM: number;
  /** Speed scales the phone's speed may be off by (the car's distance / the phone's). */
  scales: readonly number[];
  /** Prior on the scale: mean and σ (log-normal-ish, on the scale itself). */
  scaleMean: number;
  scaleSigma: number;
  /** Along-route process noise: this share of the distance moved, plus a floor per second, m. */
  moveShare: number;
  moveFloorMps: number;
  /** Chance per second that the scale changes (it jumps to another one, weighted by the prior). */
  scaleJumpPerS: number;
  /** The grid moves and the turn is matched once per this many seconds of driving. */
  matchEveryS: number;
  /** A speed guess while the phone's is unknown and the road shakes the phone, m/s; held this long first, s. */
  unknownSpeedMps: number;
  unknownHoldS: number;
  /**
   * Wi-Fi / cell fixes: σ = max(floor, accuracy × inflation), outlier share, up to `fixMaxAccM`. Kept much coarser than
   * the tracker's (400 m): on a route a cell fix ±3 km still says which of the far-apart places the speed allows the
   * car is at (a dot that lags or runs ahead kilometres on a highway).
   */
  fixFloorM: number;
  fixInflation: number;
  fixOutlier: number;
  fixMaxAccM: number;
  fixSpacingS: number;
  /** Gyro bias learned while standing, time constant s. */
  biasTauS: number;
  /**
   * The position may be off by more than the speed says (a drawing that cuts a corner, a turn the gyro missed): this
   * share per second of moving leaks into a blur of the distribution `leakM` wide, so a wrong mode can be left.
   */
  leakPerS: number;
  leakM: number;
  /**
   * The turn match: the gyro's heading change over the last `turnWindowM` of the phone's distance against the route's
   * over the same distance (times each scale) behind each cell. Free of the gyro's heading offset, which a phone
   * handled in the yard loses.
   */
  turnWindowM: number;
  turnSigmaRad: number;
  turnFloor: number;
  /**
   * A turn: the gyro's heading change over the window reaches this. Each is reported once the window has passed it,
   * with how well the route had a turn like it where the car could be (`RouteTurn.fit`).
   */
  turnSeenRad: number;
  /**
   * The driver follows the route, so a turn is one of its turns. One that fits nowhere near where the car was taken to
   * be (its `fit` below `relocateFit`) is the nearest of the route's turns like it (likelihood ≥ `relocateMinLike`)
   * from `relocateBackM` behind to `relocateAheadMinM`, or `relocateAheadShare` × the phone's distance since the last
   * turn that fitted, ahead (the phone under-reads at speed: a dot can lag kilometres behind on a highway). Nearer
   * turns are likelier (`relocateNearShare` of that reach), and the scale the jump implies is taken. `relocateKeep`
   * of the old belief stays.
   */
  relocateFit: number;
  relocateMinLike: number;
  relocateBackM: number;
  relocateAheadMinM: number;
  relocateAheadShare: number;
  relocateNearShare: number;
  relocateKeep: number;
  /** σ of the scale around the one a jump implies. */
  relocateScaleSigma: number;
  /**
   * A fix that puts the car well outside where it was taken to be (its expected likelihood below `fixRelocateFit`,
   * and farther than `fixRelocateMinM` from the shown place) moves it to the nearest stretch of the route that fits
   * the fix, within the same reach as for a turn behind and ahead.
   */
  fixRelocateFit: number;
  fixRelocateMinM: number;
}

export const DEFAULT_ROUTE_FOLLOWER_CONFIG: RouteFollowerConfig = {
  cellM: 5,
  scales: [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.45, 1.6, 1.8, 2.1, 2.5, 3],
  scaleMean: 1.15,
  scaleSigma: 0.25,
  moveShare: 0.1,
  moveFloorMps: 0.3,
  scaleJumpPerS: 0.002,
  matchEveryS: 1,
  unknownSpeedMps: 5,
  unknownHoldS: 2,
  fixFloorM: 30,
  fixInflation: 1.5,
  fixOutlier: 0.2,
  fixMaxAccM: 5000,
  fixSpacingS: 5,
  biasTauS: 10,
  leakPerS: 0.02,
  leakM: 150,
  turnWindowM: 80,
  turnSigmaRad: (25 * Math.PI) / 180,
  turnFloor: 0.2,
  turnSeenRad: (40 * Math.PI) / 180,
  relocateFit: 0.5,
  relocateMinLike: 0.8,
  relocateBackM: 300,
  relocateAheadMinM: 1000,
  relocateAheadShare: 2,
  relocateNearShare: 0.5,
  relocateKeep: 0.1,
  relocateScaleSigma: 0.3,
  fixRelocateFit: 0.05,
  fixRelocateMinM: 500,
};

export interface RouteFollowerEstimate {
  /** Along the route, m (the most likely cell). */
  alongM: number;
  e: number;
  n: number;
  /** The route's heading there (clockwise from north). */
  headingRad: number;
  /** Probability within ±30 m of `alongM`. */
  share: number;
  /** Spread of the position along the route, m (σ of the distribution). */
  sigmaM: number;
  /** The most likely speed scale. */
  scale: number;
}

/** A turn the gyro saw, once the turn window has passed it. */
export interface RouteTurn {
  tUs: number;
  /** The largest heading change over the window, rad (clockwise positive). */
  turnedRad: number;
  /**
   * The best match of the route to it while the window passed over it: the expected likelihood of the turn where the
   * car could be, from `turnFloor` (nothing like it on the route nearby) to 1.
   */
  fit: number;
  /** Where the follower had the car before the turn, ENU m and m along the route. */
  before: { e: number; n: number; alongM: number };
  /** It fitted nowhere near: the car was put at the nearest of the route's turns like it, this far along (m). */
  jumpedM?: number;
}

/** A coarse fix that put the car somewhere else along the route. */
export interface RouteFixJump {
  tUs: number;
  accM: number;
  fromM: number;
  toM: number;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class RouteFollower {
  private readonly config: RouteFollowerConfig;
  private readonly cum: number[];
  private readonly cells: number;
  /** Route heading per cell (clockwise from north) and its point. */
  private readonly heading: Float64Array;
  private readonly cellE: Float64Array;
  private readonly cellN: Float64Array;
  /** P[scale][cell]. */
  private p: Float64Array[];
  private readonly scalePrior: Float64Array;
  private psi = 0;
  private bias = 0;
  private sinceMatchS = 0;
  private unknownForS = 0;
  private lastSpeed = 0;
  private lastFixUs = -Infinity;
  private nowUs = 0;
  /** The turn the window is over now (null: none): its largest heading change, and the phone's distance then. */
  private turn: { maxTurned: number; peakPhoneM: number; fit: number; before: RouteTurn["before"] } | null = null;
  /** The last turn that fitted (or the start): m along the route and the phone's distance then. */
  private anchor = { alongM: 0, phoneM: 0 };
  /** Turns reported since the last `takeTurns`. */
  private turns: RouteTurn[] = [];
  /** Jumps made on fixes since the last `takeFixJumps`. */
  private fixJumps: RouteFixJump[] = [];
  private pendingM = 0;
  private pendingNoiseM = 0;
  private pendingS = 0;
  /** The phone's distance driven and the gyro heading then (invalid: the phone was handled), for the turn match. */
  private phoneM = 0;
  private history: { d: number; psi: number; valid: boolean }[] = [];

  /** `route`: the planned route's points, ENU m; the car starts at `startAlongM` (σ `startSigmaM`) heading along it. */
  constructor(
    private readonly route: readonly [number, number][],
    config: Partial<RouteFollowerConfig> = {},
    startAlongM = 0,
    startSigmaM = 15,
  ) {
    this.config = { ...DEFAULT_ROUTE_FOLLOWER_CONFIG, ...config };
    const c = this.config;
    this.cum = [0];
    for (let i = 1; i < route.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]));
    this.cells = Math.max(1, Math.ceil(this.cum.at(-1)! / c.cellM) + 1);
    this.heading = new Float64Array(this.cells);
    this.cellE = new Float64Array(this.cells);
    this.cellN = new Float64Array(this.cells);
    let seg = 0;
    for (let i = 0; i < this.cells; i++) {
      const s = Math.min(this.cum.at(-1)!, i * c.cellM);
      while (seg + 2 < route.length && this.cum[seg + 1] <= s) seg++;
      const [ae, an] = route[seg];
      const [be, bn] = route[Math.min(route.length - 1, seg + 1)];
      const len = Math.max(1e-6, this.cum[Math.min(route.length - 1, seg + 1)] - this.cum[seg]);
      const f = Math.max(0, Math.min(1, (s - this.cum[seg]) / len));
      this.cellE[i] = ae + (be - ae) * f;
      this.cellN[i] = an + (bn - an) * f;
      this.heading[i] = Math.atan2(be - ae, bn - an);
    }
    this.scalePrior = new Float64Array(c.scales.map((k) => Math.exp(-0.5 * ((k - c.scaleMean) / c.scaleSigma) ** 2)));
    const norm = this.scalePrior.reduce((a, b) => a + b, 0);
    for (let j = 0; j < this.scalePrior.length; j++) this.scalePrior[j] /= norm;
    this.p = c.scales.map((_, j) => {
      const row = new Float64Array(this.cells);
      for (let i = 0; i < this.cells; i++) row[i] = this.scalePrior[j] * Math.exp(-0.5 * ((i * c.cellM - startAlongM) / startSigmaM) ** 2);
      return row;
    });
    this.normalise();
    this.anchor = { alongM: startAlongM, phoneM: 0 };
  }

  get lengthM(): number {
    return this.cum.at(-1)!;
  }

  step(s: TrackerStep): void {
    const c = this.config;
    const dt = s.dtS;
    this.nowUs = s.tUs;
    if (s.stopped) this.bias += (s.yawRate - this.bias) * Math.min(1, dt / c.biasTauS);
    // Heading clockwise: the yaw rate is counter-clockwise positive.
    const rate = s.valid && !s.stopped ? -(s.yawRate - this.bias) : 0;
    this.psi += rate * dt;
    const known = Number.isFinite(s.speedMps);
    this.unknownForS = known || s.stopped ? 0 : this.unknownForS + dt;
    const guess = this.unknownForS > c.unknownHoldS && s.moving !== false;
    const v = s.stopped ? 0 : known ? Math.max(0, s.speedMps) : guess ? c.unknownSpeedMps : s.moving === false ? 0 : this.lastSpeed;
    if (known) this.lastSpeed = v;
    // Moved once a second (the grid is large): the distance by the phone, its noise and the time.
    if (v > 0) {
      const mul = known ? 1 : 3;
      this.pendingM += v * dt;
      this.pendingNoiseM += mul * (c.moveShare * v * dt + c.moveFloorMps * dt);
      this.pendingS += dt;
      this.phoneM += v * dt;
      this.history.push({ d: this.phoneM, psi: this.psi, valid: s.valid });
      while (this.history.length > 2 && this.history[1].d < this.phoneM - 2 * c.turnWindowM) this.history.shift();
      this.sinceMatchS += dt;
      if (this.sinceMatchS >= c.matchEveryS) {
        this.flush();
        this.matchTurn();
        this.sinceMatchS = 0;
      }
    }
  }

  /** The turns reported since the last call. */
  takeTurns(): RouteTurn[] {
    const out = this.turns;
    this.turns = [];
    return out;
  }

  private flush(): void {
    if (this.pendingM <= 0) return;
    this.move(this.pendingM, this.pendingNoiseM);
    if (this.config.scaleJumpPerS > 0) this.jumpScale(this.config.scaleJumpPerS * this.pendingS);
    if (this.config.leakPerS > 0) this.leak(Math.min(1, this.config.leakPerS * this.pendingS));
    this.pendingM = this.pendingNoiseM = this.pendingS = 0;
  }

  /** A coarse fix (Wi-Fi / cell) weighs the cells by their distance from it. */
  fix(tUs: number, e: number, n: number, accM: number): void {
    const c = this.config;
    if (accM > c.fixMaxAccM || tUs - this.lastFixUs < c.fixSpacingS * 1e6) return;
    this.lastFixUs = tUs;
    this.flush();
    const sigma = Math.max(c.fixFloorM, accM * c.fixInflation);
    const near = new Float64Array(this.cells);
    let fit = 0;
    for (let i = 0; i < this.cells; i++) near[i] = Math.exp(-0.5 * ((this.cellE[i] - e) ** 2 + (this.cellN[i] - n) ** 2) / sigma ** 2);
    for (const row of this.p) for (let i = 0; i < this.cells; i++) fit += row[i] * near[i];
    const { cell: now } = this.argmax();
    const offM = Math.hypot(this.cellE[now] - e, this.cellN[now] - n);
    if (fit < c.fixRelocateFit && offM > Math.max(c.fixRelocateMinM, 2 * sigma)) {
      const toM = this.relocateBy(Number.POSITIVE_INFINITY, (i) => near[i], 0.5);
      if (toM !== null) {
        this.fixJumps.push({ tUs, accM, fromM: now * c.cellM, toM });
        return;
      }
    }
    for (const row of this.p) for (let i = 0; i < this.cells; i++) row[i] *= (1 - c.fixOutlier) * near[i] + c.fixOutlier * Math.exp(-4.5);
    this.normalise();
  }

  /** The jumps made on fixes since the last call. */
  takeFixJumps(): RouteFixJump[] {
    const out = this.fixJumps;
    this.fixJumps = [];
    return out;
  }

  estimate(): RouteFollowerEstimate {
    const c = this.config;
    this.flush();
    const { cell, scale } = this.argmax();
    let mean = 0;
    let m2 = 0;
    for (const row of this.p) {
      for (let i = 0; i < this.cells; i++) {
        mean += row[i] * i;
        m2 += row[i] * i * i;
      }
    }
    return {
      alongM: cell * c.cellM,
      e: this.cellE[cell],
      n: this.cellN[cell],
      headingRad: this.heading[cell],
      share: this.estimateShare(cell),
      sigmaM: Math.sqrt(Math.max(0, m2 - mean * mean)) * c.cellM,
      scale: c.scales[scale],
    };
  }

  /**
   * The same follower on another route (a re-plan joined onto this one), the car `atM` along it: there with this one's
   * spread and scale, and the gyro's heading, the turn under way, the speed and the anchor carry on, so a turn made just
   * before the new route came isn't lost. The whole belief isn't carried: re-plans every few seconds piled up its
   * lagging tail (jyxdtb, 8 % → 25 % off the drawing).
   */
  carryOn(route: readonly [number, number][], atM: number): RouteFollower {
    this.flush();
    const c = this.config;
    const was = this.estimate();
    const next = new RouteFollower(route, { ...c, scaleMean: was.scale }, atM, Math.max(15, was.sigmaM));
    const fromM = was.alongM - atM;
    next.psi = this.psi;
    next.bias = this.bias;
    next.sinceMatchS = this.sinceMatchS;
    next.unknownForS = this.unknownForS;
    next.lastSpeed = this.lastSpeed;
    next.lastFixUs = this.lastFixUs;
    next.nowUs = this.nowUs;
    next.phoneM = this.phoneM;
    next.history = [...this.history];
    next.turns = [...this.turns];
    next.fixJumps = [...this.fixJumps];
    next.turn = this.turn ? { ...this.turn, before: { ...this.turn.before, alongM: this.turn.before.alongM - fromM } } : null;
    next.anchor = { alongM: this.anchor.alongM - fromM, phoneM: this.anchor.phoneM };
    return next;
  }

  /** P over the route (summed over scales), for drawing. */
  alongDistribution(): Float64Array {
    const out = new Float64Array(this.cells);
    for (const row of this.p) for (let i = 0; i < this.cells; i++) out[i] += row[i];
    return out;
  }

  private move(distanceM: number, noiseM: number): void {
    const c = this.config;
    this.p = this.p.map((row, j) => {
      const mean = (c.scales[j] * distanceM) / c.cellM;
      const sigma = Math.max(0.3, noiseM / c.cellM);
      // A shift by `mean` cells, spread by a small Gaussian kernel.
      const half = Math.ceil(3 * sigma);
      const kernel: number[] = [];
      const base = Math.floor(mean);
      let sum = 0;
      for (let d = base - half; d <= base + half + 1; d++) {
        const w = Math.exp(-0.5 * ((d - mean) / sigma) ** 2);
        kernel.push(w);
        sum += w;
      }
      const out = new Float64Array(this.cells);
      for (let i = 0; i < this.cells; i++) {
        const x = row[i];
        if (x < 1e-12) continue;
        for (let k = 0; k < kernel.length; k++) {
          const to = Math.min(this.cells - 1, i + base - half + k);
          if (to >= 0) out[to] += (x * kernel[k]) / sum;
        }
      }
      return out;
    });
  }

  private leak(share: number): void {
    // Three box passes ≈ a Gaussian of σ `leakM`.
    const w = Math.max(1, Math.round((this.config.leakM * Math.sqrt(12 / 3)) / this.config.cellM / 2));
    for (const row of this.p) {
      let b: Float64Array = Float64Array.from(row);
      for (let pass = 0; pass < 3; pass++) {
        const out = new Float64Array(this.cells);
        let acc = 0;
        for (let i = -w; i < this.cells + w; i++) {
          if (i + w < this.cells) acc += b[i + w];
          if (i - w - 1 >= 0) acc -= b[i - w - 1];
          if (i >= 0 && i < this.cells) out[i] = acc / (2 * w + 1);
        }
        b = out;
      }
      for (let i = 0; i < this.cells; i++) row[i] = (1 - share) * row[i] + share * b[i];
    }
  }

  private jumpScale(chance: number): void {
    const rows = this.p.length;
    const total = new Float64Array(this.cells);
    for (const row of this.p) for (let i = 0; i < this.cells; i++) total[i] += row[i];
    for (let j = 0; j < rows; j++) {
      const row = this.p[j];
      for (let i = 0; i < this.cells; i++) row[i] = (1 - chance) * row[i] + chance * this.scalePrior[j] * total[i];
    }
  }

  private matchTurn(): void {
    const c = this.config;
    const from = this.phoneM - c.turnWindowM;
    const k0 = this.history.findIndex((x) => x.d >= from);
    if (k0 <= 0 || this.history.slice(k0 - 1).some((x) => !x.valid)) {
      this.turn = null;
      return;
    }
    const a = this.history[k0 - 1];
    const b = this.history[k0];
    const f = b.d > a.d ? (from - a.d) / (b.d - a.d) : 0;
    const turned = this.psi - (a.psi + (b.psi - a.psi) * f);
    if (Math.abs(turned) >= c.turnSeenRad && !this.turn) {
      const { cell } = this.argmax();
      this.turn = { maxTurned: turned, peakPhoneM: this.phoneM, fit: 0, before: { e: this.cellE[cell], n: this.cellN[cell], alongM: cell * c.cellM } };
    }
    let fit = 0;
    this.p.forEach((row, j) => {
      const shift = Math.round((c.scales[j] * c.turnWindowM) / c.cellM);
      for (let i = 0; i < this.cells; i++) {
        if (row[i] < 1e-12) continue;
        const err = wrap(turned - (this.heading[i] - this.heading[Math.max(0, i - shift)]));
        const like = c.turnFloor + (1 - c.turnFloor) * Math.exp(-0.5 * (err / c.turnSigmaRad) ** 2);
        fit += row[i] * like;
        row[i] *= like;
      }
    });
    this.normalise();
    const t = this.turn;
    if (t) {
      if (Math.abs(turned) > Math.abs(t.maxTurned)) {
        t.maxTurned = turned;
        t.peakPhoneM = this.phoneM;
      }
      // While the turn is in the window: the update after it has passed matches straight road to straight road.
      if (Math.abs(turned) >= c.turnSeenRad) t.fit = Math.max(t.fit, fit);
      if (Math.abs(turned) < c.turnSeenRad) {
        const jumpedM = t.fit < c.relocateFit ? this.relocate(t.maxTurned, this.phoneM - t.peakPhoneM) : null;
        this.turns.push({ tUs: this.nowUs, turnedRad: t.maxTurned, fit: t.fit, before: t.before, ...(jumpedM !== null ? { jumpedM } : {}) });
        if (t.fit >= c.relocateFit || jumpedM !== null) {
          const { cell } = this.argmax();
          this.anchor = { alongM: cell * c.cellM, phoneM: this.phoneM };
        }
        this.turn = null;
      }
    }
  }

  /**
   * A turn of `turned` (its peak `sincePeakM` of the phone's distance ago) that fitted nowhere near: the car is at the
   * nearest of the route's turns like it, within reach (see `relocateFit`). Returns where it was put (m along), or
   * null when the route has no such turn within reach.
   */
  private relocate(turned: number, sincePeakM: number): number | null {
    const c = this.config;
    return this.relocateBy(c.relocateBackM, (i, kj) => {
      // Where this scale had the turn's peak, and the route's turn over the window ending there.
      const peak = Math.round(i - (kj * sincePeakM) / c.cellM);
      const shift = Math.round((kj * c.turnWindowM) / c.cellM);
      if (peak - shift < 0 || peak >= this.cells) return 0;
      const err = wrap(turned - (this.heading[peak] - this.heading[peak - shift]));
      return Math.exp(-0.5 * (err / c.turnSigmaRad) ** 2);
    }, c.relocateMinLike);
  }

  /**
   * The car is where `like(cell, scale)` says, the nearest such place to where it was taken to be likeliest: from
   * `backM` behind (capped at the reach ahead) to the reach ahead, with the scale the jump implies. Null (nothing
   * changed) when nowhere within reach is `like` at least `minLike`.
   */
  private relocateBy(backM: number, like: (cell: number, scale: number) => number, minLike: number): number | null {
    const c = this.config;
    const { cell: now } = this.argmax();
    const phoneSince = Math.max(1, this.phoneM - this.anchor.phoneM);
    const aheadM = Math.max(c.relocateAheadMinM, c.relocateAheadShare * phoneSince);
    const nearM = c.relocateNearShare * aheadM;
    const lo = Math.max(0, now - Math.round(Math.min(backM, aheadM) / c.cellM));
    const hi = Math.min(this.cells - 1, now + Math.round(aheadM / c.cellM));
    const fresh = c.scales.map(() => new Float64Array(this.cells));
    let best = 0;
    let total = 0;
    for (let i = lo; i <= hi; i++) {
      // The scale a jump to here implies: the route from the last anchor over the phone's distance since.
      const k = (i * c.cellM - this.anchor.alongM) / phoneSince;
      const near = Math.exp(-Math.abs(i - now) * (c.cellM / nearM));
      c.scales.forEach((kj, j) => {
        const l = like(i, kj);
        if (!(l > 0)) return;
        best = Math.max(best, l);
        const w = l * near * Math.exp(-0.5 * ((kj - k) / c.relocateScaleSigma) ** 2);
        fresh[j][i] = w;
        total += w;
      });
    }
    if (best < minLike || !(total > 0)) return null;
    this.p.forEach((row, j) => {
      for (let i = 0; i < this.cells; i++) row[i] = c.relocateKeep * row[i] + ((1 - c.relocateKeep) * fresh[j][i]) / total;
    });
    this.normalise();
    const to = this.argmax().cell;
    this.anchor = { alongM: to * c.cellM, phoneM: this.phoneM };
    return to * c.cellM;
  }

  private estimateShare(cell: number): number {
    const reach = Math.round(30 / this.config.cellM);
    let share = 0;
    for (const row of this.p) for (let i = Math.max(0, cell - reach); i <= Math.min(this.cells - 1, cell + reach); i++) share += row[i];
    return share;
  }

  private argmax(): { cell: number; scale: number } {
    // The most likely cell over all scales, then its most likely scale.
    let cell = 0;
    let best = -1;
    const total = new Float64Array(this.cells);
    for (const row of this.p) for (let i = 0; i < this.cells; i++) total[i] += row[i];
    for (let i = 0; i < this.cells; i++) {
      if (total[i] > best) {
        best = total[i];
        cell = i;
      }
    }
    let scale = 0;
    for (let j = 1; j < this.p.length; j++) if (this.p[j][cell] > this.p[scale][cell]) scale = j;
    return { cell, scale };
  }

  private normalise(): void {
    let sum = 0;
    for (const row of this.p) for (let i = 0; i < this.cells; i++) sum += row[i];
    if (!(sum > 0)) return;
    for (const row of this.p) for (let i = 0; i < this.cells; i++) row[i] /= sum;
  }
}
