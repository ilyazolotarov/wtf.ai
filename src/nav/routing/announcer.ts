// When to say what during guidance (ROUTING-SPEC §8.5): each maneuver once ahead of it ("in 300 m, turn left")
// and once at it ("turn left"), the route being planned again, and arrival; nothing new while the driver keeps to
// their own way. Pure logic: the app turns these into speech in the driver's language.

import { haversineM } from "../geo";
import type { GuidanceStep } from "./guidance";
import type { Maneuver, ManeuverKind } from "./maneuvers";

export interface AnnouncerConfig {
  /** Ahead: at max(`prepareMinM`, `prepareS` at the current speed) before the maneuver, up to a spoken distance. */
  prepareMinM: number;
  prepareS: number;
  /**
   * At it: early enough to hear it, react and slow down for the turn (`nowDistanceM`). The car starts turning
   * `nowTurnStartM` before the maneuver point; hearing it out and reacting take `nowSayS` (the position update and
   * the clip starting, the phrase, a reaction); braking from the current speed to the maneuver's turning speed
   * (`turnSpeedMps`) at `nowBrakeMps2`. At least `nowMinM`.
   */
  nowMinM: number;
  nowTurnStartM: number;
  nowSayS: number;
  nowBrakeMps2: number;
  /** Not "ahead" when "at it" follows this soon after (the two would run into each other). */
  minGapS: number;
}

export const DEFAULT_ANNOUNCER: AnnouncerConfig = {
  prepareMinM: 250,
  prepareS: 15,
  nowMinM: 40,
  nowTurnStartM: 10,
  // 0.5 s until the position and the clip, 1.3 s the phrase ("Поверніть праворуч"), 1 s to react.
  nowSayS: 2.8,
  nowBrakeMps2: 2,
  minGapS: 6,
};

/** The speed a maneuver is driven at, m/s: what the driver slows down to after "at it". */
export function turnSpeedMps(kind: ManeuverKind): number {
  switch (kind) {
    case "slight-left":
    case "slight-right":
    case "keep-left":
    case "keep-right":
      return 50 / 3.6;
    case "roundabout":
      return 25 / 3.6;
    case "u-turn":
    case "sharp-left":
    case "sharp-right":
      return 15 / 3.6;
    default:
      return 20 / 3.6;
  }
}

/**
 * How far before a maneuver "at it" is said, m. With the old 4 s at the current speed it started on average 1.5 s
 * before the car began to turn and ended after it (39 followed turns, 2026-10-09 to 10-11): too late to slow down.
 */
export function nowDistanceM(kind: ManeuverKind, speedMps: number, c: AnnouncerConfig = DEFAULT_ANNOUNCER): number {
  const v = Math.max(0, speedMps);
  const vt = turnSpeedMps(kind);
  const brakeM = v > vt ? (v * v - vt * vt) / (2 * c.nowBrakeMps2) : 0;
  return Math.max(c.nowMinM, c.nowTurnStartM + v * c.nowSayS + brakeM);
}

export type Announcement =
  | { kind: "maneuver"; stage: "prepare" | "now"; maneuver: Maneuver; distanceM: number; then: Maneuver | null }
  | { kind: "replanned" }
  | { kind: "arrived" };

export interface AnnouncerInput {
  planId: number;
  /** Why this plan replaced the last: an alternative taken is the driver's choice, not a re-plan to announce. */
  planReason?: "new" | "off-route" | "resume" | "alternative" | "placed";
  /** The driver keeps to their own way (`RouteSnapshot.ownWay`): nothing said but arrival, until they follow the route. */
  ownWay?: boolean;
  maneuvers: Maneuver[];
  guidance: GuidanceStep;
  speedMps: number;
}

/** The distances said ahead of a maneuver, the steps drivers know from other navigators (each is a recorded phrase). */
export const SPOKEN_DISTANCES_M = [50, 100, 200, 300, 400, 500, 600, 800, 1000, 1500, 2000] as const;

/** A maneuver of another plan this close, of the same kind: the same one (alternatives share their first junctions). */
const SAME_MANEUVER_M = 20;

const sameManeuver = (a: Maneuver, b: Maneuver) =>
  a.kind === b.kind && (a.exit ?? 1) === (b.exit ?? 1) && haversineM(a, b) <= SAME_MANEUVER_M;

/**
 * The same maneuver on another plan is still the one the car approaches when the two put it this close in distance
 * from the car. A route back round the block to a turn the car missed reaches it later: said again.
 */
const SAME_AHEAD_M = 100;

/** Turning around where the route starts (`plan.startTurnaround`): it is wherever the car is when planned. */
export const isStartTurnaround = (m: Maneuver) => m.kind === "u-turn" && m.atM === 0;

/** The spoken distance nearest to `m`. */
export function spokenDistanceM(m: number): number {
  let best: number = SPOKEN_DISTANCES_M[0];
  for (const d of SPOKEN_DISTANCES_M) if (Math.abs(d - m) < Math.abs(best - m)) best = d;
  return best;
}

/** The spoken distance at or beyond `m`: "ahead" waits for it, so the distance said is the distance left. */
function spokenDistanceAtLeastM(m: number): number {
  return SPOKEN_DISTANCES_M.find((d) => d >= m) ?? SPOKEN_DISTANCES_M[SPOKEN_DISTANCES_M.length - 1];
}

export class Announcer {
  readonly config: AnnouncerConfig;
  private planId: number | null = null;
  /** Announced, as `<maneuver index>:<stage>`, for the current plan. */
  private said = new Set<string>();
  /** The current plan's maneuvers: what was said of them carries over to the next plan. */
  private maneuvers: Maneuver[] = [];
  /** The current plan's next maneuver and the car's place on it when last seen. */
  private nextIndex = 0;
  private alongM = 0;
  /** "Route replanned" said, and nothing since: a re-plan after it says nothing of its own. */
  private replannedLast = false;
  private arrived = false;

  constructor(config: Partial<AnnouncerConfig> = {}) {
    this.config = { ...DEFAULT_ANNOUNCER, ...config };
  }

  update(input: AnnouncerInput): Announcement[] {
    const out = this.announce(input);
    if (out.some((a) => a.kind !== "replanned")) this.replannedLast = false;
    return out;
  }

  private announce(input: AnnouncerInput): Announcement[] {
    const c = this.config;
    const out: Announcement[] = [];
    const { guidance: g, maneuvers } = input;
    if (input.planId !== this.planId) {
      // A new plan: the first is the route starting (its first maneuver says enough), later ones are re-plans,
      // unless the driver took an alternative (by a tap, or by driving onto it). Re-plans in a row with nothing said
      // between them say it once; none while the driver keeps to their own way.
      if (this.planId !== null && input.planReason !== "alternative" && !this.replannedLast && !input.ownWay) {
        out.push({ kind: "replanned" });
        this.replannedLast = true;
      }
      // What was said stays said where it is the same maneuver, still as far ahead: "turn right" at the junction all
      // the routes share isn't said again on switching between them, nor on a re-plan. A turnaround at the start not
      // made yet is the same one wherever the car is now: a re-plan while the car drives on away doesn't say it again.
      const carried = new Set<string>();
      for (const k of this.said) {
        const [i, stage] = k.split(":");
        const was = this.maneuvers[Number(i)];
        if (!was) continue;
        const aheadM = was.atM - this.alongM;
        const turnaround = isStartTurnaround(was) && this.nextIndex <= Number(i);
        const j = maneuvers.findIndex(
          (x) => (turnaround && isStartTurnaround(x)) || (sameManeuver(x, was) && Math.abs(x.atM - g.alongM - aheadM) <= SAME_AHEAD_M),
        );
        if (j >= 0) carried.add(`${j}:${stage}`);
      }
      this.planId = input.planId;
      this.said = carried;
    }
    this.maneuvers = maneuvers;
    this.nextIndex = g.nextIndex;
    this.alongM = g.alongM;
    if (g.state === "arrived") {
      if (!this.arrived) out.push({ kind: "arrived" });
      this.arrived = true;
      return out;
    }
    // Off the route, a re-plan is coming: nothing about this one's maneuvers. The driver's own way: none either.
    if ((g.state !== "on" && g.state !== "unsure") || input.ownWay) return out;
    const next = maneuvers[g.nextIndex];
    if (!next || next.kind === "depart" || next.kind === "arrive") return out;
    const v = Math.max(0, input.speedMps);
    const nowM = nowDistanceM(next.kind, v, c);
    const prepareM = spokenDistanceAtLeastM(Math.max(c.prepareMinM, c.prepareS * v));
    const then = g.thenIndex !== null ? (maneuvers[g.thenIndex] ?? null) : null;
    const key = (stage: string) => `${g.nextIndex}:${stage}`;
    if (g.toNextM <= nowM) {
      if (!this.said.has(key("now"))) {
        this.said.add(key("now"));
        this.said.add(key("prepare"));
        out.push({ kind: "maneuver", stage: "now", maneuver: next, distanceM: g.toNextM, then });
      }
    } else if (g.toNextM <= prepareM && !this.said.has(key("prepare"))) {
      this.said.add(key("prepare"));
      // Too close to "at it" to say both: wait for that.
      const gapS = v > 0 ? (g.toNextM - nowM) / v : Infinity;
      if (gapS >= c.minGapS) out.push({ kind: "maneuver", stage: "prepare", maneuver: next, distanceM: spokenDistanceM(g.toNextM), then: null });
    }
    return out;
  }
}
