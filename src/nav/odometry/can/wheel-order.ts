// Which of a find's four wheel fields is which wheel (VEHICLE-LINK-SPEC §16.6), from the phone's gyro while it sits in
// its mount. In a turn the outer wheels run faster than the inner ones, so a field ahead of the four's mean in left
// turns (the gyro's yaw positive) and behind in right ones is a right wheel. The front wheels run a wider arc than the
// rear ones: ahead of them in every turn, either way, most in tight slow ones. Over stretches of 5 s of samples, per
// field i:
//   ∫ (v_i − v̄) dt = a_i · ∫ ω dt + b_i · ∫ ω²/v̄ dt + c_i · ∫ v̄ dt
// a_i is ± half the track (right +), b_i ± a quarter of the wheelbase squared (front +), c_i the field's tyre against
// the others'. Only above `NO_GEAR_MIN_MPS`: a find has no gear, and reversing (slower) reads every turn the other way.
// Pure: the app (`CanWheelOrder`) and replay (`npm run replay:discover`) run the same code.
import { CAN_SPEED_PERIOD_US } from "./can-speed";
import { NO_GEAR_MIN_MPS } from "./wheel-yaw";
import { WHEEL_LAG_US } from "./wheel-yaw-source";

/** The field (index in the find's fields) of each wheel: [fl, fr, rl, rr]. */
export type WheelOrder = [number, number, number, number];

/** What the fit has learned so far, kept between drives (plain numbers, JSON). */
export interface WheelOrderSums {
  /** Stretches fitted. */
  n: number;
  /** Σ x·xᵀ over the stretches, x = [∫ω, ∫ω²/v̄, ∫v̄] (3 × 3, row by row). */
  xx: number[];
  /** Σ x·d_i per field, d_i = ∫ (v_i − v̄). */
  xd: number[][];
  /** Σ d_i² per field. */
  dd: number[];
  /** The stretches' turning to the left and to the right, rad. */
  leftRad: number;
  rightRad: number;
}

export interface WheelOrderConfig {
  minSpeedMps: number;
  /** Samples (0.1 s each) in a stretch. */
  stretchSamples: number;
  /** Before a verdict: this many stretches, and this much turning each way. */
  minStretches: number;
  minTurnRad: number;
  /** A field's side, and its axle, is clear at this many standard errors of its fit. */
  sideT: number;
  axleT: number;
  /** Four wheels of a car: the tracks and the wheelbase within these, m. */
  trackM: [number, number];
  wheelbaseM: [number, number];
}

export const WHEEL_ORDER: WheelOrderConfig = {
  minSpeedMps: NO_GEAR_MIN_MPS,
  stretchSamples: 50,
  minStretches: 24,
  minTurnRad: Math.PI / 2,
  sideT: 10,
  axleT: 5,
  trackM: [1.2, 2.1],
  wheelbaseM: [1.8, 4],
};

export interface WheelOrderFit {
  /** Per field: a_i (m, right +) and b_i (m², front +), each over its standard error. */
  fields: { side: number; sideT: number; axle: number; axleT: number }[];
}

export type WheelOrderVerdict =
  | { order: WheelOrder; trackM: number; frontTrackM: number; wheelbaseM: number }
  /** The gyro says the fields aren't four wheels: kept, nothing more is learned. */
  | { order: null; reason: string };

const emptySums = (): WheelOrderSums => ({
  n: 0,
  xx: new Array<number>(9).fill(0),
  xd: [0, 1, 2, 3].map(() => [0, 0, 0]),
  dd: [0, 0, 0, 0],
  leftRad: 0,
  rightRad: 0,
});

const copySums = (s: WheelOrderSums): WheelOrderSums => ({ ...s, xx: [...s.xx], xd: s.xd.map((r) => [...r]), dd: [...s.dd] });

/** Gyro samples around a wheel sample's time (less the wheels' lag) averaged within this. */
const GYRO_HALF_US = 50_000;
/** Kept this long: a wheel sample comes out of the feed 0.07–0.15 s after its time, one in ten over 0.3 s. */
const KEEP_US = 3_000_000;

export class WheelOrderFinder {
  private readonly c: WheelOrderConfig;
  private s: WheelOrderSums;
  private gyro: { tUs: number; radps: number | null }[] = [];
  private pending: { tUs: number; v: readonly number[] }[] = [];
  private w = { n: 0, y: 0, q: 0, dist: 0, d: [0, 0, 0, 0] };

  constructor(sums?: WheelOrderSums | null, config: Partial<WheelOrderConfig> = {}) {
    this.c = { ...WHEEL_ORDER, ...config };
    this.s = sums ? copySums(sums) : emptySums();
  }

  get sums(): WheelOrderSums {
    return copySums(this.s);
  }

  /** Stretches fitted so far (the sums change with each). */
  get stretches(): number {
    return this.s.n;
  }

  /** The gyro's yaw about "up" for an IMU sample, in time order (null: the phone is being handled). */
  addGyro(tUs: number, radps: number | null): void {
    this.gyro.push({ tUs, radps });
    while (this.gyro.length && this.gyro[0].tUs < tUs - KEEP_US) this.gyro.shift();
    this.drain();
  }

  /**
   * A sample of the four fields (m/s, unsigned, the find's order), averaged over `CAN_SPEED_PERIOD_US`: fitted once the
   * gyro around it is in.
   */
  addFields(tUs: number, v: readonly number[]): void {
    this.pending.push({ tUs, v });
    this.drain();
  }

  private drain(): void {
    const last = this.gyro.at(-1)?.tUs ?? -Infinity;
    while (this.pending.length) {
      const p = this.pending[0];
      const at = p.tUs - WHEEL_LAG_US;
      if (at + GYRO_HALF_US > last) {
        // The gyro around it isn't in yet. With none coming (the IMU stopped), the oldest go.
        if (this.pending.length <= KEEP_US / CAN_SPEED_PERIOD_US) break;
        this.pending.shift();
        continue;
      }
      this.pending.shift();
      this.fit(p.v, this.gyroAround(at));
    }
  }

  private gyroAround(tUs: number): number | null {
    let sum = 0;
    let n = 0;
    for (let i = this.gyro.length - 1; i >= 0 && this.gyro[i].tUs >= tUs - GYRO_HALF_US; i--) {
      const g = this.gyro[i];
      if (g.tUs > tUs + GYRO_HALF_US) continue;
      if (g.radps === null) return null;
      sum += g.radps;
      n++;
    }
    return n ? sum / n : null;
  }

  private fit(v: readonly number[], yaw: number | null): void {
    const mean = (v[0] + v[1] + v[2] + v[3]) / 4;
    if (yaw === null || !(mean >= this.c.minSpeedMps)) return;
    const dt = CAN_SPEED_PERIOD_US / 1e6;
    const w = this.w;
    w.n++;
    w.y += yaw * dt;
    w.q += ((yaw * yaw) / mean) * dt;
    w.dist += mean * dt;
    for (let i = 0; i < 4; i++) w.d[i] += (v[i] - mean) * dt;
    if (w.n < this.c.stretchSamples) return;
    const x = [w.y, w.q, w.dist];
    const s = this.s;
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) s.xx[3 * r + k] += x[r] * x[k];
    for (let i = 0; i < 4; i++) {
      for (let k = 0; k < 3; k++) s.xd[i][k] += x[k] * w.d[i];
      s.dd[i] += w.d[i] * w.d[i];
    }
    s.n++;
    if (w.y > 0) s.leftRad += w.y;
    else s.rightRad -= w.y;
    this.w = { n: 0, y: 0, q: 0, dist: 0, d: [0, 0, 0, 0] };
  }

  /** The least-squares fit of every field so far; null with too few stretches to fit three terms. */
  fitted(): WheelOrderFit | null {
    const s = this.s;
    if (s.n < 4) return null;
    const inv = invert3(s.xx);
    if (!inv) return null;
    const fields = s.xd.map((xd, i) => {
      const beta = [0, 1, 2].map((r) => inv[3 * r] * xd[0] + inv[3 * r + 1] * xd[1] + inv[3 * r + 2] * xd[2]);
      // The residuals' sum of squares at the least-squares solution: Σd² − βᵀ·Σxd.
      const rss = Math.max(0, s.dd[i] - (beta[0] * xd[0] + beta[1] * xd[1] + beta[2] * xd[2]));
      const sigma2 = rss / (s.n - 3);
      const se = (k: number) => Math.sqrt(sigma2 * inv[4 * k]);
      return { side: beta[0], sideT: beta[0] / se(0), axle: beta[1], axleT: beta[1] / se(1) };
    });
    return { fields };
  }

  /**
   * Null until the fit is clear: every field's side and axle at `sideT`, `axleT`, after `minStretches` and
   * `minTurnRad` each way. Then the order; or, when clear sides or axles don't make one wheel a corner or a car's
   * shape, not four wheels. A fit that stays unclear never decides: a lack of turns says nothing of the fields.
   */
  verdict(): WheelOrderVerdict | null {
    const c = this.c;
    const s = this.s;
    if (s.n < c.minStretches || s.leftRad < c.minTurnRad || s.rightRad < c.minTurnRad) return null;
    const f = this.fitted()?.fields;
    if (!f) return null;
    const sides = f.every((x) => Math.abs(x.sideT) >= c.sideT);
    if (sides && f.filter((x) => x.side > 0).length !== 2) return { order: null, reason: "not two wheels a side" };
    if (!sides || !f.every((x) => Math.abs(x.axleT) >= c.axleT)) return null;
    const corner = (front: boolean, right: boolean) => f.findIndex((x) => x.axle > 0 === front && x.side > 0 === right);
    const order: WheelOrder = [corner(true, false), corner(true, true), corner(false, false), corner(false, true)];
    if (order.includes(-1)) return { order: null, reason: "not two wheels an axle" };
    const [fl, fr, rl, rr] = order.map((i) => f[i]);
    const trackM = rr.side - rl.side;
    const frontTrackM = fr.side - fl.side;
    const wheelbaseM = Math.sqrt(Math.max(0, fl.axle + fr.axle - rl.axle - rr.axle));
    const within = (x: number, [lo, hi]: [number, number]) => x >= lo && x <= hi;
    if (!within(trackM, c.trackM) || !within(frontTrackM, c.trackM) || !within(wheelbaseM, c.wheelbaseM)) {
      return { order: null, reason: `no car's shape (tracks ${frontTrackM.toFixed(2)}/${trackM.toFixed(2)} m, wheelbase ${wheelbaseM.toFixed(2)} m)` };
    }
    return { order, trackM, frontTrackM, wheelbaseM };
  }
}

/** The inverse of a symmetric 3 × 3 matrix (row by row), null when singular. */
function invert3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12 * Math.abs(a * e * i || 1)) return null;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((x) => x / det);
}
