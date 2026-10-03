import type { TrustState } from "@/nav/position/types";

/**
 * Interim GNSS trust for the phone-only source, until `src/nav/integrity` exists.
 *
 * Under jamming iOS falls back to Wi-Fi/cell fixes (±8–300 m, ~0.1 Hz) with real
 * GPS fixes leaking through in between. Those coarse fixes are "no GNSS" (SPEC §3.3)
 * however accurate they claim to be: they carry no speed, a satellite fix always does
 * (0 when standing). Good Wi-Fi coverage gives ±8–20 m, which used to flip trust on.
 * Deciding per fix makes the status flicker, so trust is decided over time:
 * - lost when no good fix (≤ 50 m) has arrived for 8 s, which covers both gaps and
 *   a run of coarse fixes, while a single coarse fix in a 1 Hz stream is ignored;
 * - regained only after fixes ≤ 30 m have kept arriving for 5 s with no coarse fix
 *   or gap in between, so one leaked GPS fix doesn't flip it back.
 */
const GOOD_ACCURACY_M = 50;
const REGAIN_ACCURACY_M = 30;
const LOSE_AFTER_MS = 8000;
const REGAIN_AFTER_MS = 5000;

export class GnssTrustTracker {
  private trusted = false;
  private lastGoodAt = -Infinity;
  /** Start of the current streak of regain-quality fixes while untrusted. */
  private streakSince: number | null = null;
  private lastFixAt = -Infinity;
  /** Time of the last fix that arrived while trusted and good. */
  lastTrustedFixAt: number | undefined;

  /** `satellite`: the fix has a valid speed (Wi-Fi/cell fixes don't). */
  onFix(accuracyM: number, at: number, satellite = true): TrustState {
    const gap = at - this.lastFixAt;
    this.lastFixAt = at;
    const good = satellite && accuracyM <= GOOD_ACCURACY_M;
    if (good) this.lastGoodAt = at;

    if (this.trusted) {
      this.check(at);
    } else if (satellite && accuracyM <= REGAIN_ACCURACY_M) {
      if (this.streakSince == null || gap > LOSE_AFTER_MS) this.streakSince = at;
      // The very first fix has nothing to have been distrusted against: accept it.
      if (this.lastTrustedFixAt == null || at - this.streakSince >= REGAIN_AFTER_MS) {
        this.trusted = true;
        this.streakSince = null;
      }
    } else {
      this.streakSince = null;
    }

    if (this.trusted && good) this.lastTrustedFixAt = at;
    return this.state();
  }

  /** Called on a timer: trust lapses when good fixes stop arriving. */
  check(now: number): TrustState {
    if (this.trusted && now - this.lastGoodAt > LOSE_AFTER_MS) {
      this.trusted = false;
      this.streakSince = null;
    }
    return this.state();
  }

  private state(): TrustState {
    return this.trusted ? "TRUSTED" : "NO_FIX";
  }
}
