// The speed camera ahead for each published position (UI-SPEC §6.5): the cameras on the road ahead of where map
// matching (or a trusted fix) puts the car, on the road reader shared with the speed limit.

import type { EdgeId } from "@/nav/mapmatch/graph/road-graph";
import type { PositionEstimate } from "@/nav/position/types";
import { CameraAlert, LOOK_AHEAD_M, type CameraAhead, type CameraInSight } from "@/nav/speed/camera-alert";
import type { CameraIndex } from "@/nav/speed/cameras";
import { camerasAhead, camerasOnRoads, routeNext, startsFrom, type CameraOnRoad, type RouteNext } from "@/nav/speed/road-ahead";
import { edgeLimit, snapCandidates, snapRadiusM } from "@/nav/speed/speed-limit";
import { snapsToRoads, type LimitGraph, type OpenRoads, type RoadReader, type RoadWeights } from "@/services/navigation/road-reader";
import { edgeOf } from "@/services/navigation/speed-limit-source";

export interface CameraSourceDeps {
  reader: RoadReader;
  /** The installed maps' cameras, asked at each position (null: none); a new `key` when they change. */
  cameras(): { key: string; index: CameraIndex } | null;
  note(text: string): void;
}

/** Cameras around the car this far are put on their roads: the road ahead's length, and a little more. */
const CAMERAS_NEAR_M = LOOK_AHEAD_M + 100;

export class CameraSource {
  private readonly alert = new CameraAlert();
  /** Each camera's roads (by id), on the graph and cameras files of `roadsKey`. */
  private readonly onRoads = new Map<number, CameraOnRoad[]>();
  private roadsKey: string | null = null;
  /** The active route's legs as the road ahead follows them, on the graph file `key`. */
  private route: { key: string; next: RouteNext } | null = null;
  private shownId: number | null = null;

  constructor(private readonly deps: CameraSourceDeps) {}

  /** The active route (null: none), planned on the graph file `key`: the road ahead goes its way at junctions. */
  setRoute(route: { key: string; legs: readonly { edge: EdgeId; dir: 1 | -1 }[] } | null): void {
    this.route = route ? { key: route.key, next: routeNext(route.legs) } : null;
  }

  /** The camera to warn of at `p`; null: none ahead within 30 s (or no cameras, no map, no road the car is sure of). */
  at(p: PositionEstimate, nowMs: number, roads?: RoadWeights): CameraAhead | null {
    const { sightings, looked } = this.inSight(p, roads);
    const ahead = this.alert.update(sightings, p.speedMps, nowMs, looked);
    const ended = this.alert.ended;
    if (ended && ended.id === this.shownId) {
      this.deps.note(ended.passed ? `camera passed #${ended.id}` : `camera out of sight #${ended.id} at ${ended.distanceM} m`);
    }
    if (ahead && ahead.id !== this.shownId) {
      const limit = ahead.limitKph ? `limit ${ahead.limitKph}` : "no limit";
      this.deps.note(`camera ahead #${ahead.id} in ${Math.round(ahead.distanceM)} m, ${limit}${ahead.listed ? "" : " (OSM only)"}`);
    }
    this.shownId = ahead?.id ?? null;
    return ahead;
  }

  reset(): void {
    this.alert.reset();
    this.onRoads.clear();
    this.roadsKey = null;
    this.shownId = null;
  }

  /**
   * The cameras on the road ahead; `looked` false when there was no road position to look from (a fix too slow for a
   * course, one the car can't be placed on a road by): none seen then says nothing about the camera on the card.
   */
  private inSight(p: PositionEstimate, roads?: RoadWeights): { sightings: CameraInSight[]; looked: boolean } {
    const none = { sightings: [], looked: true };
    const cameras = this.deps.cameras();
    const reader = cameras ? this.deps.reader.near(p) : null;
    if (!cameras || !reader) return none;
    const key = `${reader.key}|${cameras.key}`;
    if (key !== this.roadsKey) {
      this.onRoads.clear();
      this.roadsKey = key;
    }
    const near = cameras.index.near(p, CAMERAS_NEAR_M);
    if (!near.length) return none;
    const starts = startsFrom(roads && roads.key === reader.key ? roads.weights : this.snapped(reader, p));
    if (!starts.length) return { sightings: [], looked: false };
    const byEdge = new Map<EdgeId, CameraOnRoad[]>();
    for (const camera of near) {
      let mine = this.onRoads.get(camera.id);
      if (!mine) {
        mine = camerasOnRoads(reader.graph, reader.frame, [camera]);
        this.onRoads.set(camera.id, mine);
      }
      for (const r of mine) {
        const list = byEdge.get(r.edge);
        if (list) list.push(r);
        else byEdge.set(r.edge, [r]);
      }
    }
    const route = this.route?.key === reader.key ? this.route.next : undefined;
    const sightings = camerasAhead(reader.graph, starts, byEdge, LOOK_AHEAD_M, route).map((s) => {
      const limitKph = s.camera.limitKph ?? roadLimit(reader, s.edge);
      return { camera: s.camera, distanceM: s.distanceM, share: s.share, ...(limitKph ? { limitKph } : {}) };
    });
    return { sightings, looked: true };
  }

  /** Without map matching: the roads around a fix the car is sure of, the way it goes along them. */
  private snapped(reader: OpenRoads, p: PositionEstimate) {
    if (!snapsToRoads(p)) return [];
    const [e, n] = reader.frame.toEnu(p);
    return snapCandidates(reader.graph.edgesNear(e, n, snapRadiusM(p.accuracyM)), p.accuracyM, p.headingRad, p.speedMps).map((c) => ({
      edge: c.edge?.id ?? null,
      weight: c.weight,
      ...(c.dir ? { dir: c.dir, alongM: c.alongM } : {}),
    }));
  }
}

function roadLimit(reader: LimitGraph, id: EdgeId): number | undefined {
  const edge = edgeOf(reader, id);
  return (edge && edgeLimit(edge)?.kph) || undefined;
}
