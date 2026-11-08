// The emulated adapter's car on the map (VEHICLE-LINK-SPEC §13): from where the map's dot is, it drives along the
// active route, or without one along the road it is on, straight on at each junction (road-follow.ts), slowing for the
// bends and stopping at the end (route-drive.ts). The adapter's speed and its wheels' turning come from it; the phone's
// own fixes are withheld for the drive, as the phone stands still while the car moves.
//
// Open loop: once begun, the car keeps its own place along its line and never looks at the navigator's dot again, so
// the navigator, driving on these wheels, can't pull the car it is following. A new plan (a re-plan, another route)
// is joined from where the car is; a route ended on the way, the car drives on along the road from there; at a route's
// end it stands until the next.

import type { Coordinate } from "@/nav/geo";
import type { LocalFrame } from "@/nav/geo/local-frame";
import type { RoadGraph } from "@/nav/mapmatch/graph/road-graph";
import type { PositionEstimate } from "@/nav/position/types";
import type { RoutePlan } from "@/nav/routing/router";
import { roadLine, roadUnder, spotOnLine, type RoadLine, type RoadSpot } from "@/nav/sim/road-follow";
import { RouteDrive, type DrivePoint } from "@/nav/sim/route-drive";
import type { RouteSnapshot } from "@/services/navigation/route-service";

/** The road ahead is laid this far, m, and laid on from the car again with this little of it left. */
export const ROAD_AHEAD_M = 3000;
const ROAD_LEFT_M = 600;
/** A step after the JS thread was held up moves the car on by the time gone, up to this, s. */
const MAX_STEP_S = 5;

export interface EmulatedDriveDeps {
  routes: { getSnapshot(): RouteSnapshot | null; subscribe(listener: () => void): () => void };
  /** The map's dot now. */
  position(): PositionEstimate | null;
  /** The road graph around a point, in its frame (null: no map there); `close` lets the reader go. */
  roads: { near(at: Coordinate): { graph: RoadGraph; frame: LocalFrame } | null; close(): void };
  /** The phone's fixes withheld, `truth` where the car is now; null: the phone's fixes again. */
  ignoreGps(truth: (() => Coordinate) | null): void;
  note(text: string): void;
}

/** The car now: km/h, and its turning, rad/s, left positive (the phone's `yawRate`). */
export interface EmulatedCar {
  speedKph: number;
  yawRad: number;
}

const activePlan = (route: RouteSnapshot | null): RoutePlan | null => (route?.status === "active" && route.plan) || null;

export class EmulatedDrive {
  private drive: RouteDrive | null = null;
  private here: DrivePoint | null = null;
  /** The route being driven (by identity: a re-plan or another alternative is a new one). */
  private plan: RoutePlan | null = null;
  /** Without a route: the road being driven and the graph it was laid on. */
  private road: { line: RoadLine; graph: RoadGraph } | null = null;
  private lastMs = 0;
  private unsubscribe: (() => void) | null = null;
  private endNoted = false;

  constructor(private readonly deps: EmulatedDriveDeps) {}

  /** Driving the roads (`begin` found a dot and a road). */
  get begun(): boolean {
    return this.unsubscribe !== null;
  }

  /** Where the car is; null before it began. */
  where(): DrivePoint | null {
    return this.here;
  }

  /**
   * From the map's dot (the car's own, not the phone's while the car's is still to come), along the route, else the
   * road under it. False: no dot yet, or no road there; standing, it may be asked again.
   */
  begin(nowMs: number): boolean {
    if (this.begun) return true;
    const dot = this.deps.position();
    if (!dot || dot.waitingForCar || dot.testDrive) return false;
    const plan = activePlan(this.deps.routes.getSnapshot());
    if (plan) {
      this.drive = new RouteDrive(plan.coordinates, dot);
      this.deps.note(`emulated drive: along ${Math.round(this.drive.lengthM)} m of route from the dot`);
    } else {
      const road = this.layRoad(dot, dot.headingRad);
      if (!road) return false;
      this.road = road;
      this.drive = new RouteDrive(road.line.points);
      this.deps.note(`emulated drive: along the road from the dot, ${roadNote(road.line)}`);
    }
    this.plan = plan;
    this.here = this.drive.point();
    this.lastMs = nowMs;
    this.unsubscribe = this.deps.routes.subscribe(this.onRoute);
    this.deps.ignoreGps(() => this.here!);
    return true;
  }

  stop(): void {
    const begun = this.begun;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.drive = null;
    this.road = null;
    this.plan = null;
    this.deps.roads.close();
    if (begun) this.deps.ignoreGps(null);
  }

  /** The car `nowMs` (moved on by the time since the last call), cruising at `cruiseKph` where the road lets it. */
  at(nowMs: number, cruiseKph: number): EmulatedCar {
    const drive = this.drive;
    if (!drive) return { speedKph: 0, yawRad: 0 };
    const dtS = Math.min(MAX_STEP_S, Math.max(0, (nowMs - this.lastMs) / 1000));
    this.lastMs = nowMs;
    drive.cruiseMps = cruiseKph / 3.6;
    if (dtS > 0) {
      this.here = drive.step(dtS);
      this.layRoadOn();
    }
    const here = this.here!;
    if (here.arrived && !this.endNoted) {
      this.endNoted = true;
      this.deps.note(`emulated drive: at the ${this.plan ? "route" : "road"}'s end, standing`);
    }
    return { speedKph: here.speedMps * 3.6, yawRad: this.drive!.yawRate() };
  }

  private readonly onRoute = () => {
    const plan = activePlan(this.deps.routes.getSnapshot());
    if (plan === this.plan || !this.here) return;
    const here = this.here;
    const arrived = this.plan !== null && here.arrived;
    this.plan = plan;
    this.endNoted = false;
    if (plan) {
      this.road = null;
      this.drive = new RouteDrive(plan.coordinates, here, here.speedMps);
      this.deps.note(`emulated drive: along ${Math.round(this.drive.lengthM)} m of route from where the car is`);
    } else if (arrived) {
      // At the route's end: the car stands there until the next route.
      this.endNoted = true;
    } else {
      // The route ended on the way: the car drives on along the road.
      const road = this.layRoad(here, here.headingRad);
      this.road = road;
      this.drive = road ? new RouteDrive(road.line.points, undefined, here.speedMps) : new RouteDrive([here]);
      this.deps.note(road ? `emulated drive: route ended, along the road on, ${roadNote(road.line)}` : "emulated drive: route ended, no road at the car, standing");
    }
    this.here = this.drive!.point();
  };

  /** Without a route, the road laid on from where the car is before it runs out. */
  private layRoadOn(): void {
    const road = this.road;
    const drive = this.drive!;
    if (!road || road.line.ends || drive.lengthM - drive.alongM > ROAD_LEFT_M) return;
    const here = this.here!;
    const roads = this.deps.roads.near(here);
    // The map gone: the car drives to the end of the road it has and stops there.
    if (!roads) return;
    let line: RoadLine;
    if (roads.graph === road.graph) {
      const spot: RoadSpot = spotOnLine(road.graph, road.line, drive.alongM, (i) => drive.alongTo(i));
      line = roadLine(road.graph, spot, ROAD_AHEAD_M);
    } else {
      // Another map (an update): the car's road found again on it.
      const spot = roadUnder(roads.graph, roads.frame, here, here.headingRad);
      if (!spot) return;
      line = roadLine(roads.graph, spot, ROAD_AHEAD_M);
    }
    this.road = { line, graph: roads.graph };
    this.drive = new RouteDrive(line.points, undefined, here.speedMps);
    this.here = this.drive.point();
  }

  private layRoad(at: Coordinate, headingRad: number | undefined): { line: RoadLine; graph: RoadGraph } | null {
    const roads = this.deps.roads.near(at);
    const spot = roads && roadUnder(roads.graph, roads.frame, at, headingRad);
    if (!roads || !spot) return null;
    const line = roadLine(roads.graph, spot, ROAD_AHEAD_M);
    return line.points.length >= 2 ? { line, graph: roads.graph } : null;
  }
}

const roadNote = (line: RoadLine) => `${line.stretches.length} edges${line.ends ? " to its end" : ""}`;
