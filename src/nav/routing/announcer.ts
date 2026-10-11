// When to say what during guidance (ROUTING-SPEC §8.5): each maneuver once ahead of it ("in 300 m, turn left")
// and once at it ("turn left"), the route being planned again, and arrival. Pure logic: the app turns these into
// speech in the driver's language.

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
  maneuvers: Maneuver[];
  guidance: GuidanceStep;
  speedMps: number;
}

/** The distances said ahead of a maneuver, the steps drivers know from other navigators (each is a recorded phrase). */
export const SPOKEN_DISTANCES_M = [50, 100, 200, 300, 400, 500, 600, 800, 1000, 1500, 2000] as const;

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
  private arrived = false;

  constructor(config: Partial<AnnouncerConfig> = {}) {
    this.config = { ...DEFAULT_ANNOUNCER, ...config };
  }

  update(input: AnnouncerInput): Announcement[] {
    const c = this.config;
    const out: Announcement[] = [];
    const { guidance: g, maneuvers } = input;
    if (input.planId !== this.planId) {
      // A new plan: the first is the route starting (its first maneuver says enough), later ones are re-plans.
      if (this.planId !== null) out.push({ kind: "replanned" });
      this.planId = input.planId;
      this.said.clear();
    }
    if (g.state === "arrived") {
      if (!this.arrived) out.push({ kind: "arrived" });
      this.arrived = true;
      return out;
    }
    // Off the route, a re-plan is coming: nothing about this one's maneuvers.
    if (g.state !== "on" && g.state !== "unsure") return out;
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
