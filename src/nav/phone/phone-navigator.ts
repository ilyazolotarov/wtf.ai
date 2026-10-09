// Navigation without an OBD adapter (SPEC §3.10, NAVIGATOR-SPEC §9.6): the phone's own speed (imu-speed.ts) on the
// turn-anchored map matching (turn-tracker.ts), in a frame of its own on its own reader of the road graph. It starts
// from a pose (the driver's placing, the parked pose, a satellite fix with a course); trusted satellite fixes
// re-anchor it, coarse ones weigh its hypotheses. Experimental: on Slavutych's jammed drives it is on the wrong road
// about a quarter of the time, so the driver's placing is part of using it.
//
// With a route (the driver said they will follow it, UI-SPEC §6.3) the car is taken to be on it: the route follower
// (route-follower.ts) places it along the route by the turns it makes, and the tracker keeps running beside it,
// re-anchored to it, for when the driver leaves the route. Turns alone don't tell that (the follower explains an
// off-route turn by another of the route's): a placing or a trusted fix off the route does, and the tracker coming
// back onto it rejoins.

import type { Coordinate } from "../geo";
import { LocalFrame } from "../geo/local-frame";
import type { RoadGraph } from "../mapmatch/graph/road-graph";
import { RouteFollower, type RouteFollowerConfig } from "../mapmatch/route-follower";
import { TurnTracker, type TurnTrackerConfig } from "../mapmatch/turn-tracker";
import { ImuSpeedEstimator, type ImuSpeedConfig, type PhoneMount } from "../odometry/imu/imu-speed";
import { isSatelliteFix, type GnssFix, type ImuSample } from "../types";

/** A road graph the navigator can move into its own frame. */
export type PhoneGraph = RoadGraph & { setFrame(frame: LocalFrame): void };

export interface PhonePose {
  lat: number;
  lon: number;
  /** Clockwise from north. */
  headingRad: number;
  posSigmaM: number;
  headingSigmaRad: number;
}

export interface PhoneNavigatorConfig {
  /** The speed estimator; the city prior is on (SPEC §3.10). */
  speed: Partial<ImuSpeedConfig>;
  tracker: Partial<TurnTrackerConfig>;
  /** The tracker steps this often, s. */
  stepS: number;
  /** Vertical vibration above this: the car moves (with the speed unknown). */
  movingVibMS2: number;
  /** A trusted satellite fix this accurate re-anchors the tracker, at most this often; with a course from this speed. */
  anchorAccM: number;
  anchorEveryS: number;
  anchorCourseMinMps: number;
  /** The circle: the best hypothesis' along-road σ and the spread of the others, capped. */
  maxAccuracyM: number;
  /** Other hypotheses drawn: this far from the shown one and each other, with at least this share. */
  alternativeApartM: number;
  alternativeMinShare: number;
  follower: Partial<RouteFollowerConfig>;
  /** A start, placing or anchor this close to the route (m) puts the car on it; farther, it has left it. */
  routeJoinM: number;
  /** A new route joins from the shown position within this, m (it is planned from there). */
  routeNewJoinM: number;
  /**
   * A new route that starts on the one followed (within this, m), ahead of the car or up to `routeSpliceBackM` behind
   * it, is the rest of it: the car keeps to the old route up to there (a re-plan made from where the car really was,
   * ahead of a dot that lags).
   */
  routeSpliceM: number;
  routeSpliceBackM: number;
  /** Off the route, the tracker this close to it and heading along it (within the angle) this long rejoins it. */
  routeRejoinS: number;
  routeRejoinHeadingRad: number;
  /** While following, the tracker is moved to the follower's position after a turn that fits this well. */
  routeAnchorFit: number;
}

export const DEFAULT_PHONE_NAVIGATOR_CONFIG: PhoneNavigatorConfig = {
  speed: { priorSigmaMps: 5, priorSpeedMps: 12 },
  tracker: {},
  stepS: 0.1,
  movingVibMS2: 0.4,
  anchorAccM: 20,
  anchorEveryS: 2,
  anchorCourseMinMps: 3,
  maxAccuracyM: 1000,
  alternativeApartM: 60,
  alternativeMinShare: 0.05,
  follower: {},
  routeJoinM: 30,
  routeNewJoinM: 100,
  routeSpliceM: 300,
  routeSpliceBackM: 300,
  routeRejoinS: 5,
  routeRejoinHeadingRad: (45 * Math.PI) / 180,
  routeAnchorFit: 0.6,
};

/** On a route: following it, off it (the tracker alone), or none set. */
export type PhoneRouteState = "following" | "off" | "none";

export interface PhoneEstimate {
  tUs: number;
  lat: number;
  lon: number;
  headingRad: number;
  accuracyM: number;
  /** The phone's speed times the shown hypothesis' scale (absent while unknown). */
  speedMps?: number;
  stopped: boolean;
  /** Other roads the car may be on, heaviest first. */
  alternatives: { lat: number; lon: number; weight: number }[];
}

export class PhoneNavigator {
  readonly config: PhoneNavigatorConfig;
  private readonly speed: ImuSpeedEstimator;
  private frame: LocalFrame | null = null;
  private tracker: TurnTracker | null = null;
  private step = { dt: 0, yaw: 0, valid: true, stopped: false, speed: NaN, vib: 0 };
  private lastUs: number | null = null;
  private nowUs = 0;
  private lastSpeedMps = NaN;
  private stopped = false;
  private lastAnchorUs = -Infinity;
  /** Distance driven (phone, unscaled) since the last start or placing, m. */
  private sinceStartM = 0;
  /** Time standing still, s. */
  private stillS = 0;
  /** The route the driver follows (null: none), and its points in the current frame. */
  private route: { points: Coordinate[]; enu: [number, number][]; frame: LocalFrame | null } | null = null;
  /** Non-null while the car is taken to be on the route. */
  private follower: RouteFollower | null = null;
  private onRouteS = 0;
  /** What happened on the route since the last `takeNotes`, for the trip log. */
  private notes: string[] = [];

  constructor(
    private readonly graph: PhoneGraph,
    config: Partial<PhoneNavigatorConfig> = {},
    mount: PhoneMount | null = null,
  ) {
    this.config = { ...DEFAULT_PHONE_NAVIGATOR_CONFIG, ...config };
    this.speed = new ImuSpeedEstimator(this.config.speed, {}, mount);
  }

  get started(): boolean {
    return this.tracker !== null;
  }

  /** How the phone sits in the car, to store for the next drive (null until known). */
  get mount(): PhoneMount | null {
    return this.speed.mount;
  }

  /** Distance the phone measured since the last start or placing, m. */
  get distanceSinceStartM(): number {
    return this.sinceStartM;
  }

  /** How long the car has stood, s. */
  get stillForS(): number {
    return this.stillS;
  }

  /** What happened on the route since the last call (the turns it jumped to), for the trip log. */
  takeNotes(): string[] {
    const out = this.notes;
    this.notes = [];
    return out;
  }

  get routeState(): PhoneRouteState {
    return !this.route ? "none" : this.follower ? "following" : "off";
  }

  /** The route the driver follows (the active plan's polyline), or none. */
  setRoute(points: Coordinate[] | null): void {
    const was = this.follower ? { follower: this.follower, est: this.follower.estimate(), enu: this.routeEnu()! } : null;
    this.follower = null;
    this.onRouteS = 0;
    this.route = points && points.length >= 2 ? { points, enu: [], frame: null } : null;
    if (was && this.route && this.spliceRoute(was.follower, was.est, was.enu)) return;
    // From where the dot was: the follower's place when it followed the old route.
    const now = was ? { e: was.est.e, n: was.est.n, heading: was.est.headingRad, sigma: was.est.sigmaM } : this.trackerPosition();
    if (now) this.joinRoute(now.e, now.n, now.heading, this.config.routeNewJoinM, now.sigma);
  }

  /**
   * Following, a new route that starts on the old one where the car may yet get to: the old route from a little behind
   * the car to there, then the new one, the follower carrying on along it with what it knew of the gyro and the speed.
   */
  private spliceRoute(follower: RouteFollower, was: ReturnType<RouteFollower["estimate"]>, oldEnu: [number, number][]): boolean {
    const c = this.config;
    const frame = this.frame;
    const next = this.routeEnu();
    if (!frame || !next) return false;
    const at = nearestOnLine(oldEnu, next[0][0], next[0][1], c.routeSpliceM);
    if (!at || at.alongM < was.alongM - c.routeSpliceBackM) return false;
    const fromM = Math.max(0, Math.min(was.alongM, at.alongM) - c.routeSpliceBackM);
    const joined = [...sliceLine(oldEnu, fromM, at.alongM), ...next];
    // Behind the new start: where it was on the old route. Past it: on the new route if it is there, else at its
    // start (the re-plan says the car is there).
    const target =
      was.alongM <= at.alongM
        ? was.alongM - fromM
        : (nearestOnLine(joined, was.e, was.n, c.routeJoinM)?.alongM ?? at.alongM - fromM);
    const carried = follower.carryOn(joined, target);
    this.route = { points: joined.map(([e, n]) => frame.toCoordinate(e, n)), enu: joined, frame };
    this.follower = carried;
    return true;
  }

  start(pose: PhonePose): void {
    this.frame = new LocalFrame(pose);
    this.graph.setFrame(this.frame);
    this.tracker = new TurnTracker(this.graph, this.config.tracker);
    const [e, n] = this.frame.toEnu(pose);
    this.tracker.start(e, n, pose.headingRad, pose.posSigmaM, pose.headingSigmaRad);
    this.sinceStartM = 0;
    this.joinRoute(e, n, pose.headingRad, this.config.routeJoinM + pose.posSigmaM, pose.posSigmaM);
  }

  /** The driver (or a trusted fix) put the car here: start again, keeping what the tracker learned of the speed. */
  place(pose: PhonePose): void {
    const frame = this.frame;
    // Far from the frame's origin its flat picture bends: a new frame, a fresh start.
    if (!this.tracker || !frame || Math.hypot(...frame.toEnu(pose)) > 20_000) {
      this.start(pose);
      return;
    }
    const [e, n] = frame.toEnu(pose);
    this.tracker.restart(e, n, pose.headingRad, pose.posSigmaM, pose.headingSigmaRad);
    this.sinceStartM = 0;
    // On the route if it is there; placed (or fixed) off it, the driver has left it.
    this.joinRoute(e, n, pose.headingRad, this.config.routeJoinM + pose.posSigmaM, pose.posSigmaM);
  }

  onImu(s: ImuSample): void {
    const o = this.speed.process(s);
    const dt = this.lastUs === null ? 0 : Math.min(0.1, Math.max(0, (s.tUs - this.lastUs) / 1e6));
    this.lastUs = s.tUs;
    this.nowUs = s.tUs;
    const st = this.step;
    st.dt += dt;
    st.yaw += o.yawRate * dt;
    st.valid &&= o.valid;
    st.stopped = o.stopped;
    st.speed = o.speedMps;
    st.vib = o.vibrationMS2;
    if (st.dt < this.config.stepS) return;
    this.stopped = st.stopped;
    this.lastSpeedMps = st.speed;
    this.stillS = st.stopped ? this.stillS + st.dt : 0;
    if (Number.isFinite(st.speed) && !st.stopped) this.sinceStartM += Math.max(0, st.speed) * st.dt;
    const step = { tUs: s.tUs, dtS: st.dt, speedMps: st.speed, yawRate: st.yaw / st.dt, valid: st.valid, stopped: st.stopped, moving: st.vib >= this.config.movingVibMS2 };
    const wasStill = this.stillS - st.dt > 0;
    this.tracker?.step(step);
    this.step = { dt: 0, yaw: 0, valid: true, stopped: false, speed: NaN, vib: 0 };
    if (this.follower) this.followStep(step, wasStill);
    else this.watchRejoin(step.dtS);
  }

  /** Following: the follower steps; the tracker is put where it has the car at stops and after turns that fit. */
  private followStep(step: Parameters<RouteFollower["step"]>[0], wasStill: boolean): void {
    const f = this.follower!;
    f.step(step);
    const turns = f.takeTurns();
    for (const t of turns) {
      if (t.jumpedM !== undefined) {
        const d = t.jumpedM - t.before.alongM;
        this.notes.push(`a ${Math.round((Math.abs(t.turnedRad) * 180) / Math.PI)}° turn fitted nowhere near: to the route's nearest like it, ${Math.round(Math.abs(d))} m ${d >= 0 ? "ahead" : "back"}`);
      }
    }
    const goodTurn = turns.some((t) => t.fit >= this.config.routeAnchorFit || t.jumpedM !== undefined);
    const stoppedNow = step.stopped && !wasStill;
    if (!goodTurn && !stoppedNow) return;
    const est = f.estimate();
    this.tracker?.restart(est.e, est.n, est.headingRad, Math.max(15, Math.min(est.sigmaM, 200)), (20 * Math.PI) / 180);
  }

  /** Off the route: the tracker back on it, heading along it, for a while, rejoins it. */
  private watchRejoin(dtS: number): void {
    const now = this.route ? this.trackerPosition() : null;
    const at = now ? this.onRoute(now.e, now.n, this.config.routeJoinM) : null;
    const along = at && Math.abs(wrapAngle(at.headingRad - now!.heading)) <= this.config.routeRejoinHeadingRad;
    this.onRouteS = along ? this.onRouteS + dtS : 0;
    if (along && this.onRouteS >= this.config.routeRejoinS) this.joinRoute(now!.e, now!.n, now!.heading, this.config.routeJoinM, now!.sigma);
  }

  private trackerPosition(): { e: number; n: number; heading: number; sigma: number } | null {
    const est = this.tracker?.estimate();
    return est ? { e: est.e, n: est.n, heading: est.headingRad, sigma: est.sigmaM } : null;
  }

  /** The route in the current frame (rebuilt when the frame changes). */
  private routeEnu(): [number, number][] | null {
    const r = this.route;
    const frame = this.frame;
    if (!r || !frame) return null;
    if (r.frame !== frame) {
      r.enu = r.points.map((q) => frame.toEnu(q));
      r.frame = frame;
    }
    return r.enu;
  }

  /** The nearest point of the route within `maxM` of (e, n): how far along it, and its heading there. */
  private onRoute(e: number, n: number, maxM: number): { alongM: number; headingRad: number } | null {
    const pts = this.routeEnu();
    return pts ? nearestOnLine(pts, e, n, maxM) : null;
  }

  /** On the route if (e, n) is within `maxM` of it, heading along it; else off it. */
  private joinRoute(e: number, n: number, headingRad: number | null, maxM: number, sigmaM: number): void {
    this.follower = null;
    this.onRouteS = 0;
    const pts = this.routeEnu();
    const at = pts ? this.onRoute(e, n, maxM) : null;
    if (!pts || !at) return;
    if (headingRad !== null && Math.abs(wrapAngle(at.headingRad - headingRad)) > Math.PI / 2) return;
    this.follower = new RouteFollower(pts, this.config.follower, at.alongM, Math.max(15, sigmaM));
  }

  /**
   * A fix: `trusted` when integrity passed it and GNSS is trusted. A trusted satellite fix re-anchors (or starts) the
   * tracker; a Wi-Fi/cell fix weighs its hypotheses; an untrusted satellite fix is ignored.
   */
  onFix(fix: GnssFix, trusted: boolean): void {
    const c = this.config;
    if (isSatelliteFix(fix)) {
      if (!trusted || fix.hAccM > c.anchorAccM || fix.tUs - this.lastAnchorUs < c.anchorEveryS * 1e6) return;
      const course = fix.speedMps !== undefined && fix.speedMps >= c.anchorCourseMinMps && fix.courseRad !== undefined;
      const now = this.estimate();
      // Without a course (slow, standing) the heading is the tracker's; before a start there is none.
      if (!course && !now) return;
      this.lastAnchorUs = fix.tUs;
      this.place({
        lat: fix.lat,
        lon: fix.lon,
        headingRad: course ? fix.courseRad! : now!.headingRad,
        posSigmaM: Math.max(5, fix.hAccM),
        headingSigmaRad: course ? Math.max(5 * (Math.PI / 180), fix.courseAccRad ?? 0) : 30 * (Math.PI / 180),
      });
      return;
    }
    if (!this.tracker || !this.frame) return;
    const [e, n] = this.frame.toEnu(fix);
    this.tracker.fix(fix.tUs, e, n, fix.hAccM);
    const f = this.follower;
    if (!f) return;
    f.fix(fix.tUs, e, n, fix.hAccM);
    for (const j of f.takeFixJumps()) {
      const d = j.toM - j.fromM;
      this.notes.push(`a ±${Math.round(j.accM)} m fix put the car ${Math.round(Math.abs(d))} m ${d >= 0 ? "ahead" : "back"} along it`);
      const est = f.estimate();
      this.tracker.restart(est.e, est.n, est.headingRad, Math.max(15, Math.min(est.sigmaM, 200)), (20 * Math.PI) / 180);
    }
  }

  estimate(): PhoneEstimate | null {
    const tracker = this.tracker;
    const frame = this.frame;
    const est = tracker?.estimate();
    if (!tracker || !frame || !est) return null;
    const c = this.config;
    if (this.follower) {
      // On the route: where the follower has the car, the circle its spread along it.
      const f = this.follower.estimate();
      const v = Number.isFinite(this.lastSpeedMps) ? Math.max(0, this.lastSpeedMps) * f.scale : undefined;
      return {
        tUs: this.nowUs,
        ...frame.toCoordinate(f.e, f.n),
        headingRad: f.headingRad,
        accuracyM: Math.min(c.maxAccuracyM, Math.max(10, f.sigmaM)),
        ...(v !== undefined ? { speedMps: v } : {}),
        stopped: this.stopped,
        alternatives: [],
      };
    }
    const hyps = tracker.hypotheses();
    let total = 0;
    let spread = 0;
    for (const h of hyps) {
      const w = Math.exp(h.logW);
      total += w;
      spread += w * ((h.e - est.e) ** 2 + (h.n - est.n) ** 2);
    }
    const accuracyM = Math.min(c.maxAccuracyM, Math.max(10, Math.hypot(est.sigmaM, total > 0 ? Math.sqrt(spread / total) : 0)));
    const alternatives: PhoneEstimate["alternatives"] = [];
    const taken = [{ e: est.e, n: est.n }];
    for (const h of [...hyps].sort((a, b) => b.logW - a.logW)) {
      const w = total > 0 ? Math.exp(h.logW) / total : 0;
      if (w < c.alternativeMinShare || alternatives.length >= 3) break;
      if (taken.some((t) => Math.hypot(t.e - h.e, t.n - h.n) < c.alternativeApartM)) continue;
      taken.push(h);
      alternatives.push({ ...frame.toCoordinate(h.e, h.n), weight: w });
    }
    const best = hyps.reduce((a, b) => (b.logW > a.logW ? b : a), hyps[0]);
    const speedMps = Number.isFinite(this.lastSpeedMps) ? Math.max(0, this.lastSpeedMps) * (best?.k ?? 1) : undefined;
    return {
      tUs: this.nowUs,
      ...frame.toCoordinate(est.e, est.n),
      headingRad: est.headingRad,
      accuracyM,
      ...(speedMps !== undefined ? { speedMps } : {}),
      stopped: this.stopped,
      alternatives,
    };
  }
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** The nearest point of a polyline within `maxM` of (e, n): how far along it, and its heading there. */
function nearestOnLine(pts: [number, number][], e: number, n: number, maxM: number): { alongM: number; headingRad: number } | null {
  let best: { d: number; alongM: number; headingRad: number } | null = null;
  let cum = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    const f = len > 0 ? Math.max(0, Math.min(1, ((e - ax) * dx + (n - ay) * dy) / (len * len))) : 0;
    const d = Math.hypot(e - ax - f * dx, n - ay - f * dy);
    if (d <= maxM && (!best || d < best.d)) best = { d, alongM: cum + f * len, headingRad: Math.atan2(dx, dy) };
    cum += len;
  }
  return best;
}

/** A polyline's stretch between two distances along it. */
function sliceLine(pts: [number, number][], fromM: number, toM: number): [number, number][] {
  const out: [number, number][] = [];
  let cum = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const len = Math.hypot(bx - ax, by - ay);
    const at = (m: number): [number, number] => {
      const f = len > 0 ? (m - cum) / len : 0;
      return [ax + (bx - ax) * f, ay + (by - ay) * f];
    };
    if (cum + len >= fromM && cum <= toM) {
      if (!out.length) out.push(at(Math.max(fromM, cum)));
      out.push(at(Math.min(toM, cum + len)));
    }
    cum += len;
  }
  return out;
}
