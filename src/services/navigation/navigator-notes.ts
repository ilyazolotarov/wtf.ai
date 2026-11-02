import type { MapMatchState } from "@/nav/mapmatch/particle-filter";
import type { FixOutcome } from "@/nav/navigator";
import type { GnssFix } from "@/nav/types";

import type { NavView } from "./navigator-host";

/**
 * The navigator's state changes as trip-log notes, each only when it changes: GNSS integrity, map matching, the
 * position doubt, and at the end of a drive the road corrections map matching sent. `reset` with each new navigator.
 */
export class NavigatorNotes {
  /** The latest integrity verdict noted. */
  private integrity: string = "ok";
  /** The doubt last noted. */
  private doubtM: number | undefined;
  private mapMatchState: MapMatchState = "off";
  /** Road corrections already summarised. */
  private road = { heading: 0, position: 0 };

  constructor(private readonly note: (text: string) => void) {}

  reset(): void {
    this.integrity = "ok";
    this.doubtM = undefined;
    this.mapMatchState = "off";
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
  mapMatch(nav: NavView, state: MapMatchState): void {
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

  /** At the end of a drive: the road corrections map matching sent the navigator, and how many it refused. */
  roadCorrections(nav: NavView): void {
    const s = nav.stats;
    const heading = s.roadHeadingAccepted + s.roadHeadingRejected;
    const position = s.roadPositionAccepted + s.roadPositionRejected;
    if (heading === this.road.heading && position === this.road.position) return;
    this.road = { heading, position };
    this.note(
      `mm loop closed: road heading ${s.roadHeadingAccepted} (${s.roadHeadingRejected} refused), ` +
        `road position ${s.roadPositionAccepted} (${s.roadPositionRejected} refused)`,
    );
  }
}
