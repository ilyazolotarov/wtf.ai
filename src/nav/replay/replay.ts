// Replay a trip log through the navigator (SPEC §3.10): fused track, per-fix consistency,
// and DR error during simulated GNSS outages ("cuts"). Pure TS; the CLI is tools/replay.

import type { GnssLagEstimate } from "../calibration/gnss-lag";
import { rotateCalibration, type CompassCalibration, type CompassTrust } from "../compass/compass";
import type { TripLog } from "../../triplog/trip-log-reader";
import { haversineM } from "../geo";
import type { MapMatchConfig } from "../mapmatch/particle-filter";
import { Navigator, SQRT_68, type FixOutcome, type InitMethod, type MapMatchGraph, type NavConfig, type NavEstimate, type ParkedPose } from "../navigator";
import type { OdometryStep } from "../odometry/odometry-output";
import { jamFixes, type JamOptions, type JamWindow } from "./jam";
import { MapMatchMetrics, type MapMatchSummary } from "./mapmatch-metrics";
import type { TruthMatch } from "./truth-match";
import { isSatelliteFix, type GnssFix } from "../types";

export interface ReplayCut {
  /** Seconds since log start. */
  fromS: number;
  toS: number;
  /** Added by `openLoop`: runs from the heading fix to the end of the log. */
  openLoop?: boolean;
}

/**
 * The GNSS outages simulated in the app (NavigatorService test tool), from its `sim gnss outage on`
 * / `off` notes, as cuts: replay withholds the same fixes. One still on at the end runs to the end.
 */
export function appOutageCuts(trip: TripLog): ReplayCut[] {
  const cuts: ReplayCut[] = [];
  let fromS: number | null = null;
  for (const m of trip.messages) {
    const tS = (m.tUs - trip.startUs) / 1e6;
    if (m.text === "sim gnss outage on") fromS = tS;
    else if (m.text.startsWith("sim gnss outage off") && fromS !== null) {
      cuts.push({ fromS, toS: tS });
      fromS = null;
    }
  }
  if (fromS !== null) cuts.push({ fromS, toS: Infinity });
  return cuts;
}

export interface ReplayOptions {
  nav?: Partial<NavConfig>;
  cuts?: ReplayCut[];
  /** Track sampling period, s. */
  trackStepS?: number;
  /** Fixes at least this good serve as ground truth inside cuts. */
  truthAccuracyM?: number;
  /** GNSS lag used to score held-out fixes. Fixed, so variants of the navigator's own lag are
   *  scored against the same yardstick (measured on 7 drives: −0.1 ± 0.1 s). */
  truthLagS?: number;
  /**
   * Open loop: once the heading is first known (EKF init), withhold every later fix,
   * after `delayS` more seconds of normal fusion (lets speed scale and bias settle).
   */
  openLoop?: { delayS: number };
  /** Start from the pose saved at the end of the previous drive (as the app does after parking). */
  startPose?: ParkedPose;
  /** Start the session this many seconds into the log (as if the app started then); times stay log-relative. */
  startAtS?: number;
  /** Simulated jamming (jam.ts): satellite fixes in these windows become coarse ones. */
  jam?: JamWindow[];
  jamOptions?: Partial<JamOptions>;
  /**
   * A compass calibration from other drives (NAVIGATOR-SPEC §7.6); `rotateRad` turns it to simulate a
   * wrong one (the phone turned in its mount, another car).
   */
  compass?: { calibration: CompassCalibration | null; rotateRad?: number };
  /** Receives the navigator's odometry chunks (MAPMATCH-SPEC §6.1). */
  odometry?: (step: OdometryStep) => void;
  /**
   * Run map matching (MAPMATCH-SPEC §7) on this graph. With `truth` (truth-match.ts) the summary gets
   * the §10.2 metrics; `particlesEveryS` keeps particle snapshots for the viewer.
   */
  mapMatch?: { graph: MapMatchGraph; truth?: TruthMatch; config?: Partial<MapMatchConfig>; particlesEveryS?: number };
}

/** Particle positions at one moment: [lat, lon, weight, off-road 1/0] heaviest first. */
export interface ParticleSnapshot {
  tS: number;
  particles: [number, number, number, number][];
}

export interface TrackPoint extends NavEstimate {
  tS: number;
  standstill: boolean;
  /** The OBD speed calibration then (v = k_s·s_OBD + o_s, o_s in m/s), while the EKF runs. */
  ks?: number;
  so?: number;
}

export interface FixRecord {
  tS: number;
  fix: GnssFix;
  satellite: boolean;
  /** "cut" = withheld from the navigator (simulated outage). */
  status: FixOutcome["status"] | "cut";
  errorM?: number;
  predictedSigmaM?: number;
  initMethod?: FixOutcome["initMethod"];
  /** Map matching: distance from the dominant cluster to the fix (held-out fixes in cuts). */
  mapMatchErrorM?: number;
}

export interface CutResult extends ReplayCut {
  /** OBD distance driven inside the cut, m. */
  distanceM: number;
  truthFixes: number;
  maxErrorM: number | null;
  lastErrorM: number | null;
  /** Mean predicted 1σ at the truth fixes, m (is the uncertainty honest?). */
  meanSigmaM: number | null;
  /**
   * Truth fixes inside the circle the map draws (1.5 σ, the ~68 % radius): about 0.68 when the
   * uncertainty is honest, lower when overconfident. Unlike max error ÷ σ, it doesn't penalise an
   * error that stays bounded (corrected by the map) for peaking now and then.
   */
  insideCircle: number | null;
  /** The same for the dominant map-matching cluster (with `mapMatch`), off-road clusters included. */
  mapMatchMaxErrorM: number | null;
  mapMatchLastErrorM: number | null;
}

/** The first EKF start: when, how, after how much driving, and the pose it started with. */
export interface ReplayInit {
  tS: number;
  method: string;
  /** OBD distance driven since the session start, m. */
  distanceM: number;
  estimate: NavEstimate | null;
}

const INIT_NAMES: Record<InitMethod, string> = { course: "course", alignment: "alignment", pose: "parked pose", map: "map" };

export interface ReplaySummary {
  durationS: number;
  obdDistanceM: number;
  init: ReplayInit | null;
  /** What became of `startPose`: refused at start, confirmed or rejected by a fix (time since log start). */
  startPose: { status: "refused" | "unverified" | "confirmed" | "rejected"; tS: number } | null;
  /** Pose to start the next drive from (null: not parked in mode dr at the end). */
  endPose: ParkedPose | null;
  fixes: Record<FixRecord["status"], number> & { total: number; satellite: number };
  /** Median distance between prediction and fix before the update, per fix kind (mode dr). */
  medianErrorM: { satellite: number | null; coarse: number | null };
  /** Share of coarse fixes whose prediction lies inside the fix's own accuracy radius. */
  coarseInsideAccuracy: number | null;
  /** `speedOffsetKph`: the OBD speed offset (v = k_s·s_OBD + o_s), km/h. */
  params: { speedScale: number; speedOffsetKph: number; gyroBiasDegS: number; gyroScale: number } | null;
  /** Online GNSS lag estimate at the end of the log (null: not enough turns with good fixes). */
  gnssLag: GnssLagEstimate | null;
  imuInvalidS: number;
  standstillS: number;
  resets: number;
  /** Road-heading pseudo-measurements into the EKF (`mapMatchLoop: "heading"`, MAPMATCH-SPEC §9). */
  roadHeading: { accepted: number; rejected: number };
  /** Road-position pseudo-measurements (`mapMatchLoop: "closed"`). */
  roadPosition: { accepted: number; rejected: number };
  cuts: CutResult[];
  /** Map-matching metrics (with `mapMatch.truth`). */
  mapMatch: MapMatchSummary | null;
  /** The compass at the end: its trust, what it learned (stored + this drive), and its trust checks. */
  compass: { trust: CompassTrust; calibration: CompassCalibration | null; checkDiffsRad: number[] };
}

export interface ReplayResult {
  track: TrackPoint[];
  fixes: FixRecord[];
  summary: ReplaySummary;
  /** With `mapMatch.particlesEveryS`. */
  particles: ParticleSnapshot[];
}

const median = (v: number[]) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function replayTrip(trip: TripLog, options: ReplayOptions = {}): ReplayResult {
  // With a compass option the particle filter uses it (`on`); otherwise it runs in shadow, as in the app.
  const nav = new Navigator({ ...(options.compass ? { compassUse: "on" as const } : {}), ...options.nav });
  const cal = options.compass?.calibration;
  if (cal) nav.setCompassCalibration(options.compass?.rotateRad ? rotateCalibration(cal, options.compass.rotateRad) : cal);
  if (options.odometry) nav.subscribeOdometry(options.odometry);
  const mm = options.mapMatch;
  if (mm) nav.setRoadGraph(mm.graph, mm.config);
  const metrics = mm?.truth ? new MapMatchMetrics(mm.graph, mm.truth, trip.startUs) : null;
  const particles: ParticleSnapshot[] = [];
  let nextParticlesUs = -Infinity;
  const cuts: ReplayCut[] = [...(options.cuts ?? [])];
  const stepUs = (options.trackStepS ?? 1) * 1e6;
  const sessionUs = trip.startUs + (options.startAtS ?? 0) * 1e6;
  const truthAcc = options.truthAccuracyM ?? 10;
  const tS = (tUs: number) => (tUs - trip.startUs) / 1e6;
  const inCut = (t: number) => cuts.find((c) => t >= c.fromS && t < c.toS);

  const track: TrackPoint[] = [];
  const fixes: FixRecord[] = [];
  const cutDistance = cuts.map(() => 0);
  let lastDistance = 0;
  let nextTrackUs = -Infinity;
  let init: ReplaySummary["init"] = null;
  let startPose: ReplaySummary["startPose"] = null;
  if (options.startPose) {
    const ok = nav.startFromPose(options.startPose);
    startPose = { status: ok ? "unverified" : "refused", tS: tS(sessionUs) };
    if (ok) init = { tS: tS(sessionUs), method: "parked pose", distanceM: 0, estimate: null };
  }

  const afterEvent = (tUs: number) => {
    const d = nav.stats.obdDistanceM;
    const started = nav.initialization;
    if (started && !init) {
      const t = tS(started.tUs);
      init = { tS: t, method: INIT_NAMES[started.method], distanceM: d, estimate: nav.estimate() };
      if (options.openLoop) {
        cuts.push({ fromS: t + options.openLoop.delayS, toS: Infinity, openLoop: true });
        cutDistance.push(0);
      }
    }
    const cutIndex = cuts.findIndex((c) => tS(tUs) >= c.fromS && tS(tUs) < c.toS);
    if (cutIndex >= 0) cutDistance[cutIndex] += d - lastDistance;
    lastDistance = d;
    if (mm?.particlesEveryS && tUs >= nextParticlesUs && nav.mapMatcher?.isActive) {
      nextParticlesUs = tUs + mm.particlesEveryS * 1e6;
      particles.push({ tS: tS(tUs), particles: nav.mapMatchParticles(200) });
    }
    if (tUs < nextTrackUs) return;
    nextTrackUs = tUs + stepUs;
    const e = nav.estimate();
    const p = nav.params;
    if (e) track.push({ ...e, tS: tS(tUs), standstill: nav.isStandstill, ...(p ? { ks: p.ks, so: p.so } : {}) });
    if (metrics && e && !nav.isStandstill && (e.speedMps ?? 0) >= 2) metrics.sample(tUs, e.mapMatch, nav.mapMatcher, d);
  };

  // Merge the three time-sorted streams (from the session start).
  const from = <T extends { tUs: number }>(xs: T[]) => (options.startAtS ? xs.filter((x) => x.tUs >= sessionUs) : xs);
  const imu = from(trip.imu);
  const obdSpeed = from(trip.obdSpeed);
  const gnss = from(options.jam?.length ? jamFixes(trip.gnss, trip.startUs, options.jam, options.jamOptions) : trip.gnss);
  const mag = from(trip.mag ?? []);
  let i = 0;
  let o = 0;
  let g = 0;
  let k = 0;
  while (i < imu.length || o < obdSpeed.length || g < gnss.length || k < mag.length) {
    const ti = i < imu.length ? imu[i].tUs : Infinity;
    const to = o < obdSpeed.length ? obdSpeed[o].tUs : Infinity;
    const tg = g < gnss.length ? gnss[g].tUs : Infinity;
    const tm = k < mag.length ? mag[k].tUs : Infinity;
    if (tm < ti && tm < to && tm < tg) {
      nav.onMag(mag[k++]);
    } else if (ti <= to && ti <= tg) {
      nav.onImu(imu[i++]);
      afterEvent(ti);
    } else if (to <= tg) {
      nav.onObdSpeed(obdSpeed[o++]);
      afterEvent(to);
    } else {
      const fix = gnss[g++];
      const t = tS(fix.tUs);
      const satellite = isSatelliteFix(fix);
      if (inCut(t)) {
        const p = nav.positionAt(fix.tUs - (options.truthLagS ?? 0) * 1e6);
        const top = mm ? nav.estimate()?.mapMatch?.clusters[0] : undefined;
        fixes.push({
          tS: t,
          fix,
          satellite,
          status: "cut",
          errorM: p ? haversineM(p.coord, fix) : undefined,
          predictedSigmaM: p?.sigmaM,
          mapMatchErrorM: top ? haversineM(top, fix) : undefined,
        });
      } else {
        const out = nav.onGnss(fix);
        fixes.push({ tS: t, fix, satellite, ...out });
        if (out.pose) startPose = { status: out.pose, tS: t };
      }
      afterEvent(fix.tUs);
    }
  }

  nav.flushOdometry();
  const end = nav.estimate();
  if (end && end.tUs > (track.at(-1)?.tUs ?? -Infinity)) track.push({ ...end, tS: tS(end.tUs), standstill: nav.isStandstill });

  const counts = { init: 0, accepted: 0, rejected: 0, anchored: 0, skipped: 0, cut: 0 };
  for (const f of fixes) counts[f.status]++;
  const compared = fixes.filter((f) => (f.status === "accepted" || f.status === "rejected") && f.errorM !== undefined);
  const coarse = compared.filter((f) => !f.satellite);
  const params = nav.params;
  const ends = [imu.at(-1)?.tUs, obdSpeed.at(-1)?.tUs, gnss.at(-1)?.tUs].filter((t): t is number => t !== undefined);
  const durationS = ends.length ? tS(Math.max(...ends)) : 0;

  return {
    track,
    fixes,
    particles,
    summary: {
      durationS,
      obdDistanceM: nav.stats.obdDistanceM,
      init,
      startPose,
      endPose: nav.parkedPose,
      fixes: { ...counts, total: fixes.length, satellite: fixes.filter((f) => f.satellite).length },
      medianErrorM: {
        satellite: median(compared.filter((f) => f.satellite).map((f) => f.errorM!)),
        coarse: median(coarse.map((f) => f.errorM!)),
      },
      coarseInsideAccuracy: coarse.length ? coarse.filter((f) => f.errorM! <= f.fix.hAccM).length / coarse.length : null,
      params: params && {
        speedScale: params.ks,
        speedOffsetKph: params.so * 3.6,
        gyroBiasDegS: (params.bw * 180) / Math.PI,
        gyroScale: params.kw,
      },
      gnssLag: nav.gnssLagEstimate,
      imuInvalidS: nav.stats.imuInvalidS,
      standstillS: nav.stats.standstillS,
      resets: nav.stats.resets,
      roadHeading: { accepted: nav.stats.roadHeadingAccepted, rejected: nav.stats.roadHeadingRejected },
      roadPosition: { accepted: nav.stats.roadPositionAccepted, rejected: nav.stats.roadPositionRejected },
      mapMatch: metrics?.summary(nav.mapMatcher?.updateTimes ?? [], nav.mapMatcher?.startTimes) ?? null,
      compass: { trust: nav.compassTrust, calibration: nav.compassCalibration, checkDiffsRad: [...nav.compassCheckDiffs] },
      cuts: cuts.map((c, k) => {
        const truth = fixes.filter(
          (f) => f.status === "cut" && f.tS >= c.fromS && f.tS < c.toS && f.satellite && f.fix.hAccM <= truthAcc && f.errorM !== undefined,
        );
        const mmErrors = truth.map((f) => f.mapMatchErrorM).filter((v): v is number => v !== undefined);
        return {
          ...c,
          toS: Math.min(c.toS, durationS),
          distanceM: cutDistance[k],
          truthFixes: truth.length,
          maxErrorM: truth.length ? Math.max(...truth.map((f) => f.errorM!)) : null,
          lastErrorM: truth.length ? truth[truth.length - 1].errorM! : null,
          meanSigmaM: truth.length ? truth.reduce((s, f) => s + (f.predictedSigmaM ?? 0), 0) / truth.length : null,
          insideCircle: truth.length ? truth.filter((f) => f.errorM! <= SQRT_68 * (f.predictedSigmaM ?? 0)).length / truth.length : null,
          mapMatchMaxErrorM: mmErrors.length ? Math.max(...mmErrors) : null,
          mapMatchLastErrorM: mmErrors.length ? mmErrors[mmErrors.length - 1] : null,
        };
      }),
    },
  };
}
