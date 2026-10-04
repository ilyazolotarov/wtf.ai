// Stage 1 navigator: phone IMU + OBD speed + CoreLocation → fused position (SPEC §3.2–3.6).
// Pure TS, event-driven: feed samples in time order (live services or the replay harness).
//
// Modes:
// - none: no fix yet.
// - anchored: position = best recent fix; the heading is unknown, so the uncertainty
//   radius grows by the distance driven (OBD) since that fix.
// - dr: the EKF runs (initialized from a GNSS course, from fitting the gyro/OBD track
//   shape to coarse fixes when jamming leaves no course, from the pose saved when parked, or
//   from map matching the track to the roads).

import { GnssLagEstimator, type GnssLagConfig, type GnssLagEstimate } from "./calibration/gnss-lag";
import { DEFAULT_EKF_CONFIG, DrEkf, wrapAngle, type EkfConfig } from "./ekf/dr-ekf";
import { alignHeading, type AlignConfig, type AlignPoint } from "./ekf/heading-align";
import type { Coordinate } from "./geo";
import { LocalFrame } from "./geo/local-frame";
import type { EdgeId, RoadGraph } from "./mapmatch/graph/road-graph";
import { ParticleFilter, type MapMatchConfig, type MapMatchState } from "./mapmatch/particle-filter";
import { ImuProcessor, type ImuConfig } from "./odometry/imu/imu-processor";
import { OdometryChunker, type OdometryStep } from "./odometry/odometry-output";
import { isSatelliteFix, type GnssFix, type ImuSample, type ObdSpeedSample } from "./types";

export type NavMode = "none" | "anchored" | "dr";

/** How the EKF got its heading: GNSS course, alignment to coarse fixes, parked pose, or the road map. */
export type InitMethod = "course" | "alignment" | "pose" | "map";

export interface NavConfig {
  /** CoreLocation position/course lag behind OBD/IMU until the online estimate is ready (or always,
   *  with `estimateGnssLag: false`). Measured on 7 drives (iPhone 13): −0.1 ± 0.1 s. */
  gnssLagS: number;
  /** Measure the lag on the device from turns (calibration/gnss-lag.ts). */
  estimateGnssLag: boolean;
  /** CoreLocation speed (Doppler, smoothed) lags OBD by this much (measured 1.0 s). */
  gnssSpeedLagS: number;
  /** Ignore fixes worse than this (cell-level fixes claim up to 150 km). */
  maxFixAccuracyM: number;
  /** Innovation gate (χ², 2 dof for position). */
  gate: number;
  /** Consecutive rejected satellite fixes that reset the EKF (it has diverged). */
  resetAfterRejected: number;
  obdSigmaMps: number;
  /** OBD reads 0 below ~2–3 km/h, so a zero is a weak measurement unless the IMU agrees. */
  obdZeroSigmaMps: number;
  /** Standstill = OBD 0 and a quiet IMU for this long. */
  standstillUs: number;
  /** OBD speed older than this is unknown (link lost); the parked poll runs at 1 Hz. */
  obdStaleUs: number;
  /** Init from a GNSS course needs at least this speed and course accuracy. */
  courseInitMinSpeedMps: number;
  courseInitMaxAccRad: number;
  courseUpdateMinSpeedMps: number;
  /** Alignment fixes older than this are dropped. */
  alignWindowUs: number;
  /** Alignment fixes closer than this along the relative track count as one place. */
  alignMinSpacingM: number;
  /** Re-anchor the local frame beyond this distance from its origin. */
  reanchorM: number;
  /** A parked pose is confirmed by a fix at least this accurate that agrees with it… */
  poseConfirmAccuracyM: number;
  /** …after driving this far: a fix taken while parked says nothing about the heading. */
  poseConfirmDistanceM: number;
  ekf: Partial<EkfConfig>;
  gnssLag: Partial<GnssLagConfig>;
  imu: Partial<ImuConfig>;
  align: Partial<AlignConfig>;
}

export const DEFAULT_NAV_CONFIG: NavConfig = {
  gnssLagS: 0,
  estimateGnssLag: true,
  gnssSpeedLagS: 1.0,
  maxFixAccuracyM: 2000,
  gate: 16,
  resetAfterRejected: 5,
  obdSigmaMps: 0.3,
  obdZeroSigmaMps: 0.8,
  standstillUs: 2_000_000,
  obdStaleUs: 2_500_000,
  // Pulling away, CoreLocation's course can be off by tens of degrees while claiming ±18°.
  courseInitMinSpeedMps: 5,
  courseInitMaxAccRad: (10 * Math.PI) / 180,
  courseUpdateMinSpeedMps: 4,
  alignWindowUs: 15 * 60_000_000,
  alignMinSpacingM: 25,
  reanchorM: 5000,
  poseConfirmAccuracyM: 100,
  poseConfirmDistanceM: 150,
  ekf: {},
  gnssLag: {},
  imu: {},
  align: {},
};

export interface NavEstimate {
  tUs: number;
  mode: Exclude<NavMode, "none">;
  lat: number;
  lon: number;
  /** ~68 % radius, m (comparable to CoreLocation's horizontal accuracy). */
  accuracyM: number;
  headingRad?: number;
  headingSigmaRad?: number;
  speedMps?: number;
  /** Map matching (MAPMATCH-SPEC §6.2), when a road graph is set and the filter runs. */
  mapMatch?: MapMatchEstimate;
}

export interface MapMatchEstimate {
  state: MapMatchState;
  /** Up to 5 hypotheses, heaviest first. */
  clusters: { weight: number; lat: number; lon: number; headingRad: number; spreadM: number; edge: EdgeId | null; particles: number }[];
  particles: number;
  updateMs: number;
}

/** The road graph as the navigator needs it: the filter's view plus the shared local frame. */
export type MapMatchGraph = RoadGraph & { setFrame(frame: LocalFrame): void };

/** Off-road this long (m, filter weight mostly off the graph) restarts the filter around the EKF. */
const MAP_MATCH_REINIT_OFFROAD_M = 300;
/** Odometry below this speed counts as stopped: the EKF speed decays towards 0 without reaching it. */
const STOPPED_SPEED_MPS = 0.2;

/** Vehicle pose while parked: the next session starts from it (SPEC §3.3 startup). */
export interface ParkedPose {
  lat: number;
  lon: number;
  /** Clockwise from north. */
  headingRad: number;
  /** 1σ. */
  posSigmaM: number;
  headingSigmaRad: number;
}

export type FixStatus = "init" | "accepted" | "rejected" | "anchored" | "skipped";

export interface FixOutcome {
  status: FixStatus;
  /** Distance from the predicted position at the fix time, before the update (mode dr). */
  errorM?: number;
  /** Predicted 1σ at the fix time, m. */
  predictedSigmaM?: number;
  nis?: number;
  initMethod?: "course" | "alignment";
  /** A pose from `startFromPose`: the first good fix that agrees confirms it; one that disagrees drops it. */
  pose?: "confirmed" | "rejected";
}

/** Short state history for lag-corrected GNSS updates. */
class History {
  private rows: { t: number; v: number[] }[] = [];
  private readonly spanUs: number;
  constructor(spanUs: number) {
    this.spanUs = spanUs;
  }
  push(t: number, v: number[]): void {
    this.rows.push({ t, v });
    while (this.rows.length > 2 && this.rows[1].t < t - this.spanUs) this.rows.shift();
  }
  /** Linear interpolation (angles at index `angleIndex` unwrapped); clamps to the ends. */
  at(t: number, angleIndex = -1): number[] | null {
    const rows = this.rows;
    if (rows.length === 0) return null;
    if (t <= rows[0].t) return rows[0].v;
    if (t >= rows[rows.length - 1].t) return rows[rows.length - 1].v;
    let lo = 0;
    let hi = rows.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = rows[lo];
    const b = rows[hi];
    const f = (t - a.t) / (b.t - a.t || 1);
    return a.v.map((va, i) => (i === angleIndex ? va + f * wrapAngle(b.v[i] - va) : va + f * (b.v[i] - va)));
  }
  shift(dE: number, dN: number): void {
    for (const r of this.rows) {
      r.v[0] -= dE;
      r.v[1] -= dN;
    }
  }
  clear(): void {
    this.rows = [];
  }
}

const SQRT_68 = 1.5;
const fixSigma = (f: GnssFix) => (isSatelliteFix(f) ? f.hAccM / SQRT_68 : f.hAccM);

export interface NavStats {
  imuInvalidS: number;
  standstillS: number;
  obdDistanceM: number;
  resets: number;
}

export class Navigator {
  readonly config: NavConfig;
  private imu: ImuProcessor;
  private frame: LocalFrame | null = null;
  private ekf: DrEkf | null = null;
  private ekfHistory = new History(3_000_000);

  private lastTUs: number | null = null;
  private lastYaw: { tUs: number; rate: number; valid: boolean } | null = null;
  private lastObd: ObdSpeedSample | null = null;
  private quietSinceUs: number | null = null;
  private lastBiasUpdateUs = -Infinity;
  private standstill = false;

  // Relative track (arbitrary rotation) for alignment before the heading is known.
  private rel = { e: 0, n: 0, psi: 0, bias: 0 };
  private relHistory = new History(3_000_000);
  private alignPoints: (AlignPoint & { tUs: number })[] = [];

  private anchor: { coord: Coordinate; sigma: number; distanceM: number } | null = null;
  private lastFix: GnssFix | null = null;
  private rejectedSat = 0;
  /** Speed scale for the next EKF start: a stored per-car value, or the one learned before a reset. */
  private speedScale: { ks: number; ksVar: number } | null = null;
  /** The EKF started from a parked pose that no fix has confirmed yet (OBD distance at the start). */
  private poseUnverifiedFromM: number | null = null;
  private lagEstimator: GnssLagEstimator;
  private readonly ekfConfig: EkfConfig;
  private odometryListeners: ((step: OdometryStep) => void)[] = [];
  private readonly odometry = new OdometryChunker((step) => {
    for (const listener of this.odometryListeners) listener(step);
  });
  private mapGraph: MapMatchGraph | null = null;
  private pf: ParticleFilter | null = null;
  private mapMatchListening = false;
  /** Odometry distance where the filter's weight went mostly off-road (null: on the roads). */
  private offRoadFromM: number | null = null;
  /** Unknown-heading start (MAPMATCH-SPEC §8): odometry distance since the filter tracks, next check. */
  private trackingFromM: number | null = null;
  private nextMapStartCheckM = 0;
  /** Start the EKF from the map at the end of the current step. */
  private mapStartDue = false;
  private started: { method: InitMethod; tUs: number } | null = null;
  readonly stats: NavStats = { imuInvalidS: 0, standstillS: 0, obdDistanceM: 0, resets: 0 };

  constructor(config: Partial<NavConfig> = {}) {
    this.config = { ...DEFAULT_NAV_CONFIG, ...config };
    this.ekfConfig = { ...DEFAULT_EKF_CONFIG, ...this.config.ekf };
    this.imu = new ImuProcessor(this.config.imu);
    this.lagEstimator = new GnssLagEstimator(this.config.gnssLag);
  }

  /**
   * Calibrated odometry in chunks of ≤ 2 m / 0.2 s (MAPMATCH-SPEC §6.1), for the map-matching
   * particle filter. Computed only while someone listens. Returns the unsubscribe function.
   */
  subscribeOdometry(listener: (step: OdometryStep) => void): () => void {
    this.odometryListeners.push(listener);
    return () => {
      this.odometryListeners = this.odometryListeners.filter((l) => l !== listener);
    };
  }

  /**
   * Map matching (MAPMATCH-SPEC §7, §8): a road-constrained particle filter runs on this navigator's
   * odometry and fixes. Anchored (heading unknown) it starts from all roads around the anchor, and
   * once it tracks one hypothesis long enough it starts the EKF (`initialization.method` "map"). In
   * mode dr it runs open loop: its hypotheses appear in `estimate().mapMatch`, nothing goes back
   * into the EKF yet. Null switches it off.
   */
  setRoadGraph(graph: MapMatchGraph | null, config: Partial<MapMatchConfig> = {}): void {
    this.mapGraph = graph;
    this.pf = graph ? new ParticleFilter(graph, config) : null;
    this.offRoadFromM = null;
    this.trackingFromM = null;
    if (!graph) return;
    if (this.frame) graph.setFrame(this.frame);
    if (!this.mapMatchListening) {
      this.mapMatchListening = true;
      this.odometryListeners.push((step) => this.mapMatchOdometry(step));
    }
    if (this.ekf) this.startMapMatch();
    else this.startMapMatchAtAnchor();
  }

  /** How and when the EKF last started (null: not running). */
  get initialization(): { method: InitMethod; tUs: number } | null {
    return this.ekf ? this.started : null;
  }

  /** The particle filter, for replay metrics (null without a road graph). */
  get mapMatcher(): ParticleFilter | null {
    return this.pf;
  }

  /** Particles as [lat, lon, weight, off-road 1/0], heaviest first (viewer). */
  mapMatchParticles(max: number): [number, number, number, number][] {
    if (!this.pf?.isActive || !this.frame) return [];
    const frame = this.frame;
    return this.pf.particles(max).map((p) => {
      const c = frame.toCoordinate(p.e, p.n);
      return [c.lat, c.lon, p.w, p.offRoad ? 1 : 0];
    });
  }

  /** Hand out the odometry summed since the last chunk (end of input). */
  flushOdometry(): void {
    this.odometry.flush();
  }

  get mode(): NavMode {
    return this.ekf ? "dr" : this.anchor ? "anchored" : "none";
  }

  get isStandstill(): boolean {
    return this.standstill;
  }

  /** GNSS lag in use, s: the online estimate once ready, else the configured default. */
  get gnssLagS(): number {
    const estimate = this.config.estimateGnssLag ? this.lagEstimator.estimate() : null;
    return estimate?.lagS ?? this.config.gnssLagS;
  }

  /** Online GNSS lag estimate (store it per phone model to start the next session with it). */
  get gnssLagEstimate(): GnssLagEstimate | null {
    return this.lagEstimator.estimate();
  }

  /** Learned parameters (speed scale, gyro bias/scale) while the EKF runs. */
  get params() {
    return this.ekf?.params() ?? null;
  }

  /** Start the EKF from a speed scale learned earlier (stored per car). Applies at the next EKF start. */
  setSpeedScalePrior(ks: number, ksVar: number): void {
    this.speedScale = { ks, ksVar };
  }

  onImu(s: ImuSample): void {
    const out = this.imu.process(s);
    // With the engine off the poller reads speed once a second.
    const lastObdZero = this.lastObd !== null && this.lastObd.rawKph === 0 && s.tUs - this.lastObd.tUs < 2_500_000;
    if (out.quiet && lastObdZero) this.quietSinceUs ??= s.tUs;
    else this.quietSinceUs = null;
    this.standstill = this.quietSinceUs !== null && s.tUs - this.quietSinceUs >= this.config.standstillUs;

    this.advance(s.tUs, out.valid ? out.yawRate : null);
    this.lastYaw = { tUs: s.tUs, rate: out.yawRate, valid: out.valid };

    if (this.standstill && s.tUs - this.lastBiasUpdateUs >= 1_000_000) {
      this.lastBiasUpdateUs = s.tUs;
      if (this.ekf) this.ekf.updateGyroBias(out.windowMeanYaw, 0.002, this.config.gate);
      else this.rel.bias += 0.3 * (out.windowMeanYaw - this.rel.bias);
    }
  }

  onObdSpeed(s: ObdSpeedSample): void {
    this.advance(s.tUs, this.heldYaw(s.tUs));
    this.lastObd = s;
    if (!this.ekf) return;
    if (this.standstill) this.ekf.updateZeroSpeed(0.02);
    else this.ekf.updateObdSpeed(s.speedMps, s.rawKph === 0 ? this.config.obdZeroSigmaMps : this.config.obdSigmaMps);
  }

  onGnss(fix: GnssFix): FixOutcome {
    const c = this.config;
    if (fix.hAccM > c.maxFixAccuracyM || !(fix.hAccM > 0)) return { status: "skipped" };
    // Under jamming iOS repeats the same Wi-Fi position; repeats carry no new information.
    // (A parked satellite fix repeats too, but that one is a real measurement.)
    if (!isSatelliteFix(fix) && this.lastFix && this.lastFix.lat === fix.lat && this.lastFix.lon === fix.lon) {
      return { status: "skipped" };
    }
    this.lastFix = fix;
    this.advance(fix.tUs, this.heldYaw(fix.tUs));
    const frame = this.frame ?? this.setFrame(new LocalFrame(fix));
    const [fE, fN] = frame.toEnu(fix);
    this.lagEstimator.onFix(fix.tUs, fix, fix.hAccM, isSatelliteFix(fix));
    const tRef = fix.tUs - this.gnssLagS * 1e6;
    const sigma = fixSigma(fix);
    // The filter must be at the fix time before it weighs the fix.
    if (this.pf) this.odometry.flush();
    const outcome = this.ekf ? this.updateEkf(fix, fE, fN, tRef, sigma) : this.updateBeforeInit(fix, fE, fN, tRef, sigma);
    const pf = this.pf;
    if (pf && outcome.status === "anchored") {
      // Heading unknown: every fix counts (there is no gate yet).
      if (!pf.isActive) this.startMapMatchAtAnchor();
      if (pf.isActive && !pf.onFix(fE, fN, sigma, !isSatelliteFix(fix), this.gnssLagS)) this.startMapMatchAtAnchor();
      else if (pf.isActive && this.anchor) {
        const [aE, aN] = frame.toEnu(this.anchor.coord);
        pf.setSearchRegion(aE, aN, pf.config.initSigmas * this.anchor.sigma + this.anchor.distanceM);
      }
    } else if (pf?.isActive && (outcome.status === "accepted" || outcome.status === "init") && !pf.onFix(fE, fN, sigma, !isSatelliteFix(fix), this.gnssLagS)) {
      // The fix agrees with the EKF but not with any particle: the filter lost the car.
      this.startMapMatch();
    }
    return outcome;
  }

  estimate(): NavEstimate | null {
    if (this.lastTUs === null) return null;
    if (this.ekf && this.frame) {
      const coord = this.frame.toCoordinate(this.ekf.east, this.ekf.north);
      const heading = this.ekf.psi < 0 ? this.ekf.psi + 2 * Math.PI : this.ekf.psi;
      return {
        tUs: this.lastTUs,
        mode: "dr",
        ...coord,
        accuracyM: SQRT_68 * this.ekf.positionSigma,
        headingRad: heading,
        headingSigmaRad: this.ekf.psiSigma,
        speedMps: Math.max(0, this.ekf.speed),
        ...(this.pf?.isActive ? { mapMatch: this.mapMatchEstimate(this.frame) } : {}),
      };
    }
    if (this.anchor) {
      return {
        tUs: this.lastTUs,
        mode: "anchored",
        ...this.anchor.coord,
        accuracyM: SQRT_68 * this.anchor.sigma + this.anchor.distanceM,
        speedMps: this.lastObd?.speedMps,
        ...(this.pf?.isActive && this.frame ? { mapMatch: this.mapMatchEstimate(this.frame) } : {}),
      };
    }
    return null;
  }

  /** Pose to start the next session from, while the car stands (null: moving, or heading unknown). */
  get parkedPose(): ParkedPose | null {
    const o = this.lastObd;
    const parked = this.standstill || (o !== null && o.rawKph === 0 && this.lastTUs !== null && this.lastTUs - o.tUs < this.config.obdStaleUs);
    if (!parked || !this.ekf || !this.frame) return null;
    const psi = this.ekf.psi < 0 ? this.ekf.psi + 2 * Math.PI : this.ekf.psi;
    return { ...this.frame.toCoordinate(this.ekf.east, this.ekf.north), headingRad: psi, posSigmaM: this.ekf.positionSigma, headingSigmaRad: this.ekf.psiSigma };
  }

  /**
   * Start dead reckoning from a pose saved when parked, before any fix. Until a fix confirms it, a fix
   * that disagrees (the car was moved, or it's another car) drops it. Returns false when the EKF already
   * runs or the fixes so far disagree with the pose.
   */
  startFromPose(pose: ParkedPose): boolean {
    if (this.ekf) return false;
    if (this.anchor) {
      const d = this.frame!.toEnu(pose);
      const a = this.frame!.toEnu(this.anchor.coord);
      const sigma = Math.hypot(this.anchor.sigma + this.anchor.distanceM, pose.posSigmaM);
      if (Math.hypot(d[0] - a[0], d[1] - a[1]) > Math.sqrt(this.config.gate) * sigma) return false;
    }
    const frame = this.frame ?? this.setFrame(new LocalFrame(pose));
    const [e, n] = frame.toEnu(pose);
    const theta = wrapAngle(this.rel.psi - pose.headingRad);
    const cs = Math.cos(theta);
    const sn = Math.sin(theta);
    this.initEkf(theta, e - (cs * this.rel.e - sn * this.rel.n), n - (sn * this.rel.e + cs * this.rel.n), pose.posSigmaM, pose.headingSigmaRad, "pose");
    this.poseUnverifiedFromM = this.stats.obdDistanceM;
    return true;
  }

  /** Predicted position at a past time (within ~3 s), for evaluating held-out fixes. */
  positionAt(tUs: number): { coord: Coordinate; sigmaM: number } | null {
    if (!this.ekf || !this.frame) return null;
    const h = this.ekfHistory.at(tUs, 2);
    if (!h) return null;
    return { coord: this.frame.toCoordinate(h[0], h[1]), sigmaM: this.ekf.positionSigma };
  }

  // ---- internals ----

  /** Yaw rate to hold over an interval that has no IMU sample (null = unknown). */
  private heldYaw(tUs: number): number | null {
    const y = this.lastYaw;
    return y && y.valid && tUs - y.tUs < 200_000 ? y.rate : null;
  }

  private advance(tUs: number, yawRate: number | null): void {
    if (this.lastTUs === null) {
      this.lastTUs = tUs;
      return;
    }
    const dt = (tUs - this.lastTUs) / 1e6;
    if (dt <= 0) return;
    this.lastTUs = tUs;
    const obdFresh = this.lastObd !== null && tUs - this.lastObd.tUs < this.config.obdStaleUs;
    const speed = obdFresh ? this.lastObd!.speedMps : 0;
    // A gap in the IMU stream or a handled phone means the rotation is unknown, unless the
    // car stands (OBD 0): then it isn't turning, whatever the phone does.
    const parked = this.lastObd !== null && this.lastObd.rawKph === 0;
    const yaw = dt > 0.2 ? null : yawRate;
    const hold = this.standstill || (yaw === null && parked);
    if (yaw === null && !parked) this.stats.imuInvalidS += dt;
    if (this.standstill) this.stats.standstillS += dt;
    this.stats.obdDistanceM += speed * dt;
    // Without speed the car may still move: grow the radius at the last known speed.
    if (this.anchor) this.anchor.distanceM += (this.lastObd?.speedMps ?? 0) * dt;

    const relRate = hold || yaw === null ? 0 : yaw - this.rel.bias;
    this.rel.psi = wrapAngle(this.rel.psi - relRate * dt);
    this.rel.e += speed * Math.sin(this.rel.psi) * dt;
    this.rel.n += speed * Math.cos(this.rel.psi) * dt;
    this.relHistory.push(tUs, [this.rel.e, this.rel.n, this.rel.psi]);
    if ((yaw === null && !hold) || !obdFresh) {
      // Track shape broken (rotation or distance unknown): start over.
      if (!this.ekf) this.alignPoints = [];
      this.lagEstimator.breakTrack();
    } else {
      this.lagEstimator.onTrack(tUs, this.rel.e, this.rel.n, this.rel.psi, speed);
    }

    if (this.odometryListeners.length) this.addOdometry(tUs, dt, speed, yaw, hold, obdFresh);

    if (this.ekf) {
      // Standing: hold the heading (yaw input = bias → no rotation).
      this.ekf.predict(dt, hold ? this.ekf.params().bw : yaw);
      this.ekfHistory.push(tUs, [this.ekf.east, this.ekf.north, this.ekf.psi, this.ekf.speed]);
      if (this.frame && Math.hypot(this.ekf.east, this.ekf.north) > this.config.reanchorM) this.reanchor();
    }
    // After this step's prediction would have run: the new EKF starts at the state now.
    if (this.mapStartDue) {
      this.mapStartDue = false;
      if (!this.ekf) this.startFromMap();
    }
  }

  /**
   * One odometry increment, from the state before this step's prediction: in mode dr exactly the
   * EKF's own motion (v·dt and −k_ω(ω − b_ω)·dt); before that, OBD × the stored speed scale and the
   * gyro minus the bias learned at stops.
   */
  private addOdometry(tUs: number, dt: number, obdSpeed: number, yaw: number | null, hold: boolean, obdFresh: boolean): void {
    const c = this.ekfConfig;
    const yawUnknown = yaw === null && !hold;
    let ds: number;
    let dpsi: number;
    let kw: number;
    let calibration;
    if (this.ekf) {
      const p = this.ekf.params();
      kw = p.kw;
      ds = Math.max(0, this.ekf.speed) * dt;
      dpsi = hold || yaw === null ? 0 : -p.kw * (yaw - p.bw) * dt;
      calibration = { speedScaleRelSigma: Math.sqrt(p.ksVar) / p.ks, gyroBiasSigma: Math.sqrt(p.bwVar) * p.kw, gyroScaleSigma: Math.sqrt(p.kwVar) };
    } else {
      const ks = this.speedScale?.ks ?? 1;
      kw = 1;
      ds = ks * obdSpeed * dt;
      dpsi = hold || yaw === null ? 0 : -(yaw - this.rel.bias) * dt;
      calibration = {
        speedScaleRelSigma: Math.sqrt(this.speedScale?.ksVar ?? c.initSpeedScaleSigma ** 2) / ks,
        gyroBiasSigma: c.initBiasSigma,
        gyroScaleSigma: c.initYawScaleSigma,
      };
    }
    const white = yawUnknown ? c.handlingYawNoise ** 2 * dt : hold ? 0 : (c.gyroNoise * kw) ** 2 * dt;
    this.odometry.add(
      { tUs, dtS: dt, dsM: ds, dpsiRad: dpsi, dpsiWhiteVar: white, stopped: hold || ds < STOPPED_SPEED_MPS * dt, yawUnknown, speedUnknown: !obdFresh, source: this.ekf ? "ekf" : "relative" },
      calibration,
    );
  }

  private reanchor(): void {
    const ekf = this.ekf!;
    const dE = ekf.east;
    const dN = ekf.north;
    this.setFrame(new LocalFrame(this.frame!.toCoordinate(dE, dN)));
    ekf.shift(dE, dN);
    this.ekfHistory.shift(dE, dN);
    this.pf?.reframe(dE, dN);
  }

  private setFrame(frame: LocalFrame): LocalFrame {
    this.frame = frame;
    this.mapGraph?.setFrame(frame);
    return frame;
  }

  /** (Re)start the filter around the EKF pose (known heading, §7.2). */
  private startMapMatch(): void {
    const ekf = this.ekf;
    if (!this.pf || !ekf) return;
    this.odometry.flush();
    this.offRoadFromM = null;
    this.trackingFromM = null;
    this.pf.init(ekf.east, ekf.north, ekf.positionSigma, ekf.psi, ekf.psiSigma, this.odometry.totals);
  }

  /**
   * Heading unknown (mode anchored): start the filter on every road within the anchor's radius
   * (3σ of the fix plus the distance driven since). Waits while that exceeds the filter's limit.
   */
  private startMapMatchAtAnchor(): void {
    const pf = this.pf;
    const anchor = this.anchor;
    if (!pf || !anchor || !this.frame || this.ekf) return;
    this.odometry.flush();
    this.offRoadFromM = null;
    this.trackingFromM = null;
    this.nextMapStartCheckM = 0;
    const [e, n] = this.frame.toEnu(anchor.coord);
    if (!pf.initUnknown(e, n, pf.config.initSigmas * anchor.sigma + anchor.distanceM, this.odometry.totals)) pf.stop();
  }

  /**
   * An EKF started by a course, alignment or parked pose: keep the filter when it already tracks a
   * hypothesis that fits the new pose (it carries the turns driven so far), else restart it there.
   */
  private mapMatchAgrees(): boolean {
    const pf = this.pf;
    const ekf = this.ekf;
    if (!pf?.isActive || !ekf) return false;
    const out = pf.output();
    const top = out.clusters[0];
    if (out.state !== "tracking" || !top) return false;
    const c = pf.config;
    const d = Math.hypot(top.e - ekf.east, top.n - ekf.north);
    const dPsi = Math.abs(wrapAngle(top.headingRad - ekf.psi));
    return d <= 3 * ekf.positionSigma + c.agreeMarginM && dPsi <= 3 * ekf.psiSigma + c.agreeMarginRad;
  }

  /**
   * The heading is settled (MAPMATCH-SPEC §8): the pose to start the EKF from — the tracked cluster,
   * or the dominant travel direction when the particles agree on it but not yet on the position along
   * the road.
   */
  private mapPose(): { e: number; n: number; spreadM: number; headingRad: number; headingSpreadRad: number } | null {
    const pf = this.pf;
    if (!pf?.isActive) return null;
    const c = pf.config;
    const out = pf.output();
    if (out.state === "tracking" && out.clusters[0]) return out.clusters[0];
    const d = pf.dominantHeading();
    return d.weight >= c.trackingWeight && d.headingSpreadRad <= c.mapStartHeadingSpreadRad && d.spreadM <= c.mapStartSpreadM ? d : null;
  }

  /** Start the EKF from the map (MAPMATCH-SPEC §8): position and heading from the roads. */
  private startFromMap(): void {
    const pf = this.pf;
    const top = this.mapPose();
    if (!pf || !top || !this.frame) return;
    const c = pf.config;
    const theta = wrapAngle(this.rel.psi - top.headingRad);
    const cs = Math.cos(theta);
    const sn = Math.sin(theta);
    this.initEkf(
      theta,
      top.e - (cs * this.rel.e - sn * this.rel.n),
      top.n - (sn * this.rel.e + cs * this.rel.n),
      Math.max(top.spreadM, c.mapStartMinPosSigmaM),
      Math.hypot(Math.max(top.headingSpreadRad, c.mapStartMinHeadingSigmaRad), top.spreadM * c.mapStartCurvatureRadPerM),
      "map",
    );
  }

  private mapMatchOdometry(step: OdometryStep): void {
    const pf = this.pf;
    if (!pf?.isActive) return;
    const ekf = this.ekf;
    pf.onOdometry(step, ekf ? { psi: ekf.psi, psiSigma: ekf.psiSigma, e: ekf.east, n: ekf.north, posSigma: ekf.positionSigma } : null);
    if (step.stopped) return;
    if (!ekf && step.distanceM >= this.nextMapStartCheckM) {
      // Heading unknown: a heading settled over `mapStartTrackingM` starts the EKF.
      this.nextMapStartCheckM = step.distanceM + pf.config.evalIntervalM;
      if (this.mapPose()) {
        this.trackingFromM ??= step.distanceM;
        // Mid-turn, or near a bend of the road polyline, the road heading is not the car's: start on a
        // straight road, driving straight. The car is somewhere within the cloud's spread along it.
        const c = pf.config;
        const pose = this.mapPose();
        if (
          pose &&
          step.distanceM - this.trackingFromM >= c.mapStartTrackingM &&
          pf.isStraight &&
          pf.straightRoadWeight(c.mapStartRoadWindowM + pose.spreadM, c.mapStartRoadStraightRad) >= c.trackingWeight
        ) {
          this.mapStartDue = true;
        }
      } else {
        this.trackingFromM = null;
      }
    }
    if (pf.offRoadWeight() > 0.5) {
      this.offRoadFromM ??= step.distanceM;
      if (step.distanceM - this.offRoadFromM >= MAP_MATCH_REINIT_OFFROAD_M) {
        if (ekf) this.startMapMatch();
        else this.startMapMatchAtAnchor();
      }
    } else {
      this.offRoadFromM = null;
    }
  }

  private mapMatchEstimate(frame: LocalFrame): MapMatchEstimate {
    const out = this.pf!.output();
    return {
      ...out,
      clusters: out.clusters.map(({ e, n, ...c }) => ({ ...c, ...frame.toCoordinate(e, n) })),
    };
  }

  private updateBeforeInit(fix: GnssFix, fE: number, fN: number, tRef: number, sigma: number): FixOutcome {
    const c = this.config;
    if (!this.anchor || SQRT_68 * sigma < SQRT_68 * this.anchor.sigma + this.anchor.distanceM) {
      this.anchor = { coord: { lat: fix.lat, lon: fix.lon }, sigma, distanceM: 0 };
    }
    const relThen = this.relHistory.at(tRef, 2) ?? [this.rel.e, this.rel.n, this.rel.psi];

    // A GNSS course gives the heading directly.
    if (
      isSatelliteFix(fix) &&
      fix.courseRad !== undefined &&
      (fix.speedMps ?? 0) >= c.courseInitMinSpeedMps &&
      (fix.courseAccRad ?? Infinity) <= c.courseInitMaxAccRad
    ) {
      const theta = wrapAngle(relThen[2] - fix.courseRad);
      const cs = Math.cos(theta);
      const sn = Math.sin(theta);
      this.initEkf(theta, fE - (cs * relThen[0] - sn * relThen[1]), fN - (sn * relThen[0] + cs * relThen[1]), sigma, Math.max(fix.courseAccRad ?? 0, (3 * Math.PI) / 180), "course");
      return { status: "init", initMethod: "course" };
    }

    this.alignPoints = this.alignPoints.filter((p) => fix.tUs - p.tUs <= c.alignWindowUs);
    // Fixes taken in one place (parked) have correlated errors: keep only the best of them.
    const point = { tUs: fix.tUs, relE: relThen[0], relN: relThen[1], worldE: fE, worldN: fN, sigma };
    const prev = this.alignPoints.at(-1);
    if (prev && Math.hypot(prev.relE - point.relE, prev.relN - point.relN) < c.alignMinSpacingM) {
      if (point.sigma < prev.sigma) this.alignPoints[this.alignPoints.length - 1] = point;
    } else {
      this.alignPoints.push(point);
    }
    const a = alignHeading(this.alignPoints, c.align);
    if (!a) return { status: "anchored" };
    // Position uncertainty: fit noise plus the heading error over the lever arm from the fixes.
    const n = this.alignPoints.length;
    const cE = this.alignPoints.reduce((s, p) => s + p.relE, 0) / n;
    const cN = this.alignPoints.reduce((s, p) => s + p.relN, 0) / n;
    const lever = Math.hypot(this.rel.e - cE, this.rel.n - cN);
    const fitSigma = 1 / Math.sqrt(this.alignPoints.reduce((s, p) => s + 1 / (p.sigma * p.sigma), 0));
    this.initEkf(a.theta, a.tE, a.tN, Math.hypot(fitSigma, lever * a.thetaSigma), a.thetaSigma, "alignment");
    return { status: "init", initMethod: "alignment" };
  }

  /** Start the EKF at the current relative-track position mapped by rot(θ) + t. */
  private initEkf(theta: number, tE: number, tN: number, posSigma: number, psiSigma: number, method: InitMethod): void {
    const cs = Math.cos(theta);
    const sn = Math.sin(theta);
    this.ekf = new DrEkf(
      {
        east: cs * this.rel.e - sn * this.rel.n + tE,
        north: sn * this.rel.e + cs * this.rel.n + tN,
        psi: wrapAngle(this.rel.psi - theta),
        speed: this.lastObd?.speedMps ?? 0,
        posSigma,
        psiSigma,
        speedSigma: 0.5,
        params: { bw: this.rel.bias, ...this.speedScale },
      },
      this.config.ekf,
    );
    this.ekfHistory.clear();
    if (this.lastTUs !== null) this.ekfHistory.push(this.lastTUs, [this.ekf.east, this.ekf.north, this.ekf.psi, this.ekf.speed]);
    this.alignPoints = [];
    this.poseUnverifiedFromM = null;
    this.anchor = null;
    this.rejectedSat = 0;
    this.started = { method, tUs: this.lastTUs ?? 0 };
    this.trackingFromM = null;
    // Started from the map, the filter carries on; otherwise it is kept only if it agrees.
    if (method !== "map" && !this.mapMatchAgrees()) this.startMapMatch();
  }

  private updateEkf(fix: GnssFix, fE: number, fN: number, tRef: number, sigma: number): FixOutcome {
    const c = this.config;
    const ekf = this.ekf!;
    const h = this.ekfHistory.at(tRef, 2) ?? [ekf.east, ekf.north, ekf.psi, ekf.speed];
    const hv = this.ekfHistory.at(fix.tUs - c.gnssSpeedLagS * 1e6, 2) ?? h;
    const rE = fE - h[0];
    const rN = fN - h[1];
    const predictedSigmaM = ekf.positionSigma;
    const pos = ekf.updatePosition(rE, rN, sigma, c.gate);
    const outcome: FixOutcome = { status: pos.accepted ? "accepted" : "rejected", errorM: Math.hypot(rE, rN), predictedSigmaM, nis: pos.nis };
    const sat = isSatelliteFix(fix);
    if (this.poseUnverifiedFromM !== null) {
      if (!pos.accepted) {
        this.reset(fix, sigma);
        return { ...outcome, pose: "rejected" };
      }
      if (fix.hAccM <= c.poseConfirmAccuracyM && this.stats.obdDistanceM - this.poseUnverifiedFromM >= c.poseConfirmDistanceM) {
        this.poseUnverifiedFromM = null;
        outcome.pose = "confirmed";
      }
    }
    if (!pos.accepted) {
      if (sat && ++this.rejectedSat >= c.resetAfterRejected) this.reset(fix, sigma);
      return outcome;
    }
    if (sat) this.rejectedSat = 0;
    if (sat && fix.speedMps !== undefined) {
      ekf.updateSpeed(fix.speedMps - hv[3], Math.max(fix.speedAccMps ?? 0.5, 0.2), c.gate);
      if (fix.courseRad !== undefined && fix.speedMps >= c.courseUpdateMinSpeedMps && fix.courseAccRad !== undefined) {
        ekf.updateHeading(fix.courseRad - h[2], Math.max(fix.courseAccRad, (2 * Math.PI) / 180), c.gate);
      }
    }
    return outcome;
  }

  /** The EKF disagrees with good fixes: start over, anchored at the latest one. */
  private reset(fix: GnssFix, sigma: number): void {
    // The speed scale is a property of the car, not of the diverged track: keep it.
    const { ks, ksVar } = this.ekf!.params();
    this.speedScale = { ks, ksVar };
    this.anchor = { coord: { lat: fix.lat, lon: fix.lon }, sigma, distanceM: 0 };
    this.ekf = null;
    this.ekfHistory.clear();
    this.alignPoints = [];
    this.rejectedSat = 0;
    this.poseUnverifiedFromM = null;
    this.stats.resets++;
    this.pf?.stop();
    this.startMapMatchAtAnchor();
  }
}
