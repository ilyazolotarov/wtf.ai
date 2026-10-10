import type { CompassTrust } from "@/nav/compass/compass";
import type { MapMatchState } from "@/nav/mapmatch/particle-filter";
import type { FixOutcome, NavConfig, Navigator } from "@/nav/navigator";
import type { GnssFix } from "@/nav/types";

const DEG = 180 / Math.PI;

/**
 * The navigator's state changes as trip-log notes, each only when it changes: GNSS integrity, map matching, the
 * position doubt, the compass in shadow (NAVIGATOR-SPEC §7.6: logged, never navigated with), and at the end of a
 * drive the road corrections map matching sent. `reset` with each new navigator.
 */
export class NavigatorNotes {
  /** The latest integrity verdict noted. */
  private integrity: string = "ok";
  /** The doubt last noted. */
  private doubtM: number | undefined;
  private mapMatchState: MapMatchState = "off";
  /** The compass trust last noted, and the trust checks already summarised. */
  private compassTrust: CompassTrust = "none";
  private summarisedChecks = 0;
  /** Road corrections already summarised. */
  private road = { heading: 0, position: 0 };

  constructor(private readonly note: (text: string) => void) {}

  reset(): void {
    this.integrity = "ok";
    this.doubtM = undefined;
    this.mapMatchState = "off";
    this.compassTrust = "none";
    this.summarisedChecks = 0;
    this.road = { heading: 0, position: 0 };
  }

  /**
   * Integrity's verdict when it changes (SPEC §3.3): `gnss integrity <verdict>: <why>` with the fix's accuracy; back
   * to `ok` with how trust came back.
   */
  fixOutcome(out: FixOutcome, fix: GnssFix): void {
    const v = out.integrity;
    if (!v || v === this.integrity) return;
    // A refusal's follow-ups (still refused, reacquiring) aren't news unless they carry a reason.
    if ((v === "untrusted" || v === "reacquiring") && !out.integrityDetail && this.integrity !== "ok") {
      this.integrity = v;
      return;
    }
    this.integrity = v;
    const off = out.errorM === undefined ? "" : `, ${Math.round(out.errorM)} m from the dead reckoning`;
    this.note(`gnss integrity ${v}${out.integrityDetail ? `: ${out.integrityDetail}` : ""} (fix ±${Math.round(fix.hAccM)} m${v === "ok" ? "" : off})`);
  }

  /** Map-match state changes, except the flips between tracking and multimodal. */
  mapMatch(nav: Navigator, state: MapMatchState): void {
    const onRoad = (s: MapMatchState) => s === "tracking" || s === "multimodal";
    if (state === this.mapMatchState || (onRoad(state) && onRoad(this.mapMatchState))) return;
    const mm = nav.estimate()?.mapMatch;
    this.mapMatchState = state;
    this.note(`mm ${state}${mm ? ` (${mm.particles} particles, ${mm.clusters.length} hypotheses)` : ""}`);
  }

  /** The coarse fixes agreeing the track is lost, and letting go of that doubt. */
  doubt(doubtM: number | undefined): void {
    const was = this.doubtM;
    this.doubtM = doubtM;
    if ((was === undefined) === (doubtM === undefined)) return;
    this.note(
      doubtM === undefined
        ? "nav position doubt cleared: a fix agrees with the dead reckoning again"
        : `nav position doubted: Wi-Fi/cell fixes put the car ${Math.round(doubtM)} m from the dead reckoning`,
    );
  }

  /** The heading just became known: what the compass said at that moment. */
  compassAtStart(nav: Navigator): void {
    const off = compassOff(nav);
    this.note(`nav compass at start: ${off === null ? "none" : `${off.toFixed(0)}° off`} (${nav.compassTrust})`);
  }

  /** A stored calibration checked against the known heading: confirmed or rejected. */
  compassTrustChange(nav: Navigator): void {
    if (nav.compassTrust === this.compassTrust) return;
    const before = this.compassTrust;
    this.compassTrust = nav.compassTrust;
    const diffs = nav.compassCheckDiffs.slice(-10).map((d) => Math.abs(d) * DEG);
    const median = diffs.length ? ` (median ${percentile(diffs, 0.5).toFixed(0)}° over ${diffs.length} checks)` : "";
    this.note(`nav compass ${before} → ${nav.compassTrust}${median}`);
  }

  /** At the end of a drive: how the compass did against the known heading. */
  compassSummary(nav: Navigator): void {
    const diffs = nav.compassCheckDiffs.map((d) => Math.abs(d) * DEG);
    if (diffs.length === this.summarisedChecks) return;
    this.summarisedChecks = diffs.length;
    this.note(
      `nav compass drive: ${nav.compassTrust}, ${diffs.length} checks, median ${percentile(diffs, 0.5).toFixed(0)}°, ` +
        `p90 ${percentile(diffs, 0.9).toFixed(0)}°, ${nav.compassCalibrations.length} mounting(s) kept`,
    );
  }

  /** At the end of a drive: the road corrections map matching sent the navigator, and how many it refused. */
  roadCorrections(nav: Navigator, loop: NavConfig["mapMatchLoop"]): void {
    const s = nav.stats;
    if (loop === "open") return;
    const heading = s.roadHeadingAccepted + s.roadHeadingRejected;
    const position = s.roadPositionAccepted + s.roadPositionRejected;
    if (heading === this.road.heading && position === this.road.position) return;
    this.road = { heading, position };
    this.note(
      `mm loop ${loop}: road heading ${s.roadHeadingAccepted} (${s.roadHeadingRejected} refused), ` +
        `road position ${s.roadPositionAccepted} (${s.roadPositionRejected} refused)`,
    );
  }
}

/** Compass heading minus the EKF heading now, degrees (null: either unknown). */
export function compassOff(nav: Navigator): number | null {
  const compass = nav.compassHeading;
  const heading = nav.estimate()?.headingRad;
  if (!compass || heading === undefined) return null;
  return Math.atan2(Math.sin(compass.psi - heading), Math.cos(compass.psi - heading)) * DEG;
}

function percentile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
