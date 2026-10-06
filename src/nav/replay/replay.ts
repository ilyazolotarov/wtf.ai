// Replay a trip log through the navigator (SPEC §3.10): fused track, per-fix consistency,
// and DR error during simulated GNSS outages ("cuts"). Pure TS; the CLI is tools/replay.

import type { GnssLagEstimate } from "../calibration/gnss-lag";
import { rotateCalibration, type CompassCalibration, type CompassTrust } from "../compass/compass";
import type { TripLog } from "../../triplog/trip-log-reader";
import { haversineM } from "../geo";
import type { EdgeId } from "../mapmatch/graph/road-graph";
import type { MapMatchConfig } from "../mapmatch/particle-filter";
import { Navigator, SQRT_68, type FixOutcome, type InitMethod, type MapMatchGraph, type NavConfig, type NavEstimate, type ParkedPose } from "../navigator";
import type { OdometryStep } from "../odometry/odometry-output";
import type { IntegrityVerdict } from "../integrity/integrity";
import type { TrustState } from "../position/types";
import { jamFixes, type JamOptions, type JamWindow } from "./jam";
import { MapMatchMetrics, type MapMatchSummary } from "./mapmatch-metrics";
import { spoofFixes, type SpoofWindow } from "./spoof";
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
  /** Simulated spoofing (spoof.ts): satellite fixes in these windows are replaced by a spoofed position. */
  spoof?: SpoofWindow[];
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
  /** Route hints for the filter (ROUTING-SPEC §8.6) from these times on (log-relative s, ascending); null clears. */
  routeHints?: { fromS: number; edges: EdgeId[] | null }[];
  /** Stop the replay at this time (log-relative s). */
  untilS?: number;
}

/** Particle positions at one moment: [lat, lon, weight, off-road 1/0] heaviest first. */
export interface ParticleSnapshot {
  tS: number;
  particles: [number, number, number, number][];
}

export interface TrackPoint extends NavEstimate {
  tS: number;
  standstill: boolean;
  /** GNSS trust the app would show (integrity, SPEC §3.3). */
  trust: TrustState;
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
  integrity?: IntegrityVerdict;
  integrityDetail?: string;
  /** Made up by `spoof`: not where the car was. */
  spoofed?: boolean;
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

const INIT_NAMES: Record<InitMethod, string> = { course: "course", alignment: "alignment", pose: "parked pose", map: "map", user: "driver" };

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
  integrity: IntegritySummary;
}

/** GNSS integrity over the replay (SPEC §3.3, §7 target 7). */
export interface IntegritySummary {
  /** Satellite fixes refused, by verdict. */
  refused: Partial<Record<IntegrityVerdict, number>>;
  /** Spoofed fixes (`spoof`), and those the navigator used anyway. */
  spoofed: number;
  spoofedUsed: number;
  /** Real satellite fixes refused away from the spoof windows (false refusals), and the first few with why. */
  realRefused: number;
  realRefusedAt: { tS: number; verdict: IntegrityVerdict; detail?: string }[];
  /** Track time showing UNTRUSTED or REACQUIRING outside the spoof windows, s (false alarm). */
  falseAlarmS: number;
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

/** What a recorder needs of the replay options: everything but how the inputs reach the navigator. */
export type RecorderOptions = Pick<ReplayOptions, "cuts" | "trackStepS" | "truthAccuracyM" | "truthLagS" | "openLoop" | "startAtS" | "spoof"> & {
  mapMatch?: Pick<NonNullable<ReplayOptions["mapMatch"]>, "graph" | "truth" | "particlesEveryS">;
  /** The fixes `spoof` made up (spoofFixes). */
  spoofed?: ReadonlySet<GnssFix>;
};

/**
 * What a replay records about the navigator as it runs: the track, every fix and its outcome, the fixes withheld in
 * cuts (scored against the dead reckoning), particle snapshots, map-matching metrics, and the summary. Shared by
 * `replayTrip` (inputs straight into a Navigator) and the app replay (inputs through the app's NavigatorService,
 * which owns its navigators: `use` follows a new one).
 */
export class ReplayRecorder {
  private nav: Navigator | null = null;
  /** OBD distance of the navigators replaced so far. */
  private distanceOffsetM = 0;
  private readonly metrics: MapMatchMetrics | null;
  private readonly particles: ParticleSnapshot[] = [];
  private nextParticlesUs = -Infinity;
  readonly cuts: ReplayCut[];
  private readonly stepUs: number;
  private readonly sessionUs: number;
  private readonly truthAcc: number;
  private readonly track: TrackPoint[] = [];
  private readonly fixes: FixRecord[] = [];
  private readonly cutDistance: number[];
  /** Withheld fixes, scored once the navigator reaches their time. */
  private readonly heldOut: GnssFix[] = [];
  private lastDistance = 0;
  private nextTrackUs = -Infinity;
  private init: ReplaySummary["init"] = null;
  private startPose: ReplaySummary["startPose"] = null;

  constructor(
    private readonly trip: TripLog,
    private readonly options: RecorderOptions = {},
  ) {
    const mm = options.mapMatch;
    this.metrics = mm?.truth ? new MapMatchMetrics(mm.graph, mm.truth, trip.startUs) : null;
    this.cuts = [...(options.cuts ?? [])];
    this.cutDistance = this.cuts.map(() => 0);
    this.stepUs = (options.trackStepS ?? 1) * 1e6;
    this.sessionUs = trip.startUs + (options.startAtS ?? 0) * 1e6;
    this.truthAcc = options.truthAccuracyM ?? 10;
  }

  private tS(tUs: number): number {
    return (tUs - this.trip.startUs) / 1e6;
  }

  /** The navigator from now on (a new one carries on the OBD distance). */
  use(nav: Navigator): void {
    if (this.nav && this.nav !== nav) this.distanceOffsetM += this.nav.stats.obdDistanceM;
    this.nav = nav;
  }

  private distanceM(): number {
    return this.distanceOffsetM + (this.nav?.stats.obdDistanceM ?? 0);
  }

  /** Inside a cut at this log time (s): its fixes are withheld. */
  inCut(t: number): boolean {
    return this.cuts.some((c) => t >= c.fromS && t < c.toS);
  }

  /** A parked pose given to the navigator at the session start (`ok`: it took it). */
  startedFromPose(ok: boolean): void {
    this.startPose = { status: ok ? "unverified" : "refused", tS: this.tS(this.sessionUs) };
    if (ok) this.init = { tS: this.tS(this.sessionUs), method: "parked pose", distanceM: 0, estimate: null };
  }

  /** A fix the navigator took, and what it made of it. */
  fixOutcome(fix: GnssFix, out: FixOutcome): void {
    const t = this.tS(fix.tUs);
    this.fixes.push({ tS: t, fix, satellite: isSatelliteFix(fix), ...out, ...(this.options.spoofed?.has(fix) ? { spoofed: true } : {}) });
    if (out.pose && out.pose !== "doubted") this.startPose = { status: out.pose, tS: t };
  }

  /** A fix withheld (a cut): scored against the navigator at its time. */
  withheld(fix: GnssFix): void {
    this.heldOut.push(fix);
  }

  private scoreHeldOut(untilUs: number): void {
    const nav = this.nav;
    while (this.heldOut.length && this.heldOut[0].tUs <= untilUs) {
      const fix = this.heldOut.shift()!;
      const p = nav?.positionAt(fix.tUs - (this.options.truthLagS ?? 0) * 1e6) ?? null;
      const top = this.options.mapMatch ? nav?.estimate()?.mapMatch?.clusters[0] : undefined;
      this.fixes.push({
        tS: this.tS(fix.tUs),
        fix,
        satellite: isSatelliteFix(fix),
        status: "cut",
        errorM: p ? haversineM(p.coord, fix) : undefined,
        predictedSigmaM: p?.sigmaM,
        mapMatchErrorM: top ? haversineM(top, fix) : undefined,
      });
    }
  }

  /** After each input the navigator took (its time). */
  afterEvent(tUs: number): void {
    const nav = this.nav;
    if (!nav) return;
    this.scoreHeldOut(tUs);
    const d = this.distanceM();
    const started = nav.initialization;
    if (started && !this.init) {
      // A start from a parked pose before any input (the app's service) has no time of its own: the session start.
      const t = Math.max(this.tS(started.tUs), this.tS(this.sessionUs));
      this.init = { tS: t, method: INIT_NAMES[started.method], distanceM: d, estimate: nav.estimate() };
      if (started.method === "pose" && !this.startPose) this.startPose = { status: "unverified", tS: t };
      if (this.options.openLoop) {
        this.cuts.push({ fromS: t + this.options.openLoop.delayS, toS: Infinity, openLoop: true });
        this.cutDistance.push(0);
      }
    }
    const cutIndex = this.cuts.findIndex((c) => this.tS(tUs) >= c.fromS && this.tS(tUs) < c.toS);
    if (cutIndex >= 0) this.cutDistance[cutIndex] += d - this.lastDistance;
    this.lastDistance = d;
    const mm = this.options.mapMatch;
    if (mm?.particlesEveryS && tUs >= this.nextParticlesUs && nav.mapMatcher?.isActive) {
      this.nextParticlesUs = tUs + mm.particlesEveryS * 1e6;
      this.particles.push({ tS: this.tS(tUs), particles: nav.mapMatchParticles(200) });
    }
    if (tUs < this.nextTrackUs) return;
    this.nextTrackUs = tUs + this.stepUs;
    const e = nav.estimate();
    const p = nav.params;
    if (e) this.track.push({ ...e, tS: this.tS(tUs), standstill: nav.isStandstill, trust: nav.trustAt(tUs), ...(p ? { ks: p.ks, so: p.so } : {}) });
    if (this.metrics && e && !nav.isStandstill && (e.speedMps ?? 0) >= 2) this.metrics.sample(tUs, e.mapMatch, nav.mapMatcher, d);
  }

  /** The result; `durationS`: the log's length as replayed. */
  finish(durationS: number): ReplayResult {
    const nav = this.nav ?? new Navigator();
    this.scoreHeldOut(Infinity);
    nav.flushOdometry();
    const { track, fixes, cuts, cutDistance, truthAcc } = this;
    // An app replay scores a withheld fix when its navigator gets there, after later fixes' outcomes.
    fixes.sort((a, b) => a.tS - b.tS);
    const end = nav.estimate();
    if (end && end.tUs > (track.at(-1)?.tUs ?? -Infinity)) track.push({ ...end, tS: this.tS(end.tUs), standstill: nav.isStandstill, trust: nav.trustAt(end.tUs) });

    const counts = { init: 0, accepted: 0, rejected: 0, anchored: 0, skipped: 0, untrusted: 0, cut: 0 };
    for (const f of fixes) counts[f.status]++;
    const compared = fixes.filter((f) => (f.status === "accepted" || f.status === "rejected") && f.errorM !== undefined);
    const coarse = compared.filter((f) => !f.satellite);
    const params = nav.params;

    return {
      track,
      fixes,
      particles: this.particles,
      summary: {
        durationS,
        obdDistanceM: this.distanceM(),
        init: this.init,
        startPose: this.startPose,
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
        mapMatch: this.metrics?.summary(nav.mapMatcher?.updateTimes ?? [], nav.mapMatcher?.startTimes) ?? null,
        compass: { trust: nav.compassTrust, calibration: nav.compassCalibration, checkDiffsRad: [...nav.compassCheckDiffs] },
        integrity: integritySummary(fixes, track, this.options.spoof ?? []),
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
}

/** After a spoof window ends, the trust may take this long to come back without counting as a false alarm. */
const SPOOF_RECOVERY_S = 60;

function integritySummary(fixes: FixRecord[], track: TrackPoint[], spoof: SpoofWindow[]): IntegritySummary {
  const refused: IntegritySummary["refused"] = {};
  for (const f of fixes) if (f.status === "untrusted" && f.integrity) refused[f.integrity] = (refused[f.integrity] ?? 0) + 1;
  const spoofedFixes = fixes.filter((f) => f.spoofed);
  // Real fixes refused while trust comes back after a spoof window are the point, not false refusals.
  const spoofing = (t: number) => spoof.some((w) => t >= w.fromS && t < w.toS + SPOOF_RECOVERY_S);
  const real = fixes.filter((f) => f.status === "untrusted" && !f.spoofed && !spoofing(f.tS));
  let falseAlarmS = 0;
  for (let i = 1; i < track.length; i++) {
    const p = track[i - 1];
    if ((p.trust === "UNTRUSTED" || p.trust === "REACQUIRING") && !spoofing(p.tS)) falseAlarmS += track[i].tS - p.tS;
  }
  return {
    refused,
    spoofed: spoofedFixes.length,
    spoofedUsed: spoofedFixes.filter((f) => f.status !== "untrusted" && f.status !== "cut" && f.status !== "skipped").length,
    realRefused: real.length,
    realRefusedAt: real.slice(0, 5).map((f) => ({ tS: f.tS, verdict: f.integrity!, ...(f.integrityDetail ? { detail: f.integrityDetail } : {}) })),
    falseAlarmS,
  };
}

export function replayTrip(trip: TripLog, options: ReplayOptions = {}): ReplayResult {
  // With a compass option the particle filter uses it (`on`); otherwise it runs in shadow, as in the app.
  const nav = new Navigator({ ...(options.compass ? { compassUse: "on" as const } : {}), ...options.nav });
  const cal = options.compass?.calibration;
  if (cal) nav.setCompassCalibration(options.compass?.rotateRad ? rotateCalibration(cal, options.compass.rotateRad) : cal);
  if (options.odometry) nav.subscribeOdometry(options.odometry);
  const mm = options.mapMatch;
  if (mm) nav.setRoadGraph(mm.graph, mm.config);
  const jammed = options.jam?.length ? jamFixes(trip.gnss, trip.startUs, options.jam, options.jamOptions) : trip.gnss;
  const { fixes: spoofed, spoofed: spoofedSet } = spoofFixes(jammed, trip.startUs, options.spoof ?? []);
  const rec = new ReplayRecorder(trip, { ...options, spoofed: spoofedSet });
  rec.use(nav);
  const sessionUs = trip.startUs + (options.startAtS ?? 0) * 1e6;
  const tS = (tUs: number) => (tUs - trip.startUs) / 1e6;
  if (options.startPose) rec.startedFromPose(nav.startFromPose(options.startPose));

  // Merge the three time-sorted streams (from the session start).
  const from = <T extends { tUs: number }>(xs: T[]) => (options.startAtS ? xs.filter((x) => x.tUs >= sessionUs) : xs);
  const imu = from(trip.imu);
  const obdSpeed = from(trip.obdSpeed);
  const gnss = from(spoofed);
  const mag = from(trip.mag ?? []);
  let i = 0;
  let o = 0;
  let g = 0;
  let k = 0;
  const hints = options.routeHints ?? [];
  let h = 0;
  while (i < imu.length || o < obdSpeed.length || g < gnss.length || k < mag.length) {
    const ti = i < imu.length ? imu[i].tUs : Infinity;
    const to = o < obdSpeed.length ? obdSpeed[o].tUs : Infinity;
    const tg = g < gnss.length ? gnss[g].tUs : Infinity;
    const tm = k < mag.length ? mag[k].tUs : Infinity;
    const tNext = tS(Math.min(ti, to, tg, tm));
    if (options.untilS !== undefined && tNext > options.untilS) break;
    while (h < hints.length && hints[h].fromS <= tNext) nav.setRouteHint(hints[h++].edges);
    if (tm < ti && tm < to && tm < tg) {
      nav.onMag(mag[k++]);
    } else if (ti <= to && ti <= tg) {
      nav.onImu(imu[i++]);
      rec.afterEvent(ti);
    } else if (to <= tg) {
      nav.onObdSpeed(obdSpeed[o++]);
      rec.afterEvent(to);
    } else {
      const fix = gnss[g++];
      if (rec.inCut(tS(fix.tUs))) rec.withheld(fix);
      else rec.fixOutcome(fix, nav.onGnss(fix));
      rec.afterEvent(fix.tUs);
    }
  }

  const ends = [imu.at(-1)?.tUs, obdSpeed.at(-1)?.tUs, gnss.at(-1)?.tUs].filter((t): t is number => t !== undefined);
  return rec.finish(ends.length ? tS(Math.max(...ends)) : 0);
}
