// When to say what during guidance (ROUTING-SPEC §8.6): each maneuver once ahead of it ("in 300 m, turn left")
// and once at it ("turn left"), the route being planned again, and arrival. Pure logic: the app turns these into
// speech in the driver's language.

import type { GuidanceStep } from "./guidance";
import type { Maneuver } from "./maneuvers";

export interface AnnouncerConfig {
  /** Ahead: at max(`prepareMinM`, `prepareS` at the current speed) before the maneuver, rounded. */
  prepareMinM: number;
  prepareS: number;
  /** At it: max(`nowMinM`, `nowS` at the current speed) before it. */
  nowMinM: number;
  nowS: number;
  /** Not "ahead" when "at it" follows this soon after (the two would run into each other). */
  minGapS: number;
}

export const DEFAULT_ANNOUNCER: AnnouncerConfig = {
  prepareMinM: 250,
  prepareS: 15,
  nowMinM: 40,
  nowS: 4,
  minGapS: 6,
};

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

/** Spoken distances: 50 m steps (10 m under 100 m). */
export function spokenDistanceM(m: number): number {
  return m < 100 ? Math.max(10, Math.round(m / 10) * 10) : Math.round(m / 50) * 50;
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
    const nowM = Math.max(c.nowMinM, c.nowS * v);
    const prepareM = Math.max(c.prepareMinM, c.prepareS * v);
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
