// What pulling in at a place costs (STOPS-SPEC §6.3): from the route a little before the place to it, plus from it
// back to the route a little after, minus the route's own time between the two. Two small searches per place, not a
// plan of the whole trip: a list of ten places is ready in a few hundred milliseconds.

import type { Coordinate } from "../geo";
import type { LocalFrame } from "../geo/local-frame";
import type { GraphStats, RoadGraph } from "../mapmatch/graph/road-graph";
import type { RouteLine } from "./along";
import { RouteSearch, type RouteOptions, type RoutePlan } from "./router";
import { elapsedS } from "./trip";

/** The searches leave the route this far before the place and come back to it this far after. */
export const DETOUR_AROUND_M = 1000;
/** Each search settles at most this many states; a place it can't reach in that is left out. */
export const DETOUR_MAX_STATES = 20_000;
/** A detour under this is no detour: "on the way". */
export const ON_THE_WAY_S = 30;
/** Leaving the route the car drives at (any speed over a crawl: turning around costs what it does while driving). */
const LEAVE_SPEED_MPS = 10;

export interface DetourJob {
  key: string;
  point: Coordinate;
  /** Where it is along the route (its projection), plan metres. */
  alongM: number;
}

/** A job's detour, s; null: unreachable within the searches' limit. */
export type DetourResult = { key: string; detourS: number | null };

/**
 * The jobs' detours one after another, advanced in slices by `run` like a route search. `fromM`: the car's progress
 * (the searches never leave the route behind it). Each detour is reported once, in job order.
 */
export class DetourSearch {
  private job = 0;
  private stage: 0 | 1 = 0;
  private search: RouteSearch | null = null;
  private toPlaceS = 0;
  private readonly results: DetourResult[] = [];

  constructor(
    private readonly graph: RoadGraph & { stats?: GraphStats },
    private readonly frame: LocalFrame,
    private readonly line: RouteLine,
    private readonly fromM: number,
    private readonly jobs: DetourJob[],
    private readonly options: RouteOptions & { aroundM?: number } = {},
  ) {}

  /** Up to `maxStates` more states; the detours finished since the last call. */
  run(maxStates = Infinity): { done: boolean; results: DetourResult[] } {
    let budget = maxStates;
    while (this.job < this.jobs.length && budget > 0) {
      const job = this.jobs[this.job];
      const plan = this.line.plan;
      const around = this.options.aroundM ?? DETOUR_AROUND_M;
      const inM = Math.max(this.fromM, job.alongM - around);
      const outM = Math.min(nextEndM(plan, job.alongM), job.alongM + around);
      if (!this.search) {
        const opts: RouteOptions = { maxStates: DETOUR_MAX_STATES, ...this.options };
        if (this.stage === 0) {
          const at = this.line.at(inM);
          this.search = new RouteSearch(this.graph, this.frame, { ...at.point, headingRad: at.headingRad, speedMps: LEAVE_SPEED_MPS, accuracyM: 5 }, job.point, opts);
        } else {
          this.search = new RouteSearch(this.graph, this.frame, { ...job.point, speedMps: 0 }, this.line.at(outM).point, opts);
        }
      }
      const before = this.search.run(0).stats.states;
      const r = this.search.run(budget);
      budget -= r.stats.states - before;
      if (r.status === "more") break;
      this.search = null;
      if (r.status === "failed") {
        this.finish(job, null);
        continue;
      }
      if (this.stage === 0) {
        this.toPlaceS = r.plan.durationS;
        this.stage = 1;
        continue;
      }
      const routeS = elapsedS(plan, outM) - elapsedS(plan, inM);
      this.finish(job, Math.max(0, this.toPlaceS + r.plan.durationS - routeS));
    }
    const results = this.results.splice(0);
    return { done: this.job >= this.jobs.length, results };
  }

  private finish(job: DetourJob, detourS: number | null): void {
    this.results.push({ key: job.key, detourS });
    this.job++;
    this.stage = 0;
    this.toPlaceS = 0;
  }
}

/** The end of the leg `alongM` is on: the next stop, or the route's end. */
function nextEndM(plan: RoutePlan, alongM: number): number {
  for (const s of plan.stops ?? []) if (s.atM > alongM) return s.atM;
  return plan.lengthM;
}

/** "+n min" from a detour: rounded up, "on the way" under `ON_THE_WAY_S`. */
export function detourMinutes(detourS: number): number {
  return detourS < ON_THE_WAY_S ? 0 : Math.max(1, Math.ceil(detourS / 60));
}
