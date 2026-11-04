import type { PropsWithChildren } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated, {
  Easing,
  LinearTransition,
  ReduceMotion,
  withTiming,
  type EntryExitAnimationFunction,
} from "react-native-reanimated";

import { useReduceMotion } from "@/components/ui/reduce-motion";

/** In: eased out, so it arrives quickly and settles; out a little faster, eased in. */
export const APPEAR_IN_MS = 200;
export const APPEAR_OUT_MS = 150;
/** Neighbours move to their new places as long as a panel takes to come in. */
export const MOVE_MS = APPEAR_IN_MS;
/** How far a panel slides from its edge, points: enough to read as coming from there, not to travel. */
const SHIFT = 10;

/** Where a panel comes from: the top stack's from above, the bottom stack's from below, the map's middle in place. */
export type AppearFrom = "top" | "bottom" | "none";

// Reduce Motion is the app's own (`useReduceMotion`, fades only), so Reanimated's (which drops the whole animation)
// stays off.
const IN = { duration: APPEAR_IN_MS, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.Never };
const OUT = { duration: APPEAR_OUT_MS, easing: Easing.in(Easing.cubic), reduceMotion: ReduceMotion.Never };

function fadeIn(shift: number): EntryExitAnimationFunction {
  return () => {
    "worklet";
    return {
      initialValues: { opacity: 0, transform: [{ translateY: shift }] },
      animations: { opacity: withTiming(1, IN), transform: [{ translateY: withTiming(0, IN) }] },
    };
  };
}

function fadeOut(shift: number): EntryExitAnimationFunction {
  return () => {
    "worklet";
    return {
      initialValues: { opacity: 1, transform: [{ translateY: 0 }] },
      animations: { opacity: withTiming(0, OUT), transform: [{ translateY: withTiming(shift, OUT) }] },
    };
  };
}

const SHIFTS: Record<AppearFrom, number> = { top: -SHIFT, bottom: SHIFT, none: 0 };
const ENTERING = { top: fadeIn(SHIFTS.top), bottom: fadeIn(SHIFTS.bottom), none: fadeIn(0) };
const EXITING = { top: fadeOut(SHIFTS.top), bottom: fadeOut(SHIFTS.bottom), none: fadeOut(0) };
const MOVE = LinearTransition.duration(MOVE_MS).easing(Easing.inOut(Easing.cubic)).reduceMotion(ReduceMotion.Never);

/**
 * `Appear`'s coming and going for a panel placed by itself (absolute, as on the lessons' maps): spread on an
 * `Animated.View`. Nothing beside it to move.
 */
export function useAppearing(from: AppearFrom) {
  const edge = useReduceMotion() ? "none" : from;
  return { entering: ENTERING[edge], exiting: EXITING[edge] };
}

/**
 * A map panel that comes and goes (UI-SPEC §4.9): it fades in sliding a few points from its edge (`from`) and fades
 * out back the way it came, and its neighbours in the stack glide to their new places instead of jumping. Reduce
 * Motion: fades only, the neighbours jump. Touches pass through it to the map around its content.
 */
export function Appear({ from, style, children }: PropsWithChildren<{ from: AppearFrom; style?: StyleProp<ViewStyle> }>) {
  const reduceMotion = useReduceMotion();
  const appearing = useAppearing(from);
  return (
    <Animated.View pointerEvents="box-none" style={style} {...appearing} layout={reduceMotion ? undefined : MOVE}>
      {children}
    </Animated.View>
  );
}
