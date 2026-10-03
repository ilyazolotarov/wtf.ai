// Replay a trip log through the navigator (SPEC §3.10): fused track, per-fix consistency,
// and DR error during simulated GNSS outages ("cuts"). Pure TS; the CLI is tools/replay.

import type { GnssLagEstimate } from "../calibration/gnss-lag";
import type { TripLog } from "../../triplog/trip-log-reader";
import { haversineM } from "../geo";
import { Navigator, type FixOutcome, type NavConfig, type NavEstimate, type ParkedPose } from "../navigator";
import { isSatelliteFix, type GnssFix } from "../types";

export interface ReplayCut {
  /** Seconds since log start. */
  fromS: number;
  toS: number;
  /** Added by `openLoop`: runs from the heading fix to the end of the log. */
  openLoop?: boolean;
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
}

export interface TrackPoint extends NavEstimate {
  tS: number;
  standstill: boolean;
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
}

export interface CutResult extends ReplayCut {
  /** OBD distance driven inside the cut, m. */
  distanceM: number;
  truthFixes: number;
  maxErrorM: number | null;
  lastErrorM: number | null;
  /** Mean predicted 1σ at the truth fixes, m (is the uncertainty honest?). */
  meanSigmaM: number | null;
}

export interface ReplaySummary {
  durationS: number;
  obdDistanceM: number;
  init: { tS: number; method: string } | null;
  /** What became of `startPose`: refused at start, confirmed or rejected by a fix (time since log start). */
  startPose: { status: "refused" | "unverified" | "confirmed" | "rejected"; tS: number } | null;
  /** Pose to start the next drive from (null: not parked in mode dr at the end). */
  endPose: ParkedPose | null;
  fixes: Record<FixRecord["status"], number> & { total: number; satellite: number };
  /** Median distance between prediction and fix before the update, per fix kind (mode dr). */
  medianErrorM: { satellite: number | null; coarse: number | null };
  /** Share of coarse fixes whose prediction lies inside the fix's own accuracy radius. */
  coarseInsideAccuracy: number | null;
  params: { speedScale: number; gyroBiasDegS: number; gyroScale: number } | null;
  /** Online GNSS lag estimate at the end of the log (null: not enough turns with good fixes). */
  gnssLag: GnssLagEstimate | null;
  imuInvalidS: number;
  standstillS: number;
  resets: number;
  cuts: CutResult[];
}

export interface ReplayResult {
  track: TrackPoint[];
  fixes: FixRecord[];
  summary: ReplaySummary;
}

const median = (v: number[]) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function replayTrip(trip: TripLog, options: ReplayOptions = {}): ReplayResult {
  const nav = new Navigator(options.nav);
  const cuts: ReplayCut[] = [...(options.cuts ?? [])];
  const stepUs = (options.trackStepS ?? 1) * 1e6;
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
    startPose = { status: ok ? "unverified" : "refused", tS: 0 };
    if (ok) init = { tS: 0, method: "parked pose" };
  }

  const afterEvent = (tUs: number) => {
    const d = nav.stats.obdDistanceM;
    const cutIndex = cuts.findIndex((c) => tS(tUs) >= c.fromS && tS(tUs) < c.toS);
    if (cutIndex >= 0) cutDistance[cutIndex] += d - lastDistance;
    lastDistance = d;
    if (tUs < nextTrackUs) return;
    nextTrackUs = tUs + stepUs;
    const e = nav.estimate();
    if (e) track.push({ ...e, tS: tS(tUs), standstill: nav.isStandstill });
  };

  // Merge the three time-sorted streams.
  const { imu, obdSpeed, gnss } = trip;
  let i = 0;
  let o = 0;
  let g = 0;
  while (i < imu.length || o < obdSpeed.length || g < gnss.length) {
    const ti = i < imu.length ? imu[i].tUs : Infinity;
    const to = o < obdSpeed.length ? obdSpeed[o].tUs : Infinity;
    const tg = g < gnss.length ? gnss[g].tUs : Infinity;
    if (ti <= to && ti <= tg) {
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
        fixes.push({
          tS: t,
          fix,
          satellite,
          status: "cut",
          errorM: p ? haversineM(p.coord, fix) : undefined,
          predictedSigmaM: p?.sigmaM,
        });
      } else {
        const out = nav.onGnss(fix);
        fixes.push({ tS: t, fix, satellite, ...out });
        if (out.pose) startPose = { status: out.pose, tS: t };
        if (out.status === "init" && !init) {
          init = { tS: t, method: out.initMethod ?? "?" };
          if (options.openLoop) {
            cuts.push({ fromS: t + options.openLoop.delayS, toS: Infinity, openLoop: true });
            cutDistance.push(0);
          }
        }
      }
      afterEvent(fix.tUs);
    }
  }

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
        gyroBiasDegS: (params.bw * 180) / Math.PI,
        gyroScale: params.kw,
      },
      gnssLag: nav.gnssLagEstimate,
      imuInvalidS: nav.stats.imuInvalidS,
      standstillS: nav.stats.standstillS,
      resets: nav.stats.resets,
      cuts: cuts.map((c, k) => {
        const truth = fixes.filter(
          (f) => f.status === "cut" && f.tS >= c.fromS && f.tS < c.toS && f.satellite && f.fix.hAccM <= truthAcc && f.errorM !== undefined,
        );
        return {
          ...c,
          toS: Math.min(c.toS, durationS),
          distanceM: cutDistance[k],
          truthFixes: truth.length,
          maxErrorM: truth.length ? Math.max(...truth.map((f) => f.errorM!)) : null,
          lastErrorM: truth.length ? truth[truth.length - 1].errorM! : null,
          meanSigmaM: truth.length ? truth.reduce((s, f) => s + (f.predictedSigmaM ?? 0), 0) / truth.length : null,
        };
      }),
    },
  };
}
