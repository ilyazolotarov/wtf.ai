// Magnetometer heading (NAVIGATOR-SPEC §7.5–7.6, MAPMATCH-SPEC §8.2): the raw field, levelled with
// gravity, calibrated against headings the navigator knows.
//
// The raw field holds a large constant offset (the phone's own and the car's, ~140 µT here) on top of
// Earth's horizontal field (~19 µT), so it is useless until calibrated. In a frame levelled with
// gravity and fixed to the phone, the horizontal field is
//
//   m = c + A · [cos ψ, sin ψ],   A = [[a, −b], [b, a]]
//
// with ψ the car's heading (clockwise from north): an offset c plus Earth's field turned by the
// mounting and scaled (4 parameters, linear least squares). It is learned while the EKF's heading is
// good and kept as normal equations, so drives add up and a stored calibration seeds the next drive.
// It holds only as long as the phone sits in the same mount, so each mounting (tilt) has its own. A
// phone turned in its mount at the same tilt can't be told apart: the trust check has to catch it.

import type { Vec3 } from "../types";

export interface CompassConfig {
  /** The field is averaged over this window (it is noisy, and the gyro handles fast turns). */
  windowUs: number;
  /** Learning and checks need the car driving straight: turned less than this over the window. */
  straightTurnRad: number;
  /** A fit needs this many samples… */
  minSamples: number;
  /** …spread over this many of 8 heading sectors (45° each). */
  minSectors: number;
  /** The phone's tilt may differ this much from the one the calibration was learned at. */
  mountToleranceRad: number;
  /** Calibrations kept per car, one per mounting (tilt), most recent first. */
  maxMountings: number;
  /** Trust check: this many comparisons with a known heading… */
  checkSamples: number;
  /** …whose median difference beyond this rejects the stored calibration. */
  rejectRad: number;
  /** Heading σ handed out (cross-drive errors: median 4–18°, p90 12–31° on 7 drives). */
  sigmaRad: number;
}

const DEG = Math.PI / 180;

export const DEFAULT_COMPASS_CONFIG: CompassConfig = {
  windowUs: 1_000_000,
  straightTurnRad: 3 * DEG,
  minSamples: 60,
  minSectors: 5,
  mountToleranceRad: 10 * DEG,
  maxMountings: 3,
  checkSamples: 10,
  rejectRad: 45 * DEG,
  sigmaRad: 25 * DEG,
};

/** What a calibration learned: the normal equations of the fit, and the mounting it holds for. */
export interface CompassCalibration {
  /** Phone axis (0 x, 1 y, 2 z) whose horizontal projection is the levelled frame's first axis. */
  refAxis: 0 | 1 | 2;
  /** Unit "up" in the phone frame where it was learned. */
  up: [number, number, number];
  /** XᵀX (4×4, row-major), Xᵀy, yᵀy over samples; parameters [cx, cy, a, b]. */
  xtx: number[];
  xty: number[];
  yty: number;
  samples: number;
  /** Bit k set: a sample with a heading in sector k (45° each). */
  sectors: number;
  /**
   * Everything in it was learned or confirmed on the drive that kept it. A stored calibration without
   * this is still checked, but not handed out until it passes.
   */
  confirmed: boolean;
}

export type CompassTrust = "none" | "unverified" | "confirmed" | "rejected";

interface Fit {
  cx: number;
  cy: number;
  a: number;
  b: number;
}

const TWO_PI = 2 * Math.PI;
const wrap = (a: number) => a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI);
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const popcount = (x: number) => {
  let n = 0;
  for (let v = x; v; v &= v - 1) n++;
  return n;
};

function emptyCalibration(refAxis: 0 | 1 | 2, up: Vec3): CompassCalibration {
  return { refAxis, up: [up[0], up[1], up[2]], xtx: new Array<number>(16).fill(0), xty: [0, 0, 0, 0], yty: 0, samples: 0, sectors: 0, confirmed: true };
}

/** The sum of two calibrations' normal equations (the first one's frame). */
export function mergeCalibrations(a: CompassCalibration, b: CompassCalibration): CompassCalibration {
  return {
    refAxis: a.refAxis,
    up: a.up,
    xtx: a.xtx.map((v, i) => v + b.xtx[i]),
    xty: a.xty.map((v, i) => v + b.xty[i]),
    yty: a.yty + b.yty,
    samples: a.samples + b.samples,
    sectors: a.sectors | b.sectors,
    confirmed: a.confirmed && b.confirmed,
  };
}

/**
 * The same calibration, believing every heading `deltaRad` off (replay fault injection: a phone turned
 * in its mount, or another car's calibration). Replacing ψ by ψ + δ multiplies the design matrix by a
 * rotation of its last two columns, so the normal equations transform without the samples.
 */
export function rotateCalibration(cal: CompassCalibration, deltaRad: number): CompassCalibration {
  const c = Math.cos(deltaRad);
  const s = Math.sin(deltaRad);
  // T = blockdiag(I₂, [[c, −s], [s, c]]); X' = X T → X'ᵀX' = Tᵀ XᵀX T, X'ᵀy = Tᵀ Xᵀy.
  const t = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, c, -s],
    [0, 0, s, c],
  ];
  const m = (i: number, j: number) => cal.xtx[i * 4 + j];
  const xtx = new Array<number>(16).fill(0);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      let v = 0;
      for (let k = 0; k < 4; k++) for (let l = 0; l < 4; l++) v += t[k][i] * m(k, l) * t[l][j];
      xtx[i * 4 + j] = v;
    }
  const xty = [0, 1, 2, 3].map((i) => t.reduce((acc, row, k) => acc + row[i] * cal.xty[k], 0));
  return { ...cal, xtx, xty };
}

/** Solve the 4×4 normal equations (Gaussian elimination); null when singular. */
function solve(cal: CompassCalibration): Fit | null {
  const m = [0, 1, 2, 3].map((i) => [...cal.xtx.slice(i * 4, i * 4 + 4), cal.xty[i]]);
  for (let col = 0; col < 4; col++) {
    let p = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(m[r][col]) > Math.abs(m[p][col])) p = r;
    if (Math.abs(m[p][col]) < 1e-9) return null;
    [m[col], m[p]] = [m[p], m[col]];
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let j = col; j < 5; j++) m[r][j] -= f * m[col][j];
    }
  }
  const [cx, cy, a, b] = [0, 1, 2, 3].map((i) => m[i][4] / m[i][i]);
  return a * a + b * b > 0 ? { cx, cy, a, b } : null;
}

/** The phone axis most nearly horizontal: its projection is a stable first axis of the levelled frame. */
function horizontalAxis(up: Vec3): 0 | 1 | 2 {
  const a = up.map(Math.abs);
  return a[0] <= a[1] && a[0] <= a[2] ? 0 : a[1] <= a[2] ? 1 : 2;
}

/**
 * One way the phone sits in the car (its tilt): the calibration stored for it, what this drive learns
 * there, and the trust check of the stored one. A calibration holds only for its own mounting, so each
 * is kept apart: learning in one never changes another.
 */
interface Mounting {
  stored: CompassCalibration | null;
  session: CompassCalibration | null;
  trust: CompassTrust;
  checks: number[];
  fit: Fit | null;
  /** The phone sat this way at some point of this drive. */
  used: boolean;
}

/** The frame a mounting's samples are levelled in: the stored calibration's, else this drive's. */
const frameOf = (m: Mounting): CompassCalibration | null => m.stored ?? m.session;
const samplesOf = (m: Mounting) => (m.stored?.samples ?? 0) + (m.session?.samples ?? 0);
const tiltBetween = (a: Vec3, b: Vec3) => Math.acos(Math.min(1, dot(a, b)));
const combined = (m: Mounting): CompassCalibration | null =>
  m.stored && m.session ? mergeCalibrations(m.stored, m.session) : (m.stored ?? m.session);

export class Compass {
  readonly config: CompassConfig;
  private mountings: Mounting[] = [];
  /** The mounting the phone's tilt matches now (null: none known). */
  private active: Mounting | null = null;
  private lastActive: Mounting | null = null;
  private up: Vec3 | null = null;
  private handled = false;
  // The window: levelled samples, and the yaw rate (with its time step) to sum the turn over it.
  private window: { tUs: number; x: number; y: number }[] = [];
  private sumX = 0;
  private sumY = 0;
  private yaw: { tUs: number; turn: number }[] = [];
  private yawSum = 0;
  private lastImuUs: number | null = null;
  /** Compass minus known heading at every trust check (replay statistics). */
  readonly checkDiffs: number[] = [];

  constructor(config: Partial<CompassConfig> = {}) {
    this.config = { ...DEFAULT_COMPASS_CONFIG, ...config };
  }

  /**
   * Calibrations from earlier drives (same phone, same car), one per mounting, most recent first.
   * Each is unverified until checked.
   */
  setCalibrations(cals: readonly CompassCalibration[]): void {
    this.mountings = cals.map((stored) => ({ stored, session: null, trust: "unverified", checks: [], fit: null, used: false }));
    this.mountings.forEach((m) => this.refit(m));
    this.active = null;
    this.lastActive = null;
    this.clearWindow();
  }

  setCalibration(cal: CompassCalibration | null): void {
    this.setCalibrations(cal ? [cal] : []);
  }

  /**
   * What to keep for the next drive, most recent first (this drive's mountings, then the rest as
   * stored), at most `maxMountings`. Each is stored and learned together; confirmed unless this drive
   * sat in a stored one and never checked it.
   */
  get calibrations(): CompassCalibration[] {
    const used = this.mountings.filter((m) => m.used).sort((a, b) => samplesOf(b) - samplesOf(a));
    const rest = this.mountings.filter((m) => !m.used);
    return [...used, ...rest]
      .map((m) => this.kept(m))
      .filter((c): c is CompassCalibration => c !== null)
      .slice(0, this.config.maxMountings);
  }

  /** The mounting this drive used most (or the first stored one): replay and the benchmarks. */
  get calibration(): CompassCalibration | null {
    return this.calibrations[0] ?? null;
  }

  /** Trust of the mounting the phone sits in (or last sat in on this drive). */
  get trust(): CompassTrust {
    return (this.active ?? this.lastActive)?.trust ?? "none";
  }

  /** Every IMU sample: the phone's attitude and yaw rate, and whether it is being handled. */
  onImu(tUs: number, up: Vec3, yawRate: number, valid: boolean): void {
    this.up = up;
    this.handled = !valid;
    if (valid) this.selectMounting(up);
    const dt = this.lastImuUs === null ? 0 : Math.min(0.2, Math.max(0, (tUs - this.lastImuUs) / 1e6));
    this.lastImuUs = tUs;
    const turn = yawRate * dt;
    this.yaw.push({ tUs, turn });
    this.yawSum += turn;
    while (this.yaw.length && this.yaw[0].tUs < tUs - this.config.windowUs) this.yawSum -= this.yaw.shift()!.turn;
  }

  /** A raw field sample (µT, phone frame). */
  onMag(tUs: number, field: Vec3): void {
    const up = this.up;
    if (!up) return;
    const frame = this.active ? frameOf(this.active) : null;
    const axis = (frame?.refAxis ?? horizontalAxis(up)) as number;
    // e1 = the reference axis projected onto the horizontal, e2 = up × e1 (right-handed, like forward/left).
    const r: Vec3 = [axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0];
    const k = dot(r, up);
    const e1x = r[0] - k * up[0];
    const e1y = r[1] - k * up[1];
    const e1z = r[2] - k * up[2];
    const n = Math.hypot(e1x, e1y, e1z);
    if (n < 0.3) return;
    const e1: Vec3 = [e1x / n, e1y / n, e1z / n];
    const e2: Vec3 = [up[1] * e1[2] - up[2] * e1[1], up[2] * e1[0] - up[0] * e1[2], up[0] * e1[1] - up[1] * e1[0]];
    const s = { tUs, x: dot(field, e1), y: dot(field, e2) };
    this.window.push(s);
    this.sumX += s.x;
    this.sumY += s.y;
    while (this.window.length && this.window[0].tUs < tUs - this.config.windowUs) {
      const old = this.window.shift()!;
      this.sumX -= old.x;
      this.sumY -= old.y;
    }
  }

  /**
   * The car's heading from the field (clockwise from north) and its σ. Null without a usable
   * calibration for the phone's mounting, after a rejection, or with the phone handled.
   */
  heading(): { psi: number; sigma: number } | null {
    const m = this.active;
    // Not confirmed on the drive that kept it (never checked there): checked here, not handed out.
    if (!m || (m.trust === "unverified" && !m.stored?.confirmed)) return null;
    return this.estimate(m);
  }

  /**
   * The navigator knows the heading (EKF, small σ). Compare first (trust check), then learn from it.
   * Only while driving straight with the phone in its mount: the field lags in turns.
   */
  observe(psi: number): void {
    if (this.handled || !this.straight()) return;
    const mean = this.mean();
    const up = this.up;
    if (!mean || !up) return;
    // A mounting no calibration knows: learn it as a new one.
    const m = this.active ?? this.addMounting(up);
    const own = this.estimate(m);
    if (own && m.trust === "unverified") {
      const d = wrap(own.psi - psi);
      this.checkDiffs.push(d);
      m.checks.push(Math.abs(d));
      if (m.checks.length >= this.config.checkSamples) {
        const sorted = [...m.checks].sort((x, y) => x - y);
        const median = sorted[sorted.length >> 1];
        if (median > this.config.rejectRad) {
          // Wrong for this car or mounting: start over from what this drive learns (in the same frame).
          m.trust = "rejected";
          m.session ??= emptyCalibration(m.stored!.refAxis, m.stored!.up);
          m.stored = null;
        } else {
          m.trust = "confirmed";
        }
      }
    } else if (own && m.trust === "confirmed") {
      this.checkDiffs.push(wrap(own.psi - psi));
    }
    // Learn into this mounting's session, in its frame.
    const frame = frameOf(m)!;
    m.session ??= emptyCalibration(frame.refAxis, frame.up);
    const s = m.session;
    const c = Math.cos(psi);
    const sn = Math.sin(psi);
    const rows = [
      { x: [1, 0, c, -sn], y: mean.x },
      { x: [0, 1, sn, c], y: mean.y },
    ];
    for (const row of rows) {
      for (let i = 0; i < 4; i++) {
        s.xty[i] += row.x[i] * row.y;
        for (let j = 0; j < 4; j++) s.xtx[i * 4 + j] += row.x[i] * row.x[j];
      }
      s.yty += row.y * row.y;
    }
    s.samples++;
    s.sectors |= 1 << Math.floor(((psi % TWO_PI) + TWO_PI) % TWO_PI / (Math.PI / 4)) % 8;
    this.refit(m);
  }

  /** The heading from a mounting's fit, before the gate on unconfirmed calibrations. */
  private estimate(m: Mounting): { psi: number; sigma: number } | null {
    if (!m.fit || m.trust === "rejected" || this.handled) return null;
    const mean = this.mean();
    if (!mean) return null;
    const { cx, cy, a, b } = m.fit;
    // A⁻¹ (m − c) = [cos ψ, sin ψ] · |A|
    const dx = mean.x - cx;
    const dy = mean.y - cy;
    return { psi: Math.atan2(-b * dx + a * dy, a * dx + b * dy), sigma: this.config.sigmaRad };
  }

  /** The mounting the tilt matches: the current one while it still does, else the closest. */
  private selectMounting(up: Vec3): void {
    const tol = this.config.mountToleranceRad;
    const current = this.active ? frameOf(this.active) : null;
    if (current && tiltBetween(up, current.up) <= tol) return;
    let best: Mounting | null = null;
    let bestTilt = tol;
    for (const m of this.mountings) {
      const frame = frameOf(m);
      const tilt = frame ? tiltBetween(up, frame.up) : Infinity;
      if (tilt <= bestTilt) {
        best = m;
        bestTilt = tilt;
      }
    }
    if (best === this.active) return;
    this.active = best;
    if (best) {
      best.used = true;
      this.lastActive = best;
    }
    // The window was levelled in the previous mounting's frame.
    this.clearWindow();
  }

  /** A new mounting, learned from scratch in the current tilt; the least useful one makes room. */
  private addMounting(up: Vec3): Mounting {
    if (this.mountings.length >= this.config.maxMountings) {
      const spare = [...this.mountings].sort((a, b) => Number(a.used) - Number(b.used) || samplesOf(a) - samplesOf(b))[0];
      this.mountings = this.mountings.filter((m) => m !== spare);
    }
    // The window is already levelled on this axis (no mounting was active).
    const m: Mounting = { stored: null, session: emptyCalibration(horizontalAxis(up), up), trust: "none", checks: [], fit: null, used: true };
    this.mountings.push(m);
    this.active = m;
    this.lastActive = m;
    return m;
  }

  private kept(m: Mounting): CompassCalibration | null {
    const cal = combined(m);
    if (!cal) return null;
    // Sat in and never checked: unconfirmed. Not sat in: as it was stored.
    const confirmed = m.used ? !(m.stored && m.trust === "unverified") : (m.stored?.confirmed ?? true);
    return { ...cal, confirmed };
  }

  private refit(m: Mounting): void {
    // Until checked, the stored calibration is judged on its own: what this drive learns would
    // otherwise correct a wrong one and let it pass the check.
    const cal = m.trust === "unverified" ? m.stored : combined(m);
    m.fit = cal && cal.samples >= this.config.minSamples && popcount(cal.sectors) >= this.config.minSectors ? solve(cal) : null;
    // Learned on this drive alone (nothing stored, or the stored one rejected): its own headings.
    if (m.fit && !m.stored && m.trust !== "confirmed") m.trust = "confirmed";
  }

  private clearWindow(): void {
    this.window = [];
    this.sumX = 0;
    this.sumY = 0;
  }

  private straight(): boolean {
    return this.yaw.length > 0 && Math.abs(this.yawSum) < this.config.straightTurnRad;
  }

  private mean(): { x: number; y: number } | null {
    const n = this.window.length;
    if (n < 5 || this.window[n - 1].tUs - this.window[0].tUs < this.config.windowUs / 2) return null;
    return { x: this.sumX / n, y: this.sumY / n };
  }
}
