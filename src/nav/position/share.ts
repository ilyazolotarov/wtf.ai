// What other navigators get as the phone's location while wtf.ai shares the car's position (docs/ANDROID-SPEC.md §8):
// the dot the map draws (puck.ts), its radius, the car's speed and the way it travels; and when the platform gps
// provider (Waze's) is wtf.ai's. Functions of the published positions and the phone's satellite fixes, so a replay of
// `nav_estimate` and `gnss` shows what Google Maps and Waze were given.

import type { PositionEstimate, TrustState } from "./types";

/**
 * Above this radius nothing is shared, and the other apps show no location. They can't draw how sure the position is
 * or the other roads the car may be on, and a confident arrow on the wrong street is worse than "no GPS": the
 * driver follows its turns.
 */
export const SHARE_HOLD_ACCURACY_M = 200;
/** Shared again only below this, so a radius near the limit doesn't switch the other apps' dot on and off. */
export const SHARE_RESUME_ACCURACY_M = 150;
/**
 * About once a second, as a GPS gives fixes. The navigator publishes every 0.5 s: sending every other publish keeps
 * a one-second rhythm, where waiting a full second would skip to every third.
 */
export const SHARE_MIN_INTERVAL_MS = 900;

/** One fix for the other apps (modules/position-share's payload). */
export interface SharedFix {
  lat: number;
  lon: number;
  /** The dot's 68 % radius: what Android's `Location.accuracy` means. */
  accuracyM: number;
  /** Unsigned, as Android's speed is. */
  speedMps?: number;
  /** The way the car travels (Android's bearing): its heading, or behind it in reverse. Radians from north. */
  courseRad?: number;
  courseAccRad?: number;
}

/** Why nothing is shared now. */
export type ShareHold =
  /** No position yet. */
  | "none"
  /** The driver's placing, held while no car speed comes (NAVIGATOR-SPEC §6.3): the car isn't followed. */
  | "manual"
  /** Phone-only mode (NAVIGATOR-SPEC §9.6): not trusted unattended. */
  | "phone-only"
  /** The radius is over `SHARE_HOLD_ACCURACY_M` (until it is under `SHARE_RESUME_ACCURACY_M` again). */
  | "uncertain";

export type ShareDecision = { fix: SharedFix; hold?: undefined } | { fix?: undefined; hold: ShareHold };

const TURN = 2 * Math.PI;

/** What to share for the position the map shows; `holding`: why nothing was shared at the previous one. */
export function shareDecision(p: PositionEstimate | null, holding: ShareHold | null): ShareDecision {
  if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return { hold: "none" };
  if (p.source === "manual") return { hold: "manual" };
  if (p.phoneOnly) return { hold: "phone-only" };
  // The car's test drive: not where the car is, no position to share.
  if (p.testDrive) return { hold: "none" };
  const limit = holding === "uncertain" ? SHARE_RESUME_ACCURACY_M : SHARE_HOLD_ACCURACY_M;
  if (!(p.accuracyM > 0 && p.accuracyM <= limit)) return { hold: "uncertain" };
  const fix: SharedFix = { lat: p.lat, lon: p.lon, accuracyM: p.accuracyM };
  const speed = p.speedMps !== undefined && Number.isFinite(p.speedMps) ? p.speedMps : undefined;
  if (speed !== undefined) fix.speedMps = Math.abs(speed);
  if (p.headingRad !== undefined && Number.isFinite(p.headingRad)) {
    // CAN wheel speeds are negative in reverse: the car travels the way its tail points.
    const course = p.headingRad + (speed !== undefined && speed < 0 ? Math.PI : 0);
    fix.courseRad = ((course % TURN) + TURN) % TURN;
    if (p.headingSigmaRad !== undefined && Number.isFinite(p.headingSigmaRad)) fix.courseAccRad = p.headingSigmaRad;
  }
  return { fix };
}

// ---- the gps provider, for apps that read it directly (Waze) ----

/**
 * Taken, wtf.ai lets go of the gps provider this often to see whether GPS is back: while taken, its own satellite
 * fixes stop too (Android stops the real provider), and integrity can't trust GPS again without seeing it.
 */
export const TAKEOVER_PROBE_EVERY_MS = 120_000;
/**
 * Each probe a spoofed fix ended doubles the wait for the next, up to this: Waze sees that fix, so a spoofing that
 * lasts is looked at less often. A probe that met no such fix (jamming: Waze saw nothing) starts the waits over.
 */
export const TAKEOVER_PROBE_EVERY_MAX_MS = 480_000;
/** A probe lasts this long: a hot GPS restart and integrity's 5 fixes over 4 s near a hypothesis fit in it. */
export const TAKEOVER_PROBE_MS = 10_000;
/** While integrity is still checking the fixes it sees (`REACQUIRING`), a probe goes on up to this long. */
export const TAKEOVER_PROBE_MAX_MS = 60_000;
/**
 * A satellite fix this far from the dot shared, and over `TAKEOVER_PROBE_FAR_RADII` of its radius, ends a probe at
 * once: spoofed, it is where Waze would draw the car. Nearer, Waze is barely misled and integrity may yet trust it.
 */
export const TAKEOVER_PROBE_FAR_M = 500;
export const TAKEOVER_PROBE_FAR_RADII = 3;
/**
 * No fix at a trip's start is a cold GPS as often as jamming: taken for it only after this long, unless GPS was
 * trusted earlier in the trip (then losing it is jamming).
 */
export const TAKEOVER_NO_FIX_AFTER_START_MS = 60_000;
/**
 * `NO_FIX` takes the gps provider only once the phone's satellite fixes have stopped this long. Poor ones still coming
 * (tall buildings) are Waze's to show and the navigator's to use, and a bridge or an underpass passes before it:
 * taken, the navigator would get no satellite fix until the next probe.
 */
export const TAKEOVER_NO_FIX_SILENT_MS = 20_000;
/**
 * The first `NO_FIX` takeover since GPS was trusted (or since the trip's start) probes this soon: most losses are short
 * (a tunnel). Spoofing, and losses a probe found still on, wait the full time.
 */
export const TAKEOVER_NO_FIX_FIRST_PROBE_MS = 30_000;
/**
 * A probe that met this many satellite fixes integrity let through, only too poor to trust, gives the gps provider back:
 * the phone's GPS works. Fewer is a fix leaking through jamming.
 */
export const TAKEOVER_PROBE_BACK_FIXES = 3;

/** `real`: Waze reads the phone's own GPS; `taken`: wtf.ai's fixes; `probing`: let go to look at the real GPS. */
export type GpsTakeoverState = "real" | "taken" | "probing";

/** The phone's last satellite fix against the dot: `at` tells a new fix from the last one, `offM` its distance. */
export interface ProbeFix {
  at: number;
  offM: number;
  /** The dot's radius. */
  radiusM: number;
}

/**
 * When wtf.ai replaces the platform gps provider (ANDROID-SPEC §8): only while GPS isn't trusted, so Waze gets the
 * car's position under spoofing and jamming and the real GPS otherwise.
 */
export class GpsTakeoverPolicy {
  state: GpsTakeoverState = "real";
  /** The wait between probes, doubled by each one a spoofed fix ended. */
  probeEveryMs = TAKEOVER_PROBE_EVERY_MS;
  /** The last probe ended at a spoofed fix this far from the dot, m; null: it didn't. */
  spoofedOffM: number | null = null;
  private sinceMs = 0;
  /** Taken, the wait before the next probe: the first after a `NO_FIX` takeover may be shorter. */
  private waitMs = TAKEOVER_PROBE_EVERY_MS;
  /** The next `NO_FIX` takeover probes after `TAKEOVER_NO_FIX_FIRST_PROBE_MS`: none since GPS was last trusted. */
  private quickProbe = true;
  private startMs: number | null = null;
  private trustedOnce = false;
  /** The satellite fix seen last before the probe: any other one came during it. */
  private probeFixAt: number | null = null;
  /** New satellite fixes seen during the probe. */
  private probeFixes = 0;
  /** The phone's last satellite fix (its `at`), and when this policy saw it first; before any, the policy's start. */
  private fixAt: number | null = null;
  private fixSeenMs = 0;

  /**
   * Whether the gps provider should be wtf.ai's now; `sharing`: a fix of the dot is going out (not held); `fix`: the
   * phone's last satellite fix, refused or not (what Waze reads during a probe).
   */
  update(nowMs: number, trust: TrustState, sharing: boolean, fix?: ProbeFix | null): boolean {
    if (this.startMs === null) {
      this.startMs = nowMs;
      this.fixSeenMs = nowMs;
    }
    if (fix && fix.at !== this.fixAt) {
      this.fixAt = fix.at;
      this.fixSeenMs = nowMs;
      if (this.state === "probing") this.probeFixes++;
    }
    if (trust === "TRUSTED") {
      this.trustedOnce = true;
      this.quickProbe = true;
      this.state = "real";
      this.probeEveryMs = TAKEOVER_PROBE_EVERY_MS;
      return false;
    }
    const age = nowMs - this.sinceMs;
    if (this.state === "real") {
      if (sharing && this.lost(nowMs, trust)) {
        const quick = trust === "NO_FIX" && this.quickProbe;
        if (trust === "NO_FIX") this.quickProbe = false;
        this.take(nowMs, quick ? Math.min(TAKEOVER_NO_FIX_FIRST_PROBE_MS, this.probeEveryMs) : this.probeEveryMs);
      }
    } else if (this.state === "taken") {
      if (age >= this.waitMs) {
        this.enter("probing", nowMs);
        this.probeFixAt = fix?.at ?? null;
        this.probeFixes = 0;
      }
    } else if (this.spoofed(trust, fix)) {
      // Waze has just been given it: taken again at once, before the next.
      this.spoofedOffM = fix!.offM;
      this.probeEveryMs = Math.min(this.probeEveryMs * 2, TAKEOVER_PROBE_EVERY_MAX_MS);
      this.take(nowMs, this.probeEveryMs);
    } else if (age >= TAKEOVER_PROBE_MS && (trust !== "REACQUIRING" || age >= TAKEOVER_PROBE_MAX_MS)) {
      this.spoofedOffM = null;
      this.probeEveryMs = TAKEOVER_PROBE_EVERY_MS;
      // Fixes integrity let through came during the probe, only too poor to trust: the phone's GPS works again.
      const back = trust === "NO_FIX" && this.probeFixes >= TAKEOVER_PROBE_BACK_FIXES && !this.silent(nowMs);
      if (back) this.enter("real", nowMs);
      else this.take(nowMs, this.probeEveryMs);
    }
    return this.state === "taken";
  }

  /**
   * GPS is lost for Waze: refused fixes (spoofing) at once; no trusted fix only once the satellite fixes have stopped,
   * and at a trip's start only after a minute unless GPS was trusted already.
   */
  private lost(nowMs: number, trust: TrustState): boolean {
    if (trust !== "NO_FIX") return true;
    if (!this.silent(nowMs)) return false;
    return this.trustedOnce || nowMs - (this.startMs ?? nowMs) >= TAKEOVER_NO_FIX_AFTER_START_MS;
  }

  /** No satellite fix for `TAKEOVER_NO_FIX_SILENT_MS`. */
  private silent(nowMs: number): boolean {
    return nowMs - this.fixSeenMs >= TAKEOVER_NO_FIX_SILENT_MS;
  }

  /** A satellite fix came during the probe, far from the dot, and integrity isn't checking it as GPS coming back. */
  private spoofed(trust: TrustState, fix: ProbeFix | null | undefined): boolean {
    if (!fix || fix.at === this.probeFixAt || trust === "REACQUIRING") return false;
    return fix.offM > Math.max(TAKEOVER_PROBE_FAR_M, TAKEOVER_PROBE_FAR_RADII * fix.radiusM);
  }

  private take(nowMs: number, waitMs: number): void {
    this.waitMs = waitMs;
    this.enter("taken", nowMs);
  }

  private enter(state: GpsTakeoverState, nowMs: number): void {
    this.state = state;
    this.sinceMs = nowMs;
  }
}
