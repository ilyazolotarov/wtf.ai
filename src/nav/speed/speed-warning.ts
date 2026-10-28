// Too fast for the limit (UI-SPEC §6.4): only past the driver's margin over it. Fines in Ukraine start at 21 km/h over
// the limit (Code of Administrative Offences, art. 122), so up to the margin the driver is fine and nothing changes.

/** The margins Settings offers, km/h over the limit; the default leaves 5 km/h before a fine. */
export const SPEED_MARGINS_KPH = [10, 15, 20] as const;
export type SpeedMarginKph = (typeof SPEED_MARGINS_KPH)[number];
export const DEFAULT_SPEED_MARGIN_KPH: SpeedMarginKph = 15;

/** Over the margin this long before the warning: a moment of overtaking or a speed spike doesn't set it off, ms. */
const ENTER_AFTER_MS = 1500;
/** The warning ends this far back under the line, km/h: hovering at the line neither flickers nor chimes again. */
const LEAVE_BELOW_KPH = 3;
/**
 * A warning outlasts a gap in the limit (or the speed) this long, ms: the sign goes while the roads disagree (a long
 * junction, map matching torn for a moment) and comes back, and a driver who stayed too fast meanwhile isn't chimed at
 * again. Longer, it ends: the stretch it was for is over.
 */
const KEEP_THROUGH_GAP_MS = 30_000;

export interface SpeedWarningState {
  /** Too fast: the speed shows red. */
  over: boolean;
  /** The warning has just started: chime once. */
  chime: boolean;
}

/**
 * Turns speed and limit into the warning: on after `ENTER_AFTER_MS` above limit + margin, off once `LEAVE_BELOW_KPH`
 * under it, or after `KEEP_THROUGH_GAP_MS` without a limit (not red meanwhile: there is no sign to be over). One chime
 * per warning; the next only after the speed came back under.
 */
export class SpeedWarning {
  private overSinceMs: number | null = null;
  private gapSinceMs: number | null = null;
  private on = false;

  update(speedKph: number | undefined, limitKph: number | undefined, marginKph: number, nowMs: number): SpeedWarningState {
    if (speedKph === undefined || limitKph === undefined) {
      if (!this.on) return this.off();
      this.gapSinceMs ??= nowMs;
      if (nowMs - this.gapSinceMs >= KEEP_THROUGH_GAP_MS) return this.off();
      return { over: false, chime: false };
    }
    this.gapSinceMs = null;
    const line = limitKph + marginKph;
    if (this.on) {
      if (speedKph <= line - LEAVE_BELOW_KPH) return this.off();
      return { over: true, chime: false };
    }
    if (speedKph <= line) return this.off();
    this.overSinceMs ??= nowMs;
    if (nowMs - this.overSinceMs < ENTER_AFTER_MS) return { over: false, chime: false };
    this.on = true;
    return { over: true, chime: true };
  }

  private off(): SpeedWarningState {
    this.on = false;
    this.overSinceMs = null;
    this.gapSinceMs = null;
    return { over: false, chime: false };
  }
}
