/**
 * When the pressed look comes and goes (UI-SPEC §4.8). A tap shows for at least `PRESS_HOLD_MS` before it eases out,
 * so a quick tap (50 ms, or a scripted one on a recording) is seen; a touch that turns into a scroll lets go at once.
 */

/** Easing into the pressed look. */
export const PRESS_IN_MS = 80;
/** The least time a tap's pressed look stays, from the touch. */
export const PRESS_HOLD_MS = 150;
/** Easing back out. */
export const PRESS_OUT_MS = 220;

/** Runs one easing of the pressed look: to 1 (pressed) or 0 (at rest), starting after `delay`. */
export type PressAnimate = (to: 0 | 1, duration: number, delay: number) => void;

export interface PressFeedback {
  pressIn(): void;
  /** The press counted as a tap or a long press (comes before or after `pressOut`, in the same task or later). */
  press(): void;
  pressOut(): void;
}

/** How long a tap's pressed look still holds at `now`. */
export function holdLeft(pressedAt: number, now: number): number {
  return Math.max(0, Math.min(PRESS_HOLD_MS, PRESS_HOLD_MS - (now - pressedAt)));
}

/**
 * The press events turned into easings. Each easing replaces the one running, so a touch while the look eases out
 * starts over from where it is. `defer` waits for the press that may follow a press-out in the same task.
 */
export function pressFeedback(
  now: () => number,
  animate: PressAnimate,
  defer: (run: () => void) => void = queueMicrotask,
): PressFeedback {
  let pressedAt = 0;
  let tapped = false;
  return {
    pressIn() {
      pressedAt = now();
      tapped = false;
      animate(1, PRESS_IN_MS, 0);
    },
    press() {
      tapped = true;
    },
    pressOut() {
      defer(() => animate(0, PRESS_OUT_MS, tapped ? holdLeft(pressedAt, now()) : 0));
    },
  };
}
