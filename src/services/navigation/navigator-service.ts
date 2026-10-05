// The Stage 1 navigator in the app (NAVIGATOR-SPEC §9): phone GNSS + IMU from SensorService and
// OBD speed from the vehicle link, fused by `Navigator` into the map's position. Without OBD
// speed it shows phone GNSS as before, because dead reckoning needs the car's speed.

import type { LocationPermissionResponse } from "expo-location";

import type { MapMatchState } from "@/nav/mapmatch/particle-filter";
import { UpdateTiming, type UpdateTimingSummary } from "@/nav/mapmatch/update-timing";
import type { FixOutcome, MapMatchEstimate, NavConfig, NavMode, ParkedPose } from "@/nav/navigator";
import { Navigator } from "@/nav/navigator";
import { haversineM } from "@/nav/geo";
import { FUSED_WINDOW_US, puckAccuracyM, puckHypothesis } from "@/nav/position/puck";
import type { PositionEstimate, PositionSourceKind, SimulatedOutage } from "@/nav/position/types";
import type { CompassTrust } from "@/nav/compass/compass";
import type { GnssFix, ImuSample, MagSample, ObdSpeedSample } from "@/nav/types";
import type { EngineState, SpeedSample, VehicleLinkSnapshot } from "@/obd/types";
import { isSatelliteRecord, mapFixToPosition } from "@/services/position/gnss-position-source";
import { GnssTrustTracker } from "@/services/position/gnss-trust";
import type { RoadGraphSource } from "@/services/offline-map/road-graph-file";
import type { PositionSource } from "@/services/position/position-source";
import type { SensorService } from "@/services/sensor-capture/sensor-service";
import {
  GNSS_FLAGS,
  MAPMATCH_TOP,
  type GnssRecord,
  type ImuMotionRecord,
  type NavEstimateRecord,
  type NavMapMatchRecord,
  type Vec3Record,
} from "@/triplog/schema";

import type { CalibrationStore } from "./calibration-store";

const OWNER = "navigator";
const TICK_MS = 500;
/** Inputs are held this long and fed in time order: IMU arrives in 100 ms batches, fixes ~50 ms late. */
export const REORDER_US = 300_000;
/** A fix delivered later than this behind the navigator is dropped (its state history spans 3 s). */
const LATE_FIX_MAX_US = 2_000_000;
/** Without OBD speed for this long the map falls back to phone GNSS (the EKF's speed has drifted). */
const OBD_TIMEOUT_US = 10_000_000;
/** Draw the position up to this far ahead of the navigator, which runs `REORDER_US` behind. */
const MAX_EXTRAPOLATE_S = 1;
const SAVE_EVERY_MS = 30_000;
/** Note a saved speed scale in the trip log when it moved this much. */
const SPEED_SCALE_NOTE_STEP = 0.002;
const EARTH_RADIUS_M = 6_371_000;
/** The driver's placing on the map: a car's length or so, and the heading of a tap (NAVIGATOR-SPEC §6.2). */
const USER_POSITION_SIGMA_M = 10;
const USER_HEADING_SIGMA_RAD = (15 * Math.PI) / 180;
/** Added to a stored parked pose's 1σ: the car settles, the phone may sit differently in the mount. */
const POSE_POSITION_SLACK_M = 5;
const POSE_HEADING_SLACK_RAD = (2 * Math.PI) / 180;
const DEG = 180 / Math.PI;
/** Alternatives lighter than this aren't drawn. */
const ALTERNATIVE_MIN_WEIGHT = 0.05;
/** In a simulated outage, a withheld fix is the truth when it is a satellite fix this accurate and recent. */
const OUTAGE_TRUTH_MAX_ACC_M = 10;
const OUTAGE_TRUTH_MAX_AGE_MS = 3000;
/** Particles in the debug overlay, heaviest first. */
const OVERLAY_PARTICLES = 200;

export interface NavigatorLink {
  onSpeed(listener: (s: SpeedSample) => void): () => void;
  onEngineState(listener: (e: EngineState, tUs: number) => void): () => void;
  getSnapshot(): Pick<VehicleLinkSnapshot, "vehicle">;
  /** The connected car's VIN (null: a car not known), else the last car's (known before the adapter connects). */
  expectedVin(): string | null;
}

/** Navigator state for the debug screen. */
export interface NavigatorDebug {
  mode: NavMode | "off";
  source: PositionSourceKind | null;
  headingSigmaDeg: number | null;
  speedScale: number | null;
  speedScaleSigma: number | null;
  gyroBiasDegS: number | null;
  gyroScale: number | null;
  gnssLagS: number | null;
  /** Turn windows behind the online lag estimate (0: still the stored or default lag). */
  gnssLagWindows: number;
  /** The pose this session started from. */
  parkedPose: "none" | "unverified" | "confirmed" | "rejected";
  /** Compass in shadow (NAVIGATOR-SPEC §7.6): its trust, and how far it is off the EKF heading now. */
  compassTrust: CompassTrust | "off";
  compassOffDeg: number | null;
  /** Map matching: the region whose graph is set (null: none), the filter's state and cost. */
  mapMatchRegion: string | null;
  /** How map matching feeds back into the navigator, and the road corrections it sent this drive. */
  mapMatchLoop: MapMatchLoop;
  roadHeading: { accepted: number; rejected: number } | null;
  roadPosition: { accepted: number; rejected: number } | null;
  mapMatch: MapMatchEstimate | null;
  /** Every filter update this drive (since the last `mm timing` note), and its share of the time (starts included). */
  mapMatchTiming: (UpdateTimingSummary & { share: number }) | null;
  /** The filter's starts this drive, apart from its updates: the first reads the roads around the car from storage. */
  mapMatchStarts: { count: number; maxMs: number } | null;
}

/** The particle filter's state for the map's debug overlay (MAPMATCH-SPEC §11). */
export interface MapMatchOverlay {
  /** [lat, lon, weight ÷ the heaviest particle's, off-road 1/0], heaviest first. */
  particles: [number, number, number, number][];
  clusters: MapMatchEstimate["clusters"];
}

export type MapMatchLoop = NavConfig["mapMatchLoop"];

export interface NavigatorServiceDeps {
  sensors: Pick<SensorService, "gnss" | "imu" | "want">;
  link: NavigatorLink;
  calibration: CalibrationStore;
  /** Monotonic uptime, µs (the clock of every sensor timestamp). */
  nowUs(): number;
  /** Navigator events for the trip log. */
  note?(text: string): void;
  /** Every published position, for the trip log (`nav_estimate`). */
  log?(record: NavEstimateRecord): void;
  /** Map matching with each published position while it runs (`nav_mapmatch`). */
  logMapMatch?(record: NavMapMatchRecord): void;
  /** The active region's road graph; map matching is off without it. */
  roadGraph?: RoadGraphSource;
  nav?: Partial<NavConfig>;
  /** Wall clock and the tick timer: the real ones in the app, a trip log's in a replay (app-replay.ts). */
  clock?: ServiceClock;
  /** Location permission (expo-location in the app); without it, granted. */
  permission?: { get(): Promise<LocationPermissionResponse>; request(): Promise<LocationPermissionResponse> };
  /** A replay looking in: each navigator as it is made, each fix's outcome, the fixes a simulated outage withholds. */
  observer?: NavigatorObserver;
}

export interface ServiceClock {
  nowMs(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface NavigatorObserver {
  navigator?(nav: Navigator): void;
  fix?(fix: GnssFix, outcome: FixOutcome): void;
  withheld?(record: GnssRecord): void;
  /** The navigator took an input of this time (IMU, OBD speed or a fix). */
  fed?(tUs: number): void;
}

const SYSTEM_CLOCK: ServiceClock = {
  nowMs: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};
const GRANTED = { granted: true, status: "granted", canAskAgain: true, expires: "never" } as LocationPermissionResponse;

type Input =
  | { tUs: number; imu: ImuSample }
  | { tUs: number; mag: MagSample }
  | { tUs: number; obd: ObdSpeedSample }
  | { tUs: number; fix: GnssFix };

/** CoreLocation record → navigator fix (as the trip-log reader does); null for unusable fixes. */
export function toNavFix(r: GnssRecord): GnssFix | null {
  if (r.flags & GNSS_FLAGS.simulated || !Number.isFinite(r.hAccM) || !Number.isFinite(r.latDeg) || !Number.isFinite(r.lonDeg)) return null;
  const valid = (v: number) => (Number.isFinite(v) ? v : undefined);
  return {
    tUs: r.timestampUs,
    lat: r.latDeg,
    lon: r.lonDeg,
    hAccM: r.hAccM,
    speedMps: isSatelliteRecord(r) ? r.speedMps : undefined,
    speedAccMps: valid(r.speedAccMps),
    courseRad: valid(r.courseRad),
    courseAccRad: valid(r.courseAccRad),
  };
}

export class NavigatorService implements PositionSource {
  private readonly deps: NavigatorServiceDeps;
  private position: PositionEstimate | null = null;
  private listeners = new Set<() => void>();
  private unsubscribers: (() => void)[] = [];
  private timer: unknown = null;
  private foreground = false;
  private keepAlive = false;

  private nav: Navigator | null = null;
  private pending: Input[] = [];
  /** Time of the last input fed to the navigator. */
  private fedUs = -Infinity;
  private trust = new GnssTrustTracker();
  private lastFix: GnssRecord | null = null;
  private lastObdUs = -Infinity;
  private lastAcceptedSatUs = -Infinity;
  /** OBD distance (navigator stats) at the last trusted fix. */
  private trustedDistanceM: number | null = null;
  private mode: NavMode = "none";
  private vin: string | null = null;
  private lastSaveAt = 0;
  private notedSpeedScale: number | null = null;
  /** A parked pose is in storage: cleared once the car moves. */
  private poseStored = false;
  private poseStatus: NavigatorDebug["parkedPose"] = "none";
  /** A Wi-Fi fix doubts the parked pose the navigator started from: the driver is asked. */
  private poseQuestion: { distanceM: number } | null = null;
  /** Compass shadow notes: the trust last noted, and the trust checks already summarised. */
  private notedCompassTrust: CompassTrust = "none";
  private summarisedChecks = 0;
  /** The road graph set on the navigator: its key, region and build time. */
  private graph: { key: string; region: string; builtAt: number } | null = null;
  private notedMapMatch: MapMatchState = "off";
  /** Test tool: GNSS withheld from the navigator. `hidden` is the newest fix withheld. */
  private outage: { startedAt: number; startDistanceM: number | null; hidden: GnssRecord | null; maxErrorM: number } | null = null;
  private overlay: MapMatchOverlay | null = null;
  /** Developer setting: how map matching feeds back into the navigator (MAPMATCH-SPEC §9). */
  private loop: MapMatchLoop = "open";
  /** The route's edges for the filter (ROUTING-SPEC §8.6), or null. */
  private routeHint: number[] | null = null;
  /** Road corrections already summarised in the trip log. */
  private notedRoad = { heading: 0, position: 0 };
  private overlayStale = true;
  /** Filter update times: this drive's, and those since the last `nav_mapmatch` record; its starts, apart. */
  private timing = new UpdateTiming();
  private starts = { count: 0, totalMs: 0, maxMs: 0 };
  private timingSince = 0;
  private interval = { count: 0, totalMs: 0, maxMs: 0 };

  private readonly clock: ServiceClock;

  constructor(deps: NavigatorServiceDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? SYSTEM_CLOCK;
  }

  getSnapshot = (): PositionEstimate | null => this.position;

  /** Switch the navigator version (developer setting); the running navigator follows at once. */
  setMapMatchLoop(loop: MapMatchLoop): void {
    if (loop === this.loop) return;
    this.loop = loop;
    this.nav?.setMapMatchLoop(loop);
    this.note(`nav map-match loop ${loop}`);
  }

  /** The route the driver follows, for map matching (ROUTING-SPEC §8.6); null: none. Kept for a new navigator. */
  setRouteHint(edges: number[] | null): void {
    if (edges === this.routeHint || (!edges && !this.routeHint)) return;
    this.routeHint = edges;
    this.nav?.setRouteHint(edges);
    this.note(edges ? `nav route hint: ${edges.length} edges` : "nav route hint off");
  }

  /**
   * The driver put the car on the map while it stood (NAVIGATOR-SPEC §6.2); `headingRad` undefined: skipped. False
   * when there is no navigator.
   */
  setUserPosition(at: { lat: number; lon: number }, headingRad?: number): boolean {
    const nav = this.nav;
    if (!nav) return false;
    nav.setPosition({ ...at, headingRad, posSigmaM: USER_POSITION_SIGMA_M, headingSigmaRad: USER_HEADING_SIGMA_RAD });
    const was = this.position;
    const moved = was ? ` ${Math.round(haversineM(was, at))} m from the dot` : "";
    const heading = headingRad === undefined ? "heading skipped" : `heading ${Math.round((((headingRad * 180) / Math.PI) % 360 + 360) % 360)}°`;
    this.note(`nav position set by the driver: ${at.lat.toFixed(6)},${at.lon.toFixed(6)}${moved}, ${heading}`);
    this.poseQuestion = null;
    this.poseStatus = "none";
    this.flush(this.deps.nowUs() - REORDER_US);
    // The car's parked pose now (with a heading, its VIN known): kept at once, not at the next 30 s save, so an app
    // closed right after starts from it.
    if (headingRad !== undefined) this.saveCalibration();
    this.publish();
    return true;
  }

  /** The driver's answer to `poseQuestion`: the car is (not) where the dot is. */
  answerPose(here: boolean): void {
    if (!this.poseQuestion || !this.nav) return;
    const answered = this.nav.answerPose(here);
    this.note(`nav parked pose ${here ? "confirmed" : "rejected"} by the driver (Wi-Fi ${Math.round(this.poseQuestion.distanceM)} m away)${answered ? "" : ", too late"}`);
    this.poseQuestion = null;
    if (answered) {
      this.poseStatus = here ? "confirmed" : "rejected";
      if (!here && this.vin) this.deps.calibration.clearParkedPose(this.vin);
      if (!here) this.poseStored = false;
    }
    this.publish();
  }

  get simulatedOutage(): boolean {
    return this.outage !== null;
  }

  /**
   * Test tool: cut GNSS for the navigator (and the trust status) as a real outage would, while the
   * sensors keep logging it. The map shows the withheld fix and how far the dot is from it.
   */
  setSimulatedOutage(on: boolean): void {
    if (on === (this.outage !== null)) return;
    if (on) {
      this.outage = { startedAt: this.clock.nowMs(), startDistanceM: this.nav?.stats.obdDistanceM ?? null, hidden: null, maxErrorM: 0 };
      this.note("sim gnss outage on");
    } else {
      const o = this.position?.simulatedOutage;
      const parts = [`${Math.round((this.clock.nowMs() - this.outage!.startedAt) / 1000)} s`];
      if (o?.distanceM !== undefined) parts.push(`${(o.distanceM / 1000).toFixed(2)} km`);
      if (o?.errorM !== undefined) parts.push(`dot ${Math.round(o.errorM)} m from GPS (max ${Math.round(o.maxErrorM ?? 0)} m)`);
      this.note(`sim gnss outage off: ${parts.join(", ")}`);
      this.outage = null;
    }
    if (this.position) this.set(this.position);
  }

  /** Particles and hypotheses now (null: map matching off); recomputed once per published position. */
  getMapMatchOverlay(): MapMatchOverlay | null {
    if (!this.overlayStale) return this.overlay;
    this.overlayStale = false;
    const nav = this.nav;
    const mm = nav?.estimate()?.mapMatch;
    if (!nav || !mm) return (this.overlay = null);
    const particles = nav.mapMatchParticles(OVERLAY_PARTICLES);
    const heaviest = particles[0]?.[2] ?? 0;
    this.overlay = {
      particles: particles.map(([lat, lon, w, off]) => [lat, lon, heaviest > 0 ? w / heaviest : 0, off]),
      clusters: mm.clusters,
    };
    return this.overlay;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getPermission = (): Promise<LocationPermissionResponse> => this.deps.permission?.get() ?? Promise.resolve(GRANTED);

  requestPermission = (): Promise<LocationPermissionResponse> => this.deps.permission?.request() ?? Promise.resolve(GRANTED);

  /** Map on screen. Idempotent; also retries native capture that couldn't start (e.g. before permission). */
  async start(): Promise<void> {
    const permission = await this.getPermission();
    if (!permission.granted) return;
    this.foreground = true;
    this.sync();
  }

  stop(): void {
    this.foreground = false;
    this.sync();
  }

  /** Keep running with the map off screen (during a trip), so dead reckoning isn't interrupted. */
  setKeepAlive(keepAlive: boolean): void {
    if (keepAlive === this.keepAlive) return;
    this.keepAlive = keepAlive;
    this.sync();
  }

  /** Online values worth keeping: written now (also every 30 s and when the navigator stops). */
  saveCalibration(): void {
    const nav = this.nav;
    if (!nav) return;
    this.lastSaveAt = this.clock.nowMs();
    const pose = nav.parkedPose;
    if (pose && this.vin) {
      this.deps.calibration.saveParkedPose(this.vin, pose, this.clock.nowMs());
      if (!this.poseStored) this.note(`nav parked pose saved (heading ±${((pose.headingSigmaRad * 180) / Math.PI).toFixed(1)}°)`);
      this.poseStored = true;
    }
    const lag = nav.gnssLagEstimate;
    if (lag && this.deps.calibration.saveGnssLag(lag, this.clock.nowMs())) this.note(`nav gnss lag saved ${lag.lagS} s (${lag.windows} turn windows)`);
    const compass = nav.compassCalibrations;
    if (compass.length && this.vin) this.deps.calibration.saveCompassCalibrations(this.vin, compass, this.clock.nowMs());
    const params = nav.params;
    if (!params || !this.vin || !this.deps.calibration.saveSpeedScale(this.vin, params.ks, params.ksVar, this.clock.nowMs())) return;
    if (this.notedSpeedScale === null || Math.abs(params.ks - this.notedSpeedScale) >= SPEED_SCALE_NOTE_STEP) {
      this.notedSpeedScale = params.ks;
      this.note(`nav speed scale saved ${params.ks.toFixed(4)} ±${Math.sqrt(params.ksVar).toFixed(4)}`);
    }
  }

  getDebug(): NavigatorDebug {
    const nav = this.nav;
    const p = nav?.params ?? null;
    const e = nav?.estimate() ?? null;
    return {
      mode: nav ? nav.mode : "off",
      source: this.position?.source ?? null,
      headingSigmaDeg: e?.headingSigmaRad === undefined ? null : (e.headingSigmaRad * 180) / Math.PI,
      speedScale: p?.ks ?? null,
      speedScaleSigma: p ? Math.sqrt(p.ksVar) : null,
      gyroBiasDegS: p ? (p.bw * 180) / Math.PI : null,
      gyroScale: p?.kw ?? null,
      gnssLagS: nav?.gnssLagS ?? null,
      gnssLagWindows: nav?.gnssLagEstimate?.windows ?? 0,
      parkedPose: this.poseStatus,
      compassTrust: nav ? nav.compassTrust : "off",
      compassOffDeg: nav ? compassOff(nav) : null,
      mapMatchRegion: this.graph?.region ?? null,
      mapMatchLoop: this.loop,
      roadHeading: nav ? { accepted: nav.stats.roadHeadingAccepted, rejected: nav.stats.roadHeadingRejected } : null,
      roadPosition: nav ? { accepted: nav.stats.roadPositionAccepted, rejected: nav.stats.roadPositionRejected } : null,
      mapMatch: e?.mapMatch ?? null,
      mapMatchTiming: this.timingSummary(),
      mapMatchStarts: this.starts.count ? { count: this.starts.count, maxMs: this.starts.maxMs } : null,
    };
  }

  private sync(): void {
    const run = this.foreground || this.keepAlive;
    this.deps.sensors.want(run, run, OWNER);
    if (run && !this.timer) this.attach();
    else if (!run && this.timer) this.detach();
  }

  private attach(): void {
    const { sensors, link } = this.deps;
    this.createNavigator();
    this.unsubscribers.push(
      this.deps.roadGraph?.subscribe(() => this.applyRoadGraph()) ?? (() => {}),
      sensors.gnss.on((r) => this.onGnss(r)),
      sensors.imu.on((batch) => this.onImu(batch.motion, batch.mag)),
      link.onSpeed((s) => this.onSpeed(s)),
      link.onEngineState((state) => {
        // Parked: keep the pose for the next start, even if the app is killed later.
        if (state !== "engine-off" && state !== "ignition-off") return;
        this.flush(this.deps.nowUs() - REORDER_US);
        this.saveCalibration();
        this.noteCompassSummary();
        this.noteMapMatchTiming();
        this.noteRoadCorrections();
      }),
    );
    this.lastSaveAt = this.clock.nowMs();
    this.timer = this.clock.setInterval(() => this.tick(), TICK_MS);
  }

  private detach(): void {
    this.flush(Infinity);
    this.saveCalibration();
    this.noteCompassSummary();
    this.noteMapMatchTiming();
    this.noteRoadCorrections();
    this.unsubscribers.forEach((u) => u());
    this.unsubscribers = [];
    if (this.timer) this.clock.clearInterval(this.timer);
    this.timer = null;
    // A later start begins afresh: the car may have moved meanwhile.
    this.nav = null;
    this.pending = [];
    this.setMode("none");
  }

  private createNavigator(): void {
    const { calibration, link } = this.deps;
    this.drainUpdateTimes(); // from the navigator being replaced
    const lag = calibration.gnssLag();
    const nav = new Navigator({ ...this.deps.nav, mapMatchLoop: this.loop, ...(lag ? { gnssLagS: lag.lagS } : {}) });
    this.notedRoad = { heading: 0, position: 0 };
    this.nav = nav;
    this.deps.observer?.navigator?.(nav);
    if (lag) this.note(`nav gnss lag ${lag.lagS} s from storage (${lag.windows} turn windows)`);
    this.fedUs = -Infinity;
    this.lastAcceptedSatUs = -Infinity;
    this.trustedDistanceM = null;
    this.vin = null;
    this.poseStatus = "none";
    this.poseQuestion = null;
    this.notedCompassTrust = "none";
    this.summarisedChecks = 0;
    // Before the parked pose: the filter then starts around it.
    this.graph = null;
    this.notedMapMatch = "off";
    this.interval = { count: 0, totalMs: 0, maxMs: 0 };
    this.applyRoadGraph();
    nav.setRouteHint(this.routeHint);
    // Known before the adapter connects: the last car seen.
    const vin = link.expectedVin();
    if (!vin) return;
    this.setVehicle(vin);
    this.startFromParkedPose(vin, false);
  }

  /** The pose saved when this car was parked, if the navigator has no better start; `late`: the VIN came after the start. */
  private startFromParkedPose(vin: string, late: boolean): void {
    const pose = this.deps.calibration.parkedPose(vin);
    this.poseStored = pose !== null;
    if (pose && this.nav?.startFromPose(widen(pose))) {
      this.poseStatus = "unverified";
      this.note(`nav mode dr (parked pose, ${Math.round((this.clock.nowMs() - pose.savedAt) / 60_000)} min old${late ? ", VIN known late" : ""})`);
    }
  }

  /** The active region's road graph onto the navigator; a new region (or graph version) restarts the filter. */
  private applyRoadGraph(): void {
    const nav = this.nav;
    if (!nav || !this.deps.roadGraph) return;
    const active = this.deps.roadGraph.current();
    if ((active?.key ?? null) === (this.graph?.key ?? null)) return;
    this.drainUpdateTimes(); // the filter is about to be replaced
    nav.setRoadGraph(active?.graph ?? null);
    this.graph = active ? { key: active.key, region: active.region, builtAt: active.graph.info.builtAt } : null;
    this.note(active ? `mm graph ${active.region} (OSM ${active.graph.info.osmDate})` : "mm graph none");
  }

  /**
   * The connected car's VIN: the first one applies its speed scale and parked pose; another car (or one the link
   * doesn't know: VIN null) starts a new navigator.
   */
  private checkVehicle(): void {
    const vehicle = this.deps.link.getSnapshot().vehicle;
    if (!vehicle || vehicle.vin === this.vin) return;
    if (this.vin) {
      // Not the car expected: what this navigator learned (and the pose it started from) may belong to either.
      this.note(vehicle.vin ? "nav vehicle changed: restart" : "nav vehicle unknown, not the one expected: restart");
      this.createNavigator();
    } else if (vehicle.vin) {
      this.setVehicle(vehicle.vin);
      this.startFromParkedPose(vehicle.vin, true);
    }
  }

  private setVehicle(vin: string): void {
    this.vin = vin;
    const ks = this.deps.calibration.speedScale(vin);
    if (ks && this.nav) {
      this.nav.setSpeedScalePrior(ks.ks, ks.ksVar);
      this.note(`nav speed scale ${ks.ks.toFixed(4)} from storage`);
    }
    const compass = this.deps.calibration.compassCalibrations(vin);
    if (compass.length && this.nav) {
      this.nav.setCompassCalibrations(compass);
      const each = compass.map((c) => `${c.samples} samples${c.confirmed ? "" : " unconfirmed"}`).join(", ");
      this.note(`nav compass from storage: ${compass.length} mounting(s) (${each})`);
    }
  }

  // ---- inputs ----

  private onGnss(r: GnssRecord): void {
    if (!Number.isFinite(r.latDeg) || !Number.isFinite(r.lonDeg)) return;
    if (this.outage) {
      this.deps.observer?.withheld?.(r);
      this.outage.hidden = r;
      this.publish();
      return;
    }
    this.lastFix = r;
    const satellite = isSatelliteRecord(r);
    this.trust.onFix(Number.isFinite(r.hAccM) ? r.hAccM : 9999, r.utcUs / 1000, satellite);
    const fix = toNavFix(r);
    if (fix) this.pending.push({ tUs: fix.tUs, fix });
    // Process now, so the map doesn't wait for the next tick.
    this.flush(this.deps.nowUs() - REORDER_US);
    if (this.nav && this.trust.lastTrustedFixAt === r.utcUs / 1000) this.trustedDistanceM = this.nav.stats.obdDistanceM;
    this.publish();
  }

  private onImu(motion: ImuMotionRecord[], mag: Vec3Record[]): void {
    for (const m of motion) {
      this.pending.push({ tUs: m.timestampUs, imu: { tUs: m.timestampUs, gyro: m.gyro, gravity: m.gravity, userAccel: m.userAccel } });
    }
    for (const f of mag) this.pending.push({ tUs: f.timestampUs, mag: { tUs: f.timestampUs, field: [f.v[0], f.v[1], f.v[2]] } });
    this.flush(this.deps.nowUs() - REORDER_US);
  }

  private onSpeed(s: SpeedSample): void {
    this.lastObdUs = s.tUs;
    if (s.raw > 0 && this.poseStored) {
      // Driving: the stored pose is stale until the next stop.
      if (this.vin) this.deps.calibration.clearParkedPose(this.vin);
      this.poseStored = false;
    }
    this.pending.push({ tUs: s.tUs, obd: { tUs: s.tUs, speedMps: s.speedMps, rawKph: s.raw } });
  }

  /** Feed everything up to `untilUs` in time order. */
  private flush(untilUs: number): void {
    const nav = this.nav;
    if (!nav || this.pending.length === 0) return;
    this.pending.sort((a, b) => a.tUs - b.tUs);
    let n = 0;
    while (n < this.pending.length && this.pending[n].tUs <= untilUs) n++;
    const ready = this.pending.splice(0, n);
    for (const input of ready) {
      const late = input.tUs < this.fedUs;
      if ("fix" in input) {
        // A fix delivered late can still update from the navigator's state history.
        if (late && this.fedUs - input.tUs > LATE_FIX_MAX_US) continue;
        const out = nav.onGnss(input.fix);
        this.deps.observer?.fix?.(input.fix, out);
        if (out.status === "accepted" && input.fix.speedMps !== undefined) this.lastAcceptedSatUs = input.tUs;
        if (out.status === "init") this.note(`nav mode dr (${out.initMethod})`);
        if (out.pose && out.pose !== "doubted") {
          this.poseStatus = out.pose;
          this.poseQuestion = null;
        }
        if (out.pose === "doubted") {
          if (!this.poseQuestion) this.note(`nav parked pose doubted: Wi-Fi fix ${Math.round(out.errorM ?? 0)} m away (±${Math.round(input.fix.hAccM)} m), asking the driver`);
          this.poseQuestion = { distanceM: out.errorM ?? 0 };
        }
        if (out.pose === "confirmed") this.note("nav parked pose confirmed");
        if (out.pose === "rejected") {
          this.note(`nav parked pose rejected: fix ${Math.round(out.errorM ?? 0)} m away (±${Math.round(input.fix.hAccM)} m)`);
          if (this.vin) this.deps.calibration.clearParkedPose(this.vin);
          this.poseStored = false;
        }
      } else if (late) {
        continue;
      } else if ("imu" in input) {
        nav.onImu(input.imu);
      } else if ("mag" in input) {
        nav.onMag(input.mag);
      } else {
        nav.onObdSpeed(input.obd);
      }
      this.fedUs = Math.max(this.fedUs, input.tUs);
      if (!("mag" in input)) this.deps.observer?.fed?.(input.tUs);
    }
  }

  private tick(): void {
    this.checkVehicle();
    this.flush(this.deps.nowUs() - REORDER_US);
    this.publish();
    this.noteCompassTrust();
    if (this.clock.nowMs() - this.lastSaveAt >= SAVE_EVERY_MS) this.saveCalibration();
  }

  // ---- compass in shadow (NAVIGATOR-SPEC §7.6): logged, never navigated with ----

  /** The heading just became known: what the compass said at that moment. */
  private noteCompassAtStart(): void {
    const nav = this.nav;
    if (!nav) return;
    const off = compassOff(nav);
    this.note(`nav compass at start: ${off === null ? "none" : `${off.toFixed(0)}° off`} (${nav.compassTrust})`);
  }

  /** A stored calibration checked against the known heading: confirmed or rejected. */
  private noteCompassTrust(): void {
    const nav = this.nav;
    if (!nav || nav.compassTrust === this.notedCompassTrust) return;
    const before = this.notedCompassTrust;
    this.notedCompassTrust = nav.compassTrust;
    const diffs = nav.compassCheckDiffs.slice(-10).map((d) => Math.abs(d) * DEG);
    const median = diffs.length ? ` (median ${percentile(diffs, 0.5).toFixed(0)}° over ${diffs.length} checks)` : "";
    this.note(`nav compass ${before} → ${nav.compassTrust}${median}`);
  }

  /** At the end of a drive: how the compass did against the known heading. */
  private noteCompassSummary(): void {
    const nav = this.nav;
    if (!nav) return;
    const diffs = nav.compassCheckDiffs.map((d) => Math.abs(d) * DEG);
    if (diffs.length === this.summarisedChecks) return;
    this.summarisedChecks = diffs.length;
    this.note(
      `nav compass drive: ${nav.compassTrust}, ${diffs.length} checks, median ${percentile(diffs, 0.5).toFixed(0)}°, ` +
        `p90 ${percentile(diffs, 0.9).toFixed(0)}°, ${nav.compassCalibrations.length} mounting(s) kept`,
    );
  }

  // ---- output ----

  private publish(): void {
    const now = this.clock.nowMs();
    const nowUs = this.deps.nowUs();
    const trust = this.trust.check(now);
    const fix = this.lastFix;
    const nav = this.nav;
    const estimate = nav?.estimate() ?? null;
    if (nav) this.setMode(nav.mode);

    const withObd = nowUs - this.lastObdUs < OBD_TIMEOUT_US;
    if (!nav || !estimate || !withObd) {
      // Phone GNSS only, as without the navigator: a new snapshot only for a new fix or trust.
      const p = this.position;
      const same = p && fix && p.source === "gnss" && p.timestamp === fix.utcUs / 1000 && p.trust === trust;
      if (fix && !same) this.set(mapFixToPosition(fix, trust, this.trust.lastTrustedFixAt));
      else if (this.position && this.position.trust !== trust) this.set({ ...this.position, trust });
      return;
    }

    const dr = estimate.mode === "dr";
    const source: PositionSourceKind = !dr
      ? "gnss"
      : trust === "TRUSTED" && estimate.tUs - this.lastAcceptedSatUs < FUSED_WINDOW_US
        ? "fused"
        : "dr";
    const mm = estimate.mapMatch;
    this.noteMapMatch(mm?.state ?? "off");
    // Dead-reckoning on the map: the dominant hypothesis is the puck, the others its alternatives
    // (MAPMATCH-SPEC §6.2). With GNSS the EKF stays the puck: it is within a few metres there.
    const top = puckHypothesis(estimate, source === "dr");
    const speed = estimate.speedMps;
    const heading = top
      ? top.headingRad
      : dr
        ? estimate.headingRad
        : trust === "TRUSTED" && fix && Number.isFinite(fix.courseRad)
          ? fix.courseRad
          : undefined;
    // The navigator runs a reorder window behind: draw the car where it is now.
    const aheadM = dr && speed !== undefined ? speed * Math.min(Math.max(0, (nowUs - estimate.tUs) / 1e6), MAX_EXTRAPOLATE_S) : 0;
    const { lat, lon } = ahead(top ?? estimate, heading, aheadM);
    const alternatives =
      top && mm?.state === "multimodal"
        ? mm.clusters
            .slice(1)
            .filter((c) => c.weight >= ALTERNATIVE_MIN_WEIGHT)
            .map((c) => ({ ...ahead(c, c.headingRad, aheadM), weight: c.weight }))
        : undefined;
    this.set(
      {
      lat,
      lon,
      headingRad: heading,
      speedMps: speed,
      accuracyM: puckAccuracyM(estimate, top),
      ...(mm ? { mapMatch: mm.state } : {}),
      ...(alternatives?.length ? { alternatives } : {}),
      source,
      trust,
      timestamp: now,
      lastTrustedFixAt: this.trust.lastTrustedFixAt,
      distanceSinceTrustedM: this.trustedDistanceM === null ? undefined : nav.stats.obdDistanceM - this.trustedDistanceM,
      rawGnss: fix
        ? { lat: fix.latDeg, lon: fix.lonDeg, accuracyM: Number.isFinite(fix.hAccM) ? fix.hAccM : 9999, timestamp: fix.utcUs / 1000 }
        : undefined,
      },
      nowUs - estimate.tUs,
    );
  }

  private setMode(mode: NavMode): void {
    if (mode === this.mode) return;
    // Entering dr is noted with its init method when the fix is processed.
    if (mode === "anchored") this.note(this.mode === "dr" ? "nav reset: fixes disagree with dead reckoning" : "nav mode anchored");
    this.mode = mode;
    if (mode !== "dr") return;
    // Fix-based starts are noted with the fix; a map start happens between fixes.
    if (this.nav?.initialization?.method === "map") this.note("nav mode dr (map)");
    this.noteCompassAtStart();
  }

  /** Map-match state changes into the trip log, except the flips between tracking and multimodal. */
  private noteMapMatch(state: MapMatchState): void {
    const onRoad = (s: MapMatchState) => s === "tracking" || s === "multimodal";
    if (state === this.notedMapMatch || (onRoad(state) && onRoad(this.notedMapMatch))) return;
    const mm = this.nav?.estimate()?.mapMatch;
    this.notedMapMatch = state;
    this.note(`mm ${state}${mm ? ` (${mm.particles} particles, ${mm.clusters.length} hypotheses)` : ""}`);
  }

  private note(text: string): void {
    this.deps.note?.(text);
  }

  /** `behindUs`: how far the navigator's state lags now (the drawn position is extrapolated over it). */
  private set(position: PositionEstimate, behindUs = 0): void {
    this.drainUpdateTimes();
    const { simulatedOutage: _, poseQuestion: _q, ...rest } = position;
    const outage = this.outageInfo(rest);
    this.position = { ...rest, ...(outage ? { simulatedOutage: outage } : {}), ...(this.poseQuestion ? { poseQuestion: this.poseQuestion } : {}) };
    this.overlayStale = true;
    this.logPosition(position, behindUs);
    this.listeners.forEach((listener) => listener());
  }

  // ---- map-matching speed (MAPMATCH-SPEC §11) ----

  /** Every filter start and update since the last drain, out of the filter (whose lists would grow all drive). */
  private drainUpdateTimes(): void {
    const pf = this.nav?.mapMatcher;
    if (!pf || (!pf.updateTimes.length && !pf.startTimes.length)) return;
    if (!this.timing.count && !this.starts.count) this.timingSince = this.clock.nowMs();
    for (const ms of pf.startTimes.splice(0)) {
      this.starts.count++;
      this.starts.totalMs += ms;
      this.starts.maxMs = Math.max(this.starts.maxMs, ms);
    }
    for (const ms of pf.updateTimes.splice(0)) {
      this.timing.add(ms);
      this.interval.count++;
      this.interval.totalMs += ms;
      this.interval.maxMs = Math.max(this.interval.maxMs, ms);
    }
  }

  private timingSummary(): NavigatorDebug["mapMatchTiming"] {
    this.drainUpdateTimes();
    const s = this.timing.summary();
    if (!s) return null;
    return { ...s, share: (s.totalMs + this.starts.totalMs) / Math.max(1, this.clock.nowMs() - this.timingSince) };
  }

  /** At the end of a drive: how long the filter's updates took, then start counting afresh. */
  private noteMapMatchTiming(): void {
    const s = this.timingSummary();
    const starts = this.starts;
    this.timing = new UpdateTiming();
    this.starts = { count: 0, totalMs: 0, maxMs: 0 };
    if (!s) return;
    const ms = (v: number) => (v < 10 ? v.toFixed(2) : v.toFixed(0));
    this.note(
      `mm timing: ${s.count} updates, p50 ${ms(s.p50Ms)} ms, p99 ${ms(s.p99Ms)} ms, max ${ms(s.maxMs)} ms, ` +
        `${(s.share * 100).toFixed(2)} % of the time, ${s.overBudget} over 5 ms` +
        (starts.count ? `; ${starts.count} start${starts.count === 1 ? "" : "s"}, slowest ${ms(starts.maxMs)} ms` : ""),
    );
  }

  /** At the end of a drive: the road corrections map matching sent the navigator, and how many it refused. */
  private noteRoadCorrections(): void {
    const s = this.nav?.stats;
    if (!s || this.loop === "open") return;
    const heading = s.roadHeadingAccepted + s.roadHeadingRejected;
    const position = s.roadPositionAccepted + s.roadPositionRejected;
    if (heading === this.notedRoad.heading && position === this.notedRoad.position) return;
    this.notedRoad = { heading, position };
    this.note(
      `mm loop ${this.loop}: road heading ${s.roadHeadingAccepted} (${s.roadHeadingRejected} refused), ` +
        `road position ${s.roadPositionAccepted} (${s.roadPositionRejected} refused)`,
    );
  }

  private outageInfo(p: PositionEstimate): SimulatedOutage | undefined {
    const o = this.outage;
    if (!o) return undefined;
    const h = o.hidden;
    const truth =
      h && isSatelliteRecord(h) && h.hAccM <= OUTAGE_TRUTH_MAX_ACC_M && this.clock.nowMs() - h.utcUs / 1000 <= OUTAGE_TRUTH_MAX_AGE_MS
        ? { lat: h.latDeg, lon: h.lonDeg, accuracyM: h.hAccM, timestamp: h.utcUs / 1000 }
        : undefined;
    const errorM = truth ? haversineM(p, truth) : undefined;
    if (errorM !== undefined) o.maxErrorM = Math.max(o.maxErrorM, errorM);
    const nav = this.nav;
    return {
      startedAt: o.startedAt,
      ...(nav && o.startDistanceM !== null ? { distanceM: Math.max(0, nav.stats.obdDistanceM - o.startDistanceM) } : {}),
      ...(truth ? { gnss: truth, errorM, maxErrorM: o.maxErrorM } : {}),
    };
  }

  private logPosition(p: PositionEstimate, behindUs: number): void {
    if (!this.deps.log) return;
    const nav = this.nav;
    const params = nav?.params;
    this.deps.log({
      timestampUs: this.deps.nowUs(),
      latDeg: p.lat,
      lonDeg: p.lon,
      accuracyM: p.accuracyM,
      headingRad: p.headingRad ?? NaN,
      headingSigmaRad: nav?.estimate()?.headingSigmaRad ?? NaN,
      speedMps: p.speedMps ?? NaN,
      speedScale: params?.ks ?? NaN,
      gnssLagS: nav?.gnssLagS ?? NaN,
      behindUs,
      mode: nav?.mode ?? "none",
      source: p.source,
      trust: p.trust,
      parkedPose: this.poseStatus,
    });
    const mm = nav?.estimate()?.mapMatch;
    if (!mm || !this.deps.logMapMatch) return;
    this.deps.logMapMatch({
      timestampUs: this.deps.nowUs(),
      state: mm.state,
      particles: mm.particles,
      clusters: mm.clusters.length,
      updateUs: mm.updateMs * 1000,
      updates: { count: this.interval.count, totalUs: this.interval.totalMs * 1000, maxUs: this.interval.maxMs * 1000 },
      graphBuilt: this.graph?.builtAt ?? 0,
      top: mm.clusters.slice(0, MAPMATCH_TOP).map((c) => ({
        weight: c.weight,
        latDeg: c.lat,
        lonDeg: c.lon,
        headingRad: c.headingRad,
        spreadM: c.spreadM,
      })),
    });
    this.interval = { count: 0, totalMs: 0, maxMs: 0 };
  }
}

/** `d` metres from `p` along `headingRad` (unchanged without a heading). */
function ahead(p: { lat: number; lon: number }, headingRad: number | undefined, d: number): { lat: number; lon: number } {
  if (headingRad === undefined || d === 0) return { lat: p.lat, lon: p.lon };
  const lat = p.lat + ((d * Math.cos(headingRad)) / EARTH_RADIUS_M) * (180 / Math.PI);
  const lon = p.lon + ((d * Math.sin(headingRad)) / (EARTH_RADIUS_M * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI);
  return { lat, lon };
}

/** Compass heading minus the EKF heading now, degrees (null: either unknown). */
function compassOff(nav: Navigator): number | null {
  const compass = nav.compassHeading;
  const heading = nav.estimate()?.headingRad;
  if (!compass || heading === undefined) return null;
  return Math.atan2(Math.sin(compass.psi - heading), Math.cos(compass.psi - heading)) * DEG;
}

function percentile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

/** A stored pose gets some slack: the car settles, and the saved σ came from a converged filter. */
function widen(p: ParkedPose): ParkedPose {
  return {
    ...p,
    posSigmaM: Math.hypot(p.posSigmaM, POSE_POSITION_SLACK_M),
    headingSigmaRad: Math.hypot(p.headingSigmaRad, POSE_HEADING_SLACK_RAD),
  };
}
