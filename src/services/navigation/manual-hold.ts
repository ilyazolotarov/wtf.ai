import { haversineM } from "@/nav/geo";
import type { GnssFix } from "@/nav/types";

import type { CalibrationStore, StoredManualPosition } from "./calibration-store";

/** The driver's placing on the map: a car's length or so, and the heading of a tap (NAVIGATOR-SPEC §6.2). */
export const USER_POSITION_SIGMA_M = 10;
export const USER_HEADING_SIGMA_RAD = (15 * Math.PI) / 180;
/** A position set on the map is asked about ("are you still here?") this long after it was confirmed (§6.3). */
export const MANUAL_ASK_AFTER_MS = 15 * 60_000;
/** Trusted satellite fixes in a row that disagree with the placing before GPS takes over (the EKF's rule too). */
const MANUAL_REJECTED_FIXES = 5;

/**
 * Where the driver set the car on the map (NAVIGATOR-SPEC §6.3), held until released or discarded. Stored, so it
 * outlives the session; what it does to the navigator is the service's.
 */
export class ManualHold {
  private held: StoredManualPosition | null;
  /** The running navigator started from it. */
  applied = false;
  /** Trusted satellite fixes in a row that disagree with it. */
  private rejected = 0;
  private notedAsk = false;

  constructor(
    private readonly store: Pick<CalibrationStore, "manualPosition" | "saveManualPosition">,
    private readonly nowMs: () => number,
  ) {
    this.held = store.manualPosition();
  }

  get current(): StoredManualPosition | null {
    return this.held;
  }

  /** Set or confirmed by the driver. */
  hold(m: StoredManualPosition): void {
    this.held = m;
    this.notedAsk = false;
    this.store.saveManualPosition(m);
  }

  /** No longer held; a navigator started from it carries on. */
  drop(): void {
    this.held = null;
    this.applied = false;
    this.rejected = 0;
    this.store.saveManualPosition(null);
  }

  /** The navigator now starts from it (true), or a new navigator didn't (false). */
  setApplied(applied: boolean): void {
    this.applied = applied;
    this.rejected = 0;
  }

  /** It is 15 min since the driver confirmed it: "are you still here?". */
  asking(): boolean {
    return this.held !== null && this.nowMs() - this.held.confirmedAt >= MANUAL_ASK_AFTER_MS;
  }

  /** The trip-log note the first time it is asking (null: not asking, or already noted). */
  askNote(): string | null {
    if (!this.asking() || this.notedAsk) return null;
    this.notedAsk = true;
    return "nav manual position 15 min old: asking the driver if they are still there";
  }

  /**
   * A trusted satellite fix (integrity passed it, GNSS trusted) that agrees releases it to GPS; so do 5 in a row that
   * disagree. Returns the release's trip-log note (null: still held).
   */
  checkAgainst(fix: GnssFix): string | null {
    const m = this.held;
    if (!m) return null;
    const d = haversineM(m, fix);
    const accM = fix.hAccM;
    if (d <= 3 * Math.hypot(accM, USER_POSITION_SIGMA_M)) {
      this.drop();
      return `nav manual position released: GPS trusted, fix ${Math.round(d)} m away (±${Math.round(accM)} m)`;
    }
    if (++this.rejected >= MANUAL_REJECTED_FIXES) {
      const n = this.rejected;
      this.drop();
      return `nav manual position released: ${n} trusted GPS fixes disagree, the last ${Math.round(d)} m away`;
    }
    return null;
  }
}
