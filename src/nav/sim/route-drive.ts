// The car's test drive (docs/ANDROID-AUTO-SPEC.md §4, Android for Cars quality guideline NF-7): a car that keeps to a
// route's line exactly, at a town's speed, slowing for its bends and to a stop at its end. Not the navigator's
// simulated drives (city-drive.ts): no sensors, only the dot the map and the guidance follow. The emulated adapter's
// car drives the same way along the route or the road (VEHICLE-LINK-SPEC §13), its wheels turning as the line does.

import { type Coordinate } from "../geo";
import { LocalFrame } from "../geo/local-frame";

/** On the straight. */
export const DRIVE_CRUISE_MPS = 50 / 3.6;
export const DRIVE_ACCEL_MPS2 = 1.5;
export const DRIVE_BRAKE_MPS2 = 1.5;
/** The last metres to the end, slow but not slower (braking to the end alone would never get there). */
const DRIVE_CRAWL_MPS = 1;
/** Through a bend whose heading turns this much (rad) or more, at most this speed. */
const BENDS: readonly [number, number][] = [
  [1.2, 4.5],
  [0.6, 7],
  [0.25, 10],
];
/** A bend's turn is the heading this far before its point against this far after: a line's points are dense on curves. */
const BEND_SPAN_M = 15;
/** Bends further ahead don't slow the car yet (braking from the cruise to the slowest bend takes ~60 m). */
const LOOK_AHEAD_M = 200;
/**
 * The car's own heading is the line's over this chord around it: a corner drawn as one vertex is turned through on an
 * arc, a right angle on a ~8 m radius, as a car does, not in one step.
 */
const TURN_CHORD_M = 12;

export interface DrivePoint extends Coordinate {
  /** Clockwise from north, rad. */
  headingRad: number;
  speedMps: number;
  /** At the line's end, standing. */
  arrived: boolean;
}

export class RouteDrive {
  private readonly frame: LocalFrame;
  private readonly xy: [number, number][];
  /** Along the line to each of its points, m. */
  private readonly cum: number[];
  /** The speed through each point. */
  private readonly bendMps: number[];
  private s: number;
  private v: number;
  /** The speed on the straight; a bend or the end slows it below. */
  cruiseMps = DRIVE_CRUISE_MPS;

  /**
   * `from`: where the car is (on a line before this one, say), so it carries on from the nearest point of this line;
   * absent: from the line's start. At `speedMps`, standing by default.
   */
  constructor(line: readonly Coordinate[], from?: Coordinate, speedMps = 0) {
    if (line.length === 0) throw new Error("a route with no points");
    this.frame = new LocalFrame(line[0]);
    this.xy = line.map((c) => this.frame.toEnu(c));
    this.cum = [0];
    for (let i = 1; i < this.xy.length; i++) this.cum.push(this.cum[i - 1] + dist(this.xy[i - 1], this.xy[i]));
    this.bendMps = this.cum.map((s, i) => {
      if (i === 0 || i === this.cum.length - 1) return DRIVE_CRUISE_MPS;
      const turn = Math.abs(wrap(heading(this.at(s), this.at(s + BEND_SPAN_M)) - heading(this.at(s - BEND_SPAN_M), this.at(s))));
      return BENDS.find(([rad]) => turn >= rad)?.[1] ?? DRIVE_CRUISE_MPS;
    });
    this.s = from ? this.nearest(this.frame.toEnu(from)) : 0;
    this.v = speedMps;
  }

  get lengthM(): number {
    return this.cum[this.cum.length - 1];
  }

  /** Along the line to the car, m. */
  get alongM(): number {
    return this.s;
  }

  /** Along the line to its point `i`, m. */
  alongTo(i: number): number {
    return this.cum[Math.max(0, Math.min(this.cum.length - 1, i))];
  }

  /**
   * How fast the car turns now, rad/s, left positive (the phone's `yawRate`): its heading (`TURN_CHORD_M`) changing
   * along the line at its speed. Over the line it adds up to the line's own change of heading.
   */
  yawRate(): number {
    if (this.s >= this.lengthM) return 0;
    const chord = (s: number) => heading(this.at(s - TURN_CHORD_M / 2), this.at(s + TURN_CHORD_M / 2));
    return -wrap(chord(this.s + 0.5) - chord(this.s - 0.5)) * this.v;
  }

  /** Where the car is now. */
  point(): DrivePoint {
    const [e, n] = this.at(this.s);
    const ahead = Math.min(this.s + 1, this.lengthM);
    const behind = Math.max(ahead - 2, 0);
    const arrived = this.s >= this.lengthM;
    return { ...this.frame.toCoordinate(e, n), headingRad: heading(this.at(behind), this.at(ahead)), speedMps: arrived ? 0 : this.v, arrived };
  }

  /** `dtS` seconds on. */
  step(dtS: number): DrivePoint {
    if (this.s < this.lengthM) {
      const v = Math.min(this.allowedMps(), this.v + DRIVE_ACCEL_MPS2 * dtS);
      this.s = Math.min(this.lengthM, this.s + ((this.v + v) / 2) * dtS);
      this.v = this.s >= this.lengthM ? 0 : v;
    }
    return this.point();
  }

  /** The speed that still makes every bend ahead, and the end. */
  private allowedMps(): number {
    let allowed = Math.max(DRIVE_CRAWL_MPS, Math.sqrt(2 * DRIVE_BRAKE_MPS2 * (this.lengthM - this.s)));
    for (let i = this.indexAt(this.s) + 1; i < this.cum.length - 1 && this.cum[i] - this.s <= LOOK_AHEAD_M; i++) {
      allowed = Math.min(allowed, Math.sqrt(this.bendMps[i] ** 2 + 2 * DRIVE_BRAKE_MPS2 * (this.cum[i] - this.s)));
    }
    return Math.min(this.cruiseMps, allowed);
  }

  /** The segment `s` is on (its first point). */
  private indexAt(s: number): number {
    // The last point at or before `s`, short of the line's last one; searched, as a long route steps at 50 Hz (the
    // emulated adapter's wheels).
    let lo = 0;
    let hi = Math.max(0, this.cum.length - 2);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private at(s: number): [number, number] {
    if (this.xy.length === 1) return this.xy[0];
    const c = Math.max(0, Math.min(this.lengthM, s));
    const i = this.indexAt(c);
    const len = this.cum[i + 1] - this.cum[i];
    const f = len > 0 ? (c - this.cum[i]) / len : 0;
    const [ax, ay] = this.xy[i];
    const [bx, by] = this.xy[i + 1];
    return [ax + (bx - ax) * f, ay + (by - ay) * f];
  }

  /** Along the line to its point nearest `p`, m. */
  private nearest(p: [number, number]): number {
    let best = Infinity;
    let bestS = 0;
    for (let i = 0; i + 1 < this.xy.length; i++) {
      const [ax, ay] = this.xy[i];
      const [bx, by] = this.xy[i + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2)) : 0;
      const d = Math.hypot(ax + t * dx - p[0], ay + t * dy - p[1]);
      if (d < best) {
        best = d;
        bestS = this.cum[i] + t * Math.sqrt(len2);
      }
    }
    return bestS;
  }
}

const dist = (a: [number, number], b: [number, number]) => Math.hypot(b[0] - a[0], b[1] - a[1]);
/** Clockwise from north, as `bearingRad`. */
const heading = (a: [number, number], b: [number, number]) => Math.atan2(b[0] - a[0], b[1] - a[1]);
const wrap = (rad: number) => Math.atan2(Math.sin(rad), Math.cos(rad));
