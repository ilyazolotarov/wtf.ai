// Finding a car's speed on its CAN bus without a profile (VEHICLE-LINK-SPEC §16.6): for a car whose make has no
// profile, or none heard, the monitor listens to a few of the ids at the OBD port at a time while the polls run, and
// every plausible field of their frames is fitted against OBD speed. Wheel speeds are unsigned counts, linear in the
// speed, 11–16 bits wide, at a byte boundary or a few bits from one, in either byte order: a field that follows the
// polls that closely across a range of speeds is a speed. Several such fields with one scale in a message are its
// wheels; which is which the phone's gyro tells later (wheel-order.ts). Pure: the app and replay
// (`npm run replay:discover`) run the same code.
import type { Profile, ValueField, WheelField } from "./profile";
import type { WheelOrder } from "./wheel-order";

/** A field of a frame: `bits` wide, `shift` bits up from the low end of the 16-bit word at `byte` (big- or little-endian). */
export interface FieldLayout {
  byte: number;
  endian: "be" | "le";
  shift: number;
  bits: number;
}

export interface FoundField extends FieldLayout {
  /** km/h per count and the count at standstill: kph = (value − offset) · kphPerCount. */
  kphPerCount: number;
  offset: number;
  /** Correlation with OBD speed over the moving pairs. */
  r: number;
}

export interface DiscoveredSpeed {
  id: number;
  /** Data length of its frames. */
  len: number;
  /** One field: a speed message; two or more with one scale: wheel speeds (sides unknown). */
  fields: FoundField[];
  pairs: number;
  rangeKph: number;
  /** Four wheels' order by the gyro (`WheelOrderFinder`), once learned: the field of each of [fl, fr, rl, rr]. */
  order?: WheelOrder;
}

export interface DiscoveryConfig {
  /** Pairs at or above this OBD speed fit the field. */
  movingKph: number;
  /** The frames around a poll at most this far apart. */
  bracketUs: number;
  /** A moving pair counts only where OBD changed at most this from the poll before (at most `steadyUs` earlier). */
  steadyKph: number;
  steadyUs: number;
  /** A batch is judged once it has this many moving pairs spanning this range. */
  judgePairs: number;
  judgeRangeKph: number;
  /** A field: correlation at least, resolution within (km/h per count), standstill within this of the fit's zero. */
  minR: number;
  kphPerCount: [number, number];
  standKph: number;
  /** Fields of one message whose scales agree within this share are its wheels. */
  sameScale: number;
}

export const DISCOVERY: DiscoveryConfig = {
  movingKph: 5,
  bracketUs: 800_000,
  steadyKph: 2,
  steadyUs: 1_200_000,
  judgePairs: 120,
  judgeRangeKph: 30,
  minR: 0.995,
  kphPerCount: [0.002, 1],
  standKph: 1.5,
  sameScale: 0.03,
};

const WIDTHS = [16, 15, 14, 13, 12, 11];
const MAX_SHIFT = 4;

/** Every layout tried in a frame of `len` bytes. */
export function layouts(len: number): FieldLayout[] {
  const out: FieldLayout[] = [];
  for (let byte = 0; byte + 1 < len; byte++) {
    for (const endian of ["be", "le"] as const) {
      for (let shift = 0; shift <= MAX_SHIFT; shift++) {
        for (const bits of WIDTHS) if (shift + bits <= 16) out.push({ byte, endian, shift, bits });
      }
    }
  }
  return out;
}

export function readField(f: FieldLayout, data: ArrayLike<number>): number {
  const a = data[f.byte];
  const b = data[f.byte + 1];
  const word = f.endian === "be" ? (a << 8) | b : a | (b << 8);
  return (word >>> f.shift) & ((1 << f.bits) - 1);
}

/** Running sums for a least-squares line and correlation of value on km/h. */
class Fit {
  n = 0;
  sx = 0;
  sy = 0;
  sxx = 0;
  syy = 0;
  sxy = 0;
  add(x: number, y: number): void {
    this.n++;
    this.sx += x;
    this.sy += y;
    this.sxx += x * x;
    this.syy += y * y;
    this.sxy += x * y;
  }
  /** value = a · kph + b, and r. */
  line(): { a: number; b: number; r: number } {
    const n = this.n;
    const vx = this.sxx - (this.sx * this.sx) / n;
    const vy = this.syy - (this.sy * this.sy) / n;
    const cxy = this.sxy - (this.sx * this.sy) / n;
    const a = vx > 0 ? cxy / vx : NaN;
    return { a, b: (this.sy - a * this.sx) / n, r: vx > 0 && vy > 0 ? cxy / Math.sqrt(vx * vy) : NaN };
  }
}

interface IdState {
  len: number;
  fields: FieldLayout[];
  fits: Fit[];
  /** Values while the car stood (OBD 0), per field: their sum and count. */
  standSum: number[];
  standN: number;
  frames: { tUs: number; data: number[] }[];
}

const KEEP_US = 3_000_000;
const PENDING_US = 2_000_000;

/** One batch of ids: their frames and the polls, fitted as they come. */
export class SpeedFieldFinder {
  private readonly ids = new Map<number, IdState>();
  private pending: { tUs: number; kph: number; steady: boolean }[] = [];
  private lastObd: { tUs: number; kph: number } | null = null;
  private moving = 0;
  private standing = 0;
  private minKph = Infinity;
  private maxKph = -Infinity;

  constructor(
    ids: number[],
    private readonly config: DiscoveryConfig = DISCOVERY,
  ) {
    for (const id of ids) this.ids.set(id, { len: 0, fields: [], fits: [], standSum: [], standN: 0, frames: [] });
  }

  /**
   * Moving pairs per id heard (each id counts its own: one whose frames come less often, or stopped, has fewer), and
   * whether the drive gave enough of a range and a stop for the fields' zero to judge any.
   */
  private counts(): { least: number; most: number; enough: boolean } {
    const n = [...this.ids.values()].filter((s) => s.len).map((s) => s.fits[0]?.n ?? 0);
    return {
      least: n.length ? Math.min(...n) : 0,
      most: n.length ? Math.max(...n) : 0,
      enough: this.maxKph - this.minKph >= this.config.judgeRangeKph && this.standing >= MIN_STAND,
    };
  }

  addFrame(id: number, tUs: number, data: number[]): void {
    const s = this.ids.get(id);
    if (!s || data.length < 2) return;
    if (!s.len) {
      s.len = data.length;
      s.fields = layouts(s.len);
      s.fits = s.fields.map(() => new Fit());
      s.standSum = s.fields.map(() => 0);
    }
    if (data.length !== s.len) return;
    s.frames.push({ tUs, data });
    while (s.frames.length && tUs - s.frames[0].tUs > KEEP_US) s.frames.shift();
    // A poll is paired once every id has a frame after it, or with the ids that have one when it can't wait longer: an
    // id that stopped sending (heard standing, silent driving) must not cost the others their pairs.
    this.pending = this.pending.filter((p) => {
      if (tUs - p.tUs <= PENDING_US && [...this.ids.values()].some((x) => x.len && !(x.frames.at(-1)!.tUs > p.tUs))) return true;
      this.pair(p);
      return false;
    });
  }

  addObd(tUs: number, kph: number): void {
    const prev = this.lastObd;
    this.lastObd = { tUs, kph };
    // Accelerating, the polls' lag shows as a spread: such a poll is kept for standing only.
    const steady = prev !== null && tUs - prev.tUs <= this.config.steadyUs && Math.abs(kph - prev.kph) <= this.config.steadyKph;
    this.pending.push({ tUs, kph, steady });
  }

  private pair(p: { tUs: number; kph: number; steady: boolean }): void {
    const c = this.config;
    let counted = false;
    let stood = false;
    for (const s of this.ids.values()) {
      if (!s.len) continue;
      let k = s.frames.length - 1;
      while (k >= 0 && s.frames[k].tUs > p.tUs) k--;
      const before = s.frames[k];
      const after = s.frames[k + 1];
      if (!before || !after || after.tUs - before.tUs > c.bracketUs) continue;
      const f = (p.tUs - before.tUs) / (after.tUs - before.tUs);
      if (p.kph === 0) {
        s.standN++;
        s.fields.forEach((fl, i) => (s.standSum[i] += readField(fl, before.data)));
        stood = true;
        continue;
      }
      if (p.kph < c.movingKph || !p.steady) continue;
      s.fields.forEach((fl, i) => {
        const v0 = readField(fl, before.data);
        const v1 = readField(fl, after.data);
        s.fits[i].add(p.kph, v0 + (v1 - v0) * f);
      });
      counted = true;
    }
    if (stood) this.standing++;
    if (!counted) return;
    this.moving++;
    this.minKph = Math.min(this.minKph, p.kph);
    this.maxKph = Math.max(this.maxKph, p.kph);
  }

  /**
   * The batch's outcome once ready: four wheels in a message decide at once; no field of any id even resembling a speed
   * (correlation under `REJECT_R`) rejects the batch early; otherwise more pairs, up to `MORE` times the least, before
   * the best found (if any) is taken. An id with fewer than `judgePairs` (it stopped sending, or its frames changed
   * length) holds the batch up only until the busiest has `MORE` times that: then the batch is judged without it, a
   * speed being sent all the time. Null: not decided yet.
   */
  judge(): { found: DiscoveredSpeed | null } | null {
    const c = this.counts();
    if (!c.enough || c.most < this.config.judgePairs) return null;
    const all = c.least >= this.config.judgePairs;
    const best = this.result();
    if (best && best.fields.length >= 4) return { found: best };
    if (all && !best && this.bestR() < REJECT_R) return { found: null };
    return (all ? c.least : c.most) >= MORE * this.config.judgePairs ? { found: best } : null;
  }

  /** The best correlation of any field of any id with enough pairs. */
  private bestR(): number {
    let best = -Infinity;
    for (const s of this.ids.values()) {
      for (const fit of s.fits) {
        if (fit.n < this.config.judgePairs) continue;
        const { r } = fit.line();
        if (r > best) best = r;
      }
    }
    return best;
  }

  /** The best speed message among the batch's ids, null when none of their fields is one. */
  result(): DiscoveredSpeed | null {
    let best: DiscoveredSpeed | null = null;
    for (const [id, s] of this.ids) {
      const found = this.fieldsOf(s);
      if (!found.length) continue;
      const d: DiscoveredSpeed = { id, len: s.len, fields: found, pairs: s.fits[0]?.n ?? 0, rangeKph: this.maxKph - this.minKph };
      if (!best || d.fields.length > best.fields.length || (d.fields.length === best.fields.length && meanR(d) > meanR(best))) best = d;
    }
    return best;
  }

  private fieldsOf(s: IdState): FoundField[] {
    const c = this.config;
    const ok: FoundField[] = [];
    s.fields.forEach((fl, i) => {
      const fit = s.fits[i];
      if (fit.n < c.judgePairs) return;
      const { a, b, r } = fit.line();
      if (!(r >= c.minR) || !(a > 0)) return;
      const kphPerCount = 1 / a;
      if (kphPerCount < c.kphPerCount[0] || kphPerCount > c.kphPerCount[1]) return;
      // Standing, the field reads the fit's zero (a counter or a filtered speed doesn't); that reading is the zero, exact
      // where the fit's is pulled by the polls' lag.
      const stand = s.standN >= MIN_STAND ? s.standSum[i] / s.standN : null;
      if (stand !== null && Math.abs(stand - b) * kphPerCount > c.standKph) return;
      ok.push({ ...fl, kphPerCount, offset: stand ?? b, r });
    });
    // Variants of one field (narrower masks, shifts of the same bits) fit alike over a drive's range, but a shifted one
    // is coarser and a narrower one wraps at higher speeds: per byte pair, the plainest of those that fit nearly as well
    // as its best (no shift, then the widest).
    const plainest: FoundField[] = [];
    for (const group of groupBy(ok, (f) => `${f.byte}${f.endian}`)) {
      const bestR = Math.max(...group.map((f) => f.r));
      const near = group.filter((f) => f.r >= bestR - NEAR_R);
      near.sort((x, y) => x.shift - y.shift || y.bits - x.bits);
      plainest.push(near[0]);
    }
    plainest.sort((x, y) => y.r - x.r);
    const kept: FoundField[] = [];
    for (const f of plainest) {
      if (kept.some((k) => Math.abs(k.byte - f.byte) < 2)) continue;
      if (kept.length && Math.abs(f.kphPerCount / kept[0].kphPerCount - 1) > c.sameScale) continue;
      kept.push(f);
    }
    return kept.sort((x, y) => x.byte - y.byte);
  }
}

const meanR = (d: DiscoveredSpeed) => d.fields.reduce((a, f) => a + f.r, 0) / d.fields.length;

/** A batch none of whose fields correlates this well with speed has none: the next. */
const REJECT_R = 0.9;
/** Neither four wheels nor nothing: decided at this many times the least pairs. */
const MORE = 3;
/** Standing polls that give a field's zero. */
const MIN_STAND = 3;

/** Variants of a field this close to its best fit count as fitting as well. */
const NEAR_R = 0.001;

function groupBy<T>(xs: T[], key: (x: T) => string): T[][] {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const g = m.get(k);
    if (g) g.push(x);
    else m.set(k, [x]);
  }
  return [...m.values()];
}

/**
 * Steps cars send speeds in, km/h per count: binary and decimal km/h, mph (0.01, 0.0062, 0.0375), m/s (0.01, 0.017).
 * A fit within `SNAP` of one is taken for it (the fit is off by a poll's 1 km/h steps and the ECU's own lag).
 */
const STEPS = [0.01, 0.02, 0.025, 0.03125, 0.04, 0.05, 0.0625, 0.1, 0.125, 0.25, 0.5, 1, 0.016093, 0.06035, 0.036, 0.0612];
const SNAP = 0.02;

/**
 * The fields as a car would send them. A message's fields share their step and their zero (fieldsOf keeps only fields
 * whose scales agree), so those are taken from the fields together: the step their median, snapped to a common one
 * (else 4 significant digits); the zero their mean in km/h at that step, to a whole km/h when within 1 km/h of one
 * (else a whole count). A field whose own zero is further than `ZERO_KPH` from the shared one keeps its own.
 */
export function tidy(fields: FoundField[]): FoundField[] {
  const k = [...fields.map((f) => f.kphPerCount)].sort((a, b) => a - b)[fields.length >> 1];
  const step = STEPS.find((st) => Math.abs(k / st - 1) <= SNAP);
  const digits = 4 - Math.ceil(Math.log10(k));
  const kphPerCount = step ?? Math.round(k * 10 ** digits) / 10 ** digits;
  const zeroKph = fields.reduce((sum, f) => sum + f.offset * kphPerCount, 0) / fields.length;
  const shared = Math.abs(zeroKph - Math.round(zeroKph)) <= 1 ? Math.round(zeroKph) / kphPerCount : zeroKph / kphPerCount;
  return fields.map((f) => ({
    ...f,
    kphPerCount,
    offset: Math.round(Math.abs(f.offset - shared) * kphPerCount <= ZERO_KPH ? shared : f.offset),
  }));
}

/** A field's own zero this far from its message's (km/h): not the same zero. */
const ZERO_KPH = 3;

/** Each field's speed in a frame of the find's id (m/s, unsigned, as `tidy` reads them), null for another length. */
export function fieldSpeeds(d: DiscoveredSpeed): (data: ArrayLike<number>, len: number) => number[] | null {
  const fields = tidy(d.fields);
  return (data, len) => (len === d.len ? fields.map((f) => Math.max(0, (readField(f, data) - f.offset) * f.kphPerCount) / 3.6) : null);
}

/**
 * A profile from a discovery: its speed the mean of the fields found, unsigned (no gear known). Its wheels, and with
 * them turning, only once the gyro told which is which (`order`). Its key, "found/<id>/<length>/<field>+…[/w<order>]",
 * is the whole layout: the same for the same find, so probation's verdict holds across drives (the order changes no
 * speed: `speedKey`), and replay rebuilds the profile from a log's note (`foundProfile`).
 */
export function discoveredProfile(make: string, d: DiscoveredSpeed): Profile {
  const fields = tidy(d.fields);
  const read: ValueField["read"] = (data, len) => {
    if (len !== d.len) return NaN;
    let sum = 0;
    for (const f of fields) sum += (readField(f, data) - f.offset) * f.kphPerCount;
    return Math.max(0, sum / fields.length) / 3.6;
  };
  const speeds = fieldSpeeds(d);
  const order = wheelOrder(d);
  const wheel = (i: number): WheelField => ({ id: d.id, read: (data, len) => speeds(data, len)?.[i] ?? NaN });
  const key = foundKey(d);
  return {
    key,
    make,
    mapping: "found",
    dbc: key,
    dbcOnly: true,
    ...(order ? { wheels: order.map(wheel) as Profile["wheels"] } : {}),
    speed: [{ id: d.id, read }],
    gear: [],
    steer: [],
    brake: [],
    yaw: [],
    ids: new Map([[d.id, { msg: "found", size: d.len }]]),
    speedIds: [d.id],
  };
}

/** A find's wheels' order, when it has four fields and one (each field once). */
const wheelOrder = (d: DiscoveredSpeed): WheelOrder | null =>
  d.order && d.fields.length === 4 && new Set(d.order).size === 4 ? d.order : null;

/** The key of a find's profile (`discoveredProfile`). */
export function foundKey(d: DiscoveredSpeed): string {
  const order = wheelOrder(d);
  return `found/${d.id.toString(16)}/${d.len}/${tidy(d.fields).map(fieldKey).join("+")}${order ? `/w${order.join("")}` : ""}`;
}

/** "b2be14s0x0.03125o0": byte, order, bits, shift, scale, offset. */
export function fieldKey(f: FoundField): string {
  return `b${f.byte}${f.endian}${f.bits}s${f.shift}x${f.kphPerCount}o${f.offset}`;
}

const FIELD_KEY = /^b(\d+)(be|le)(\d+)s(\d+)x([0-9.e-]+)o(-?\d+)$/;
const FOUND_KEY = /^found\/([0-9a-f]+)\/(\d+)\/([^/]+)(?:\/w([0-3]{4}))?$/;
const ORDER_SUFFIX = /\/w[0-3]{4}$/;

/** The key a profile's speed is checked under (probation, §16.5): a find's without its wheels' order. */
export const speedKey = (key: string): string => (key.startsWith("found/") ? key.replace(ORDER_SUFFIX, "") : key);

/** The find a `discoveredProfile` key names (a log's note), null when it isn't one. */
export function foundSpeed(key: string): DiscoveredSpeed | null {
  const m = FOUND_KEY.exec(key);
  if (!m) return null;
  const fields: FoundField[] = [];
  for (const part of m[3].split("+")) {
    const f = FIELD_KEY.exec(part);
    if (!f) return null;
    fields.push({ byte: +f[1], endian: f[2] as "be" | "le", bits: +f[3], shift: +f[4], kphPerCount: +f[5], offset: +f[6], r: 1 });
  }
  const order = m[4] ? ([...m[4]].map(Number) as WheelOrder) : undefined;
  const d: DiscoveredSpeed = { id: parseInt(m[1], 16), len: +m[2], fields, pairs: 0, rangeKph: 0, ...(order ? { order } : {}) };
  return foundKey(d) === key ? d : null;
}

/** The profile a `discoveredProfile` key names (a log's note), null when it isn't one. */
export function foundProfile(key: string, make = "unknown"): Profile | null {
  const d = foundSpeed(key);
  return d ? discoveredProfile(make, d) : null;
}
