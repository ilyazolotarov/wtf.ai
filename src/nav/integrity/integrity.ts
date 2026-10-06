// GNSS integrity (SPEC §3.3): is a satellite fix where the car is, or spoofed? Pure TS; the
// navigator feeds it, since only the navigator knows the car's odometry and dead reckoning.
//
// A spoofer replaces the satellite position with another one: abroad, or wherever its transmitter
// (or a rebroadcast) puts every receiver around it. That position appears suddenly and then stands
// still or follows a script, never the car. So a satellite fix is refused when it is:
// - outside Ukraine (border.ts);
// - a jump: farther from the last trusted fix than the car could have got since (OBD distance, or
//   200 km/h while OBD speed was unknown, plus walking pace and the fixes' accuracy);
// - the wrong shape: over the last ≥ 50 m the car drove (OBD + gyro, whatever the heading), the fixes
//   moved a different distance. A spoofed position standing still while the car drives fails this.
// The first fix after a gap (jamming, a tunnel, the session start) is also compared with every
// dead-reckoning hypothesis (the EKF, the map-matching clusters, the anchor): far from all of them it
// is held ("far") until the car's motion confirms the fixes or they come back to the dead reckoning.
//
// Fixes that continue a trusted stream are taken even as they drift from the dead reckoning: that is
// the dead reckoning drifting, or the phone leaving the car with the driver, and the EKF's own rule
// (five rejected fixes reset it) still applies to them. Slow drag-off spoofing is out of scope (SPEC §2).
//
// The fixes come in segments: a jump or a gap between two fixes starts a new one. A spoofed stream is a
// segment of its own, and real fixes start another when they come back. After a refusal, trust comes back
// with 5 fixes in a row on the dead reckoning; for the refused segment itself only on a dead reckoning
// that knows the position well (so a spoof standing inside a wide circle stays refused). When the dead
// reckoning itself may be wrong (held after a gap, or it didn't agree with the fixes before the spoofing
// began), fixes that keep the car's shape over 200 m are trusted again; otherwise only over 2 km.

import { haversineM } from "../geo";
import type { TrustState } from "../position/types";
import type { GnssFix } from "../types";
import { insideUkraine } from "./border";

export type IntegrityVerdict =
  /** Passes: the EKF and the map matching may use it. */
  | "ok"
  | "outside"
  | "jump"
  | "shape"
  /** After a gap, far from the dead reckoning: held until the car's motion decides. */
  | "far"
  /** Refused fixes came before and this one isn't back on the dead reckoning. */
  | "untrusted"
  /** Back on the dead reckoning, not yet for long enough. */
  | "reacquiring";

export interface IntegrityResult {
  verdict: IntegrityVerdict;
  /** What decided it, for the trip log. */
  detail?: string;
}

export interface IntegrityConfig {
  /** A fix this soon after the last trusted one continues its stream: no dead-reckoning check. Also the gap
   *  that starts a new segment. */
  continuityUs: number;
  /** Reach since the last trusted fix: OBD distance × `odometryScale`, `maxSpeedMps` while OBD speed was
   *  unknown, `walkMps` all along (OBD reads 0 below ~3 km/h and while reversing; the phone may leave the car),
   *  `reachSigmas` × the two fixes' σ, and `reachMarginM`. */
  odometryScale: number;
  maxSpeedMps: number;
  walkMps: number;
  reachSigmas: number;
  reachMarginM: number;
  /** After a gap: farther than max(`farSigmas` × σ, `farFloorM`) from every hypothesis is far. σ combines the
   *  hypothesis and the fix. Generous, because dead reckoning is overconfident after outages (up to 4.5 σ, 190 m
   *  on the clean drives cut for 1–8 min). */
  farSigmas: number;
  farFloorM: number;
  /** Trust comes back with `reacquireFixes` in a row, over ≥ `reacquireMinUs`, each within
   *  max(`reacquireSigmas` × σ, `reacquireFloorM`) of a hypothesis; for the refused segment only of one with
   *  σ ≤ `reacquireSegmentSigmaM`. */
  reacquireSigmas: number;
  reacquireFloorM: number;
  reacquireFixes: number;
  reacquireMinUs: number;
  reacquireSegmentSigmaM: number;
  /** Shape: over ≥ `shapeMinM` driven within `shapeWindowUs`, the fixes' displacement may differ from the
   *  relative track's by `shapeScale` × it + `shapeSigmas` × the fixes' σ + `shapeMarginM`. */
  shapeMinM: number;
  shapeWindowUs: number;
  shapeScale: number;
  shapeSigmas: number;
  shapeMarginM: number;
  /** Fixes that kept the car's shape for `verifyM` of driving (≥ `verifyTests` tests) are the car's, when the
   *  dead reckoning may be wrong; `verifyConfirmedM` when it agreed with the fixes before the refusals. */
  verifyM: number;
  verifyConfirmedM: number;
  verifyTests: number;
  /** Shown trust (NAVIGATOR-SPEC §8), decided over time so jamming doesn't flicker it: lost after
   *  `loseAfterUs` with no good fix (≤ `goodAccuracyM`), regained after `regainAfterUs` of fixes ≤
   *  `regainAccuracyM` with no coarse fix or gap between. */
  goodAccuracyM: number;
  regainAccuracyM: number;
  loseAfterUs: number;
  regainAfterUs: number;
}

export const DEFAULT_INTEGRITY_CONFIG: IntegrityConfig = {
  continuityUs: 10_000_000,
  odometryScale: 1.05,
  maxSpeedMps: 55,
  walkMps: 3,
  // Real steps between satellite fixes exceed the OBD distance by ≤ 19 m (p99 6.5 m) on 14 drives.
  reachSigmas: 3,
  reachMarginM: 20,
  farSigmas: 8,
  farFloorM: 150,
  reacquireSigmas: 4,
  reacquireFloorM: 30,
  reacquireFixes: 5,
  reacquireMinUs: 4_000_000,
  reacquireSegmentSigmaM: 30,
  shapeMinM: 50,
  shapeWindowUs: 60_000_000,
  shapeScale: 0.05,
  shapeSigmas: 3,
  shapeMarginM: 15,
  verifyM: 200,
  verifyConfirmedM: 2000,
  verifyTests: 3,
  goodAccuracyM: 50,
  regainAccuracyM: 30,
  loseAfterUs: 8_000_000,
  regainAfterUs: 5_000_000,
};

/** What the navigator knows at a satellite fix. */
export interface IntegrityContext {
  /** OBD distance driven (m) and time without OBD speed (s), both since the navigator started. */
  distanceM: number;
  unknownSpeedS: number;
  /** The relative OBD + gyro track at the fix time (any rotation); `epoch` changes when it breaks. Null: broken. */
  track: { e: number; n: number; epoch: number } | null;
  /**
   * Dead-reckoning hypotheses at the fix time: distance from the fix and 1σ, m. Null when the dead reckoning
   * can't follow the car (no OBD speed): then only the border and the reach count.
   */
  hypotheses: { distanceM: number; sigmaM: number }[] | null;
}

interface Seen {
  tUs: number;
  lat: number;
  lon: number;
  sigmaM: number;
  distanceM: number;
  unknownSpeedS: number;
  track: IntegrityContext["track"];
  segment: number;
}

interface Episode {
  /** `spoof`: a fix was outside, a jump or the wrong shape. `far`: only held after a gap. */
  kind: "spoof" | "far";
  sinceUs: number;
  /**
   * The dead reckoning agreed with the last trusted fix when the spoofing began (the EKF took it): it was right
   * then, so fixes that stay away from it are the spoof, however much they move like the car (up to
   * `verifyConfirmedM`). Without that the dead reckoning may be what's wrong.
   */
  drConfirmed: boolean;
  /** The segment of the last refused fix: the spoofed stream. */
  refusedSegment: number;
  /** Fixes in a row back on the dead reckoning, since. */
  streak: { count: number; sinceUs: number } | null;
  /** Shape tests passed, and the OBD distance, since the last refusal. */
  verify: { fromM: number; tests: number };
}

type Hypotheses = IntegrityContext["hypotheses"];

/** CoreLocation's accuracy is about a 68 % radius (NAVIGATOR-SPEC §6). */
const SIGMA_PER_ACCURACY = 1 / 1.5;

const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
const seconds = (us: number) => `${(us / 1e6).toFixed(0)} s`;

export class GnssIntegrity {
  readonly config: IntegrityConfig;
  private lastTrusted: Seen | null = null;
  /** The last trusted fix of an earlier segment than `lastTrusted`'s (to fall back on if that segment fails). */
  private trustedBefore: Seen | null = null;
  /** The last satellite fix, whatever became of it, and the segment it is in. */
  private lastSeen: Seen | null = null;
  private segment = 0;
  /** Recent satellite fixes that passed the border and the reach, for the shape test. */
  private recent: Seen[] = [];
  private episode: Episode | null = null;
  /** The EKF took the last trusted fix (`onUsed`). */
  private lastOnDr = false;
  // Shown trust.
  private trusted = false;
  private lastGoodUs = -Infinity;
  private regainSinceUs: number | null = null;
  private lastFixUs = -Infinity;
  /** The last fix that arrived while trusted and good, and the OBD distance then. */
  lastTrustedFixUs: number | undefined;
  lastTrustedDistanceM: number | undefined;

  constructor(config: Partial<IntegrityConfig> = {}) {
    this.config = { ...DEFAULT_INTEGRITY_CONFIG, ...config };
  }

  /** A satellite fix: may the navigator use it? */
  check(fix: GnssFix, ctx: IntegrityContext): IntegrityResult {
    const c = this.config;
    const seen: Seen = {
      tUs: fix.tUs,
      lat: fix.lat,
      lon: fix.lon,
      sigmaM: fix.hAccM * SIGMA_PER_ACCURACY,
      distanceM: ctx.distanceM,
      unknownSpeedS: ctx.unknownSpeedS,
      track: ctx.track,
      segment: this.segment,
    };
    const prev = this.lastSeen;
    if (!prev || fix.tUs - prev.tUs > c.continuityUs || haversineM(prev, fix) > this.reach(prev, seen)) seen.segment = ++this.segment;
    this.lastSeen = seen;

    if (!insideUkraine(fix)) return this.refuse("outside", seen, fix.hAccM, "outside Ukraine");
    const last = this.lastTrusted;
    if (last) {
      const d = haversineM(last, fix);
      const reach = this.reach(last, seen);
      if (d > reach) return this.refuse("jump", seen, fix.hAccM, `${km(d)} from the last trusted fix ${seconds(fix.tUs - last.tUs)} before, the car could reach ${km(reach)}`);
    }
    const shape = this.shape(seen);
    if (shape.failed) return this.refuse("shape", seen, fix.hAccM, shape.detail);

    const h = ctx.hypotheses;
    const nearest = h?.length ? Math.min(...h.map((x) => x.distanceM)) : null;
    const ep = this.episode;
    if (!ep) {
      const continuous = last !== null && fix.tUs - last.tUs <= c.continuityUs;
      if (!continuous && !within(h, seen, c.farSigmas, c.farFloorM)) {
        this.episode = { kind: "far", sinceUs: fix.tUs, drConfirmed: false, refusedSegment: -1, streak: null, verify: { fromM: ctx.distanceM, tests: 0 } };
        this.see(fix.hAccM, fix.tUs, false);
        return { verdict: "far", detail: `${km(nearest ?? 0)} from the dead reckoning after ${last ? `${seconds(fix.tUs - last.tUs)} without a trusted fix` : "the start"}` };
      }
      return this.accept(seen, fix.hAccM);
    }

    if (shape.passed) ep.verify.tests++;
    // The refused stream itself comes back only on a dead reckoning that knows where the car is.
    const back =
      ep.kind === "spoof" && seen.segment === ep.refusedSegment
        ? h !== null && within(h.filter((x) => x.sigmaM <= c.reacquireSegmentSigmaM), seen, c.reacquireSigmas, c.reacquireFloorM)
        : within(h, seen, c.reacquireSigmas, c.reacquireFloorM);
    if (back) {
      ep.streak ??= { count: 0, sinceUs: fix.tUs };
      ep.streak.count++;
      if (ep.streak.count >= c.reacquireFixes && fix.tUs - ep.streak.sinceUs >= c.reacquireMinUs) {
        return this.accept(seen, fix.hAccM, `back on the dead reckoning after ${seconds(fix.tUs - ep.sinceUs)}`);
      }
    } else {
      ep.streak = null;
    }
    const driven = ctx.distanceM - ep.verify.fromM;
    const verifyM = ep.kind === "spoof" && ep.drConfirmed ? c.verifyConfirmedM : c.verifyM;
    const close = ep.kind === "far" || ep.drConfirmed || within(h, seen, c.farSigmas, c.farFloorM);
    if (close && driven >= verifyM && ep.verify.tests >= c.verifyTests) {
      return this.accept(seen, fix.hAccM, `moved like the car for ${km(driven)}${nearest === null ? "" : `, ${km(nearest)} from the dead reckoning`}`);
    }
    this.see(fix.hAccM, fix.tUs, false);
    return { verdict: ep.streak ? "reacquiring" : ep.kind === "far" ? "far" : "untrusted" };
  }

  /** After an `ok`: whether the EKF took the fix (its gate passed, or it started from it). */
  onUsed(onDeadReckoning: boolean): void {
    this.lastOnDr = onDeadReckoning;
  }

  /** A Wi-Fi/cell fix: never trusted, but spoofing doesn't move it (SPEC §3.3 item 5). */
  onCoarse(fix: GnssFix): void {
    this.see(fix.hAccM, fix.tUs, false);
  }

  /** Shown trust at this time (monotonic µs, as the fixes'). */
  state(tUs: number): TrustState {
    if (this.episode) {
      if (tUs - (this.lastSeen?.tUs ?? -Infinity) > this.config.loseAfterUs) return "NO_FIX";
      return this.episode.kind === "far" || this.episode.streak ? "REACQUIRING" : "UNTRUSTED";
    }
    this.lapse(tUs);
    return this.trusted ? "TRUSTED" : "NO_FIX";
  }

  private reach(a: Seen, b: Seen): number {
    const c = this.config;
    const dtS = Math.max(0, (b.tUs - a.tUs) / 1e6);
    return (
      c.odometryScale * Math.max(0, b.distanceM - a.distanceM) +
      c.maxSpeedMps * Math.max(0, b.unknownSpeedS - a.unknownSpeedS) +
      c.walkMps * dtS +
      c.reachSigmas * Math.hypot(a.sigmaM, b.sigmaM) +
      c.reachMarginM
    );
  }

  /**
   * Compare the fixes' displacement with the car's over the latest stretch of ≥ `shapeMinM` driven on an unbroken
   * relative track, in this fix's segment. Distances only, so the heading needn't be known. Keeps `seen` for later
   * tests.
   */
  private shape(seen: Seen): { failed: boolean; passed: boolean; detail?: string } {
    const c = this.config;
    this.recent = this.recent.filter((r) => seen.tUs - r.tUs <= c.shapeWindowUs);
    let out: { failed: boolean; passed: boolean; detail?: string } = { failed: false, passed: false };
    const t = seen.track;
    for (let i = this.recent.length - 1; t && i >= 0; i--) {
      const r = this.recent[i];
      // Within one segment: the step between two segments is the reach's to judge.
      if (!r.track || r.track.epoch !== t.epoch || r.segment !== seen.segment) break;
      const driven = Math.hypot(t.e - r.track.e, t.n - r.track.n);
      if (driven < c.shapeMinM) continue;
      const moved = haversineM(r, seen);
      const tolerance = c.shapeScale * driven + c.shapeSigmas * Math.hypot(r.sigmaM, seen.sigmaM) + c.shapeMarginM;
      out =
        Math.abs(moved - driven) > tolerance
          ? { failed: true, passed: false, detail: `the fixes moved ${km(moved)} while the car drove ${km(driven)} (±${km(tolerance)})` }
          : { failed: false, passed: true };
      break;
    }
    if (out.failed) {
      // Start the stream over from this fix, so the next test doesn't straddle the failure. Fixes trusted in this
      // segment may have been the spoof already: fall back on the segment before.
      this.recent = [];
      if (this.lastTrusted?.segment === seen.segment) {
        this.lastTrusted = this.trustedBefore;
        this.trustedBefore = null;
        this.lastOnDr = false;
      }
    }
    this.recent.push(seen);
    return out;
  }

  private refuse(verdict: "outside" | "jump" | "shape", seen: Seen, accuracyM: number, detail?: string): IntegrityResult {
    const ep = this.episode;
    const verify = { fromM: seen.distanceM, tests: 0 };
    if (!ep || ep.kind === "far") {
      this.episode = { kind: "spoof", sinceUs: ep?.sinceUs ?? seen.tUs, drConfirmed: !ep && this.lastOnDr, refusedSegment: seen.segment, streak: null, verify };
    } else {
      ep.refusedSegment = seen.segment;
      ep.streak = null;
      ep.verify = verify;
    }
    this.see(accuracyM, seen.tUs, false);
    return { verdict, detail };
  }

  private accept(seen: Seen, accuracyM: number, detail?: string): IntegrityResult {
    if (this.episode) {
      // The streak (or the verified shape) has shown what the regain rule would wait for.
      this.trusted = true;
      this.regainSinceUs = null;
      this.episode = null;
    }
    if (this.lastTrusted && this.lastTrusted.segment !== seen.segment) this.trustedBefore = this.lastTrusted;
    this.lastTrusted = seen;
    this.lastOnDr = false;
    this.see(accuracyM, seen.tUs, true, seen.distanceM);
    return { verdict: "ok", detail };
  }

  /** Shown trust over time (NAVIGATOR-SPEC §8); `usable`: a satellite fix integrity passed. */
  private see(accuracyM: number, tUs: number, usable: boolean, distanceM?: number): void {
    const c = this.config;
    const gap = tUs - this.lastFixUs;
    this.lastFixUs = tUs;
    const good = usable && accuracyM <= c.goodAccuracyM;
    if (good) this.lastGoodUs = tUs;
    if (this.trusted) {
      this.lapse(tUs);
    } else if (usable && accuracyM <= c.regainAccuracyM) {
      if (this.regainSinceUs === null || gap > c.loseAfterUs) this.regainSinceUs = tUs;
      // The very first fix has nothing to have been distrusted against: accept it.
      if (this.lastTrustedFixUs === undefined || tUs - this.regainSinceUs >= c.regainAfterUs) {
        this.trusted = true;
        this.regainSinceUs = null;
      }
    } else {
      this.regainSinceUs = null;
    }
    if (this.trusted && good && !this.episode) {
      this.lastTrustedFixUs = tUs;
      this.lastTrustedDistanceM = distanceM;
    }
  }

  private lapse(tUs: number): void {
    if (this.trusted && tUs - this.lastGoodUs > this.config.loseAfterUs) {
      this.trusted = false;
      this.regainSinceUs = null;
    }
  }
}

/** Within max(`sigmas` × σ, `floorM`) of any hypothesis (σ: the hypothesis's and the fix's); always without any. */
function within(h: Hypotheses, seen: Seen, sigmas: number, floorM: number): boolean {
  return h === null || h.some((x) => x.distanceM <= Math.max(sigmas * Math.hypot(x.sigmaM, seen.sigmaM), floorM));
}
