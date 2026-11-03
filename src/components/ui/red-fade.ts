import { Easing, FadeIn, FadeOut, ReduceMotion, withSequence, withTiming, type SharedValue } from "react-native-reanimated";

/** A warning's red fades in over its panel and out again: quick, so the text's colour change is barely ahead of it. */
export const RED_FADE_MS = 150;

// A fade moves nothing: it stays with Reduce Motion.
export const RED_IN = FadeIn.duration(RED_FADE_MS).reduceMotion(ReduceMotion.Never);
export const RED_OUT = FadeOut.duration(RED_FADE_MS).reduceMotion(ReduceMotion.Never);

/** The pulse's peak: enough for the eye to catch at the edge of sight, not enough to move the text around it. */
const PULSE_SCALE = 1.06;

/** One pulse (out 120 ms, back 200 ms) as a warning turns red. Not with Reduce Motion: the caller skips it. */
export function pulse(scale: SharedValue<number>) {
  scale.value = withSequence(
    withTiming(PULSE_SCALE, { duration: 120, easing: Easing.out(Easing.quad) }),
    withTiming(1, { duration: 200, easing: Easing.inOut(Easing.quad) }),
  );
}
