// The Stage 1 navigator in the app (NAVIGATOR-SPEC §9): phone GNSS + IMU from SensorService and
// OBD speed from the vehicle link, fused by `Navigator` into the map's position. Without OBD
// speed it shows phone GNSS as before, because dead reckoning needs the car's speed.

import * as Location from "expo-location";

import type { NavConfig, NavMode, ParkedPose } from "@/nav/navigator";
import { Navigator } from "@/nav/navigator";
import type { PositionEstimate, PositionSourceKind } from "@/nav/position/types";
import type { GnssFix, ImuSample, ObdSpeedSample } from "@/nav/types";
import type { EngineState, SpeedSample, VehicleLinkSnapshot } from "@/obd/types";
import { isSatelliteRecord, mapFixToPosition } from "@/services/position/gnss-position-source";
import { GnssTrustTracker } from "@/services/position/gnss-trust";
import type { PositionSource } from "@/services/position/position-source";
import type { SensorService } from "@/services/sensor-capture/sensor-service";
import { GNSS_FLAGS, type GnssRecord, type ImuMotionRecord, type NavEstimateRecord } from "@/triplog/schema";

import type { CalibrationStore } from "./calibration-store";

const OWNER = "navigator";
const TICK_MS = 500;
/** Inputs are held this long and fed in time order: IMU arrives in 100 ms batches, fixes ~50 ms late. */
export const REORDER_US = 300_000;
/** A fix delivered later than this behind the navigator is dropped (its state history spans 3 s). */
const LATE_FIX_MAX_US = 2_000_000;
/** Without OBD speed for this long the map falls back to phone GNSS (the EKF's speed has drifted). */
const OBD_TIMEOUT_US = 10_000_000;
/** A satellite fix accepted this recently makes the position "fused" rather than "dr". */
const FUSED_WINDOW_US = 3_000_000;
/** Draw the position up to this far ahead of the navigator, which runs `REORDER_US` behind. */
const MAX_EXTRAPOLATE_S = 1;
const SAVE_EVERY_MS = 30_000;
/** Note a saved speed scale in the trip log when it moved this much. */
const SPEED_SCALE_NOTE_STEP = 0.002;
const EARTH_RADIUS_M = 6_371_000;
/** Added to a stored parked pose's 1σ: the car settles, the phone may sit differently in the mount. */
const POSE_POSITION_SLACK_M = 5;
const POSE_HEADING_SLACK_RAD = (2 * Math.PI) / 180;

export interface NavigatorLink {
  onSpeed(listener: (s: SpeedSample) => void): () => void;
  onEngineState(listener: (e: EngineState, tUs: number) => void): () => void;
  getSnapshot(): Pick<VehicleLinkSnapshot, "vehicle">;
  /** The connected car's VIN, else the one auto-connect expects (known before the adapter connects). */
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
}

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
  nav?: Partial<NavConfig>;
}

type Input = { tUs: number; imu: ImuSample } | { tUs: number; obd: ObdSpeedSample } | { tUs: number; fix: GnssFix };

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
  private timer: ReturnType<typeof setInterval> | null = null;
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

  constructor(deps: NavigatorServiceDeps) {
    this.deps = deps;
  }

  getSnapshot = (): PositionEstimate | null => this.position;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getPermission = (): Promise<Location.LocationPermissionResponse> => Location.getForegroundPermissionsAsync();

  requestPermission = (): Promise<Location.LocationPermissionResponse> => Location.requestForegroundPermissionsAsync();

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
    this.lastSaveAt = Date.now();
    const pose = nav.parkedPose;
    if (pose && this.vin) {
      this.deps.calibration.saveParkedPose(this.vin, pose);
      if (!this.poseStored) this.note(`nav parked pose saved (heading ±${((pose.headingSigmaRad * 180) / Math.PI).toFixed(1)}°)`);
      this.poseStored = true;
    }
    const lag = nav.gnssLagEstimate;
    if (lag && this.deps.calibration.saveGnssLag(lag)) this.note(`nav gnss lag saved ${lag.lagS} s (${lag.windows} turn windows)`);
    const params = nav.params;
    if (!params || !this.vin || !this.deps.calibration.saveSpeedScale(this.vin, params.ks, params.ksVar)) return;
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
      sensors.gnss.on((r) => this.onGnss(r)),
      sensors.imu.on((batch) => this.onImu(batch.motion)),
      link.onSpeed((s) => this.onSpeed(s)),
      link.onEngineState((state) => {
        // Parked: keep the pose for the next start, even if the app is killed later.
        if (state !== "engine-off" && state !== "ignition-off") return;
        this.flush(this.deps.nowUs() - REORDER_US);
        this.saveCalibration();
      }),
    );
    this.lastSaveAt = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private detach(): void {
    this.flush(Infinity);
    this.saveCalibration();
    this.unsubscribers.forEach((u) => u());
    this.unsubscribers = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // A later start begins afresh: the car may have moved meanwhile.
    this.nav = null;
    this.pending = [];
    this.setMode("none");
  }

  private createNavigator(): void {
    const { calibration, link } = this.deps;
    const lag = calibration.gnssLag();
    const nav = new Navigator({ ...this.deps.nav, ...(lag ? { gnssLagS: lag.lagS } : {}) });
    this.nav = nav;
    if (lag) this.note(`nav gnss lag ${lag.lagS} s from storage (${lag.windows} turn windows)`);
    this.fedUs = -Infinity;
    this.lastAcceptedSatUs = -Infinity;
    this.trustedDistanceM = null;
    this.vin = null;
    this.poseStatus = "none";
    // Known before the adapter connects: the car of the adapter auto-connect will use.
    const vin = link.expectedVin();
    if (!vin) return;
    this.setVehicle(vin);
    const pose = calibration.parkedPose(vin);
    this.poseStored = pose !== null;
    if (pose && nav.startFromPose(widen(pose))) {
      this.poseStatus = "unverified";
      this.note(`nav mode dr (parked pose, ${Math.round((Date.now() - pose.savedAt) / 60_000)} min old)`);
    }
  }

  /** The connected car's VIN: the first one applies its speed scale; another car starts a new navigator. */
  private checkVehicle(): void {
    const vin = this.deps.link.getSnapshot().vehicle?.vin ?? null;
    if (!vin || vin === this.vin) return;
    if (this.vin) {
      // Not the car expected (or another car): what this navigator learned may belong to either.
      this.note("nav vehicle changed: restart");
      this.createNavigator();
    } else {
      this.setVehicle(vin);
    }
  }

  private setVehicle(vin: string): void {
    this.vin = vin;
    const ks = this.deps.calibration.speedScale(vin);
    if (ks && this.nav) {
      this.nav.setSpeedScalePrior(ks.ks, ks.ksVar);
      this.note(`nav speed scale ${ks.ks.toFixed(4)} from storage`);
    }
  }

  // ---- inputs ----

  private onGnss(r: GnssRecord): void {
    if (!Number.isFinite(r.latDeg) || !Number.isFinite(r.lonDeg)) return;
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

  private onImu(motion: ImuMotionRecord[]): void {
    for (const m of motion) {
      this.pending.push({ tUs: m.timestampUs, imu: { tUs: m.timestampUs, gyro: m.gyro, gravity: m.gravity, userAccel: m.userAccel } });
    }
    this.flush(this.deps.nowUs() - REORDER_US);
  }

  private onSpeed(s: SpeedSample): void {
    this.lastObdUs = s.tUs;
    if (s.raw > 0 && this.poseStored) {
      // Driving: the stored pose is stale until the next stop.
      this.deps.calibration.clearParkedPose();
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
        if (out.status === "accepted" && input.fix.speedMps !== undefined) this.lastAcceptedSatUs = input.tUs;
        if (out.status === "init") this.note(`nav mode dr (${out.initMethod})`);
        if (out.pose) this.poseStatus = out.pose;
        if (out.pose === "confirmed") this.note("nav parked pose confirmed");
        if (out.pose === "rejected") {
          this.note(`nav parked pose rejected: fix ${Math.round(out.errorM ?? 0)} m away (±${Math.round(input.fix.hAccM)} m)`);
          this.deps.calibration.clearParkedPose();
          this.poseStored = false;
        }
      } else if (late) {
        continue;
      } else if ("imu" in input) {
        nav.onImu(input.imu);
      } else {
        nav.onObdSpeed(input.obd);
      }
      this.fedUs = Math.max(this.fedUs, input.tUs);
    }
  }

  private tick(): void {
    this.checkVehicle();
    this.flush(this.deps.nowUs() - REORDER_US);
    this.publish();
    if (Date.now() - this.lastSaveAt >= SAVE_EVERY_MS) this.saveCalibration();
  }

  // ---- output ----

  private publish(): void {
    const now = Date.now();
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
    let { lat, lon } = estimate;
    const speed = estimate.speedMps;
    const heading = dr ? estimate.headingRad : trust === "TRUSTED" && fix && Number.isFinite(fix.courseRad) ? fix.courseRad : undefined;
    if (dr && speed !== undefined && heading !== undefined) {
      // The navigator runs a reorder window behind: draw the car where it is now.
      const d = speed * Math.min(Math.max(0, (nowUs - estimate.tUs) / 1e6), MAX_EXTRAPOLATE_S);
      lat += ((d * Math.cos(heading)) / EARTH_RADIUS_M) * (180 / Math.PI);
      lon += ((d * Math.sin(heading)) / (EARTH_RADIUS_M * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI);
    }
    this.set(
      {
      lat,
      lon,
      headingRad: heading,
      speedMps: speed,
      accuracyM: estimate.accuracyM,
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
  }

  private note(text: string): void {
    this.deps.note?.(text);
  }

  /** `behindUs`: how far the navigator's state lags now (the drawn position is extrapolated over it). */
  private set(position: PositionEstimate, behindUs = 0): void {
    this.position = position;
    this.logPosition(position, behindUs);
    this.listeners.forEach((listener) => listener());
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
  }
}

/** A stored pose gets some slack: the car settles, and the saved σ came from a converged filter. */
function widen(p: ParkedPose): ParkedPose {
  return {
    ...p,
    posSigmaM: Math.hypot(p.posSigmaM, POSE_POSITION_SLACK_M),
    headingSigmaRad: Math.hypot(p.headingSigmaRad, POSE_HEADING_SLACK_RAD),
  };
}
