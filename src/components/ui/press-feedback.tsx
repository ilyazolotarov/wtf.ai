import { createContext, useContext, useState, type Ref } from "react";
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  type GestureResponderEvent,
  type PressableInstance,
  type PressableProps,
  type ViewStyle,
} from "react-native";

import { useReduceMotion } from "@/components/ui/reduce-motion";
import { Radius, usePalette } from "@/constants/theme";

import { pressFeedback } from "./press-timing";

/**
 * A button, chip, pill or tab shrinks a little and dims; a full-width row or card is tinted where it stands (scaled
 * from its centre, a list row would pull away from its separators and the card's edges).
 */
export type PressLook = "button" | "row";

const PRESSED_OPACITY = 0.55;
const PRESSED_SCALE = 0.94;
/** The row tint: the text colour, so it darkens in light and lightens in dark. */
const ROW_TINT_OPACITY = 0.14;

const EASE_IN = Easing.out(Easing.quad);
const EASE_OUT = Easing.inOut(Easing.quad);

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const RADII = [
  "borderRadius",
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomLeftRadius",
  "borderBottomRightRadius",
] as const;

/** How far a bare row's tint reaches into its card's padding on each side (cards and groups pad 12–16). */
const ROW_BLEED = 8;

/**
 * A row's place in a grouped card (`ScreenSection`): the card's side padding and corners, and whether the row is its
 * first or last. Its tint then fills the row's whole slot in the card, out to the card's edges and, at the top and
 * bottom, its round corners: a card of one row is tinted whole.
 */
export interface RowSlot {
  padding: number;
  radius: number;
  first: boolean;
  last: boolean;
}

export const RowSlotContext = createContext<RowSlot | null>(null);

/**
 * Where a row's tint goes: over the row's own shape when it has a fill or corners; its slot in a grouped card; else, on
 * a bare row in a card, a band with round corners a little wider than the row, so it doesn't stop square at the text.
 */
function tintShape(own: ViewStyle, slot: RowSlot | null): ViewStyle {
  const radii = RADII.filter((k) => own[k] != null);
  if (radii.length === 0 && own.backgroundColor == null) {
    if (slot) {
      const top = slot.first ? slot.radius : 0;
      const bottom = slot.last ? slot.radius : 0;
      return {
        ...StyleSheet.absoluteFill,
        left: -slot.padding,
        right: -slot.padding,
        borderTopLeftRadius: top,
        borderTopRightRadius: top,
        borderBottomLeftRadius: bottom,
        borderBottomRightRadius: bottom,
      };
    }
    return { ...StyleSheet.absoluteFill, left: -ROW_BLEED, right: -ROW_BLEED, borderRadius: Radius.r };
  }
  return { ...StyleSheet.absoluteFill, ...Object.fromEntries(radii.map((k) => [k, own[k]])) };
}

export type PressableFeedbackProps = PressableProps & {
  look?: PressLook;
  ref?: Ref<PressableInstance>;
};

/**
 * `Pressable` with the app's press feedback (UI-SPEC §4.8): eased in on the touch, held long enough for a quick tap to
 * be seen, eased out; none while disabled; no shrinking with Reduce Motion. Its style goes on the pressable itself, so
 * it lays out as a plain `Pressable` would. A style or children function still gets `pressed`.
 */
export function PressableFeedback({
  look = "button",
  style,
  children,
  disabled,
  onPressIn,
  onPressOut,
  onPress,
  onLongPress,
  ref,
  ...rest
}: PressableFeedbackProps) {
  const palette = usePalette();
  const reduceMotion = useReduceMotion();
  const slot = useContext(RowSlotContext);
  const [progress] = useState(() => new Animated.Value(0));
  const [feedback] = useState(() =>
    pressFeedback(Date.now, (toValue, duration, delay) =>
      Animated.timing(progress, {
        toValue,
        duration,
        delay,
        easing: toValue ? EASE_IN : EASE_OUT,
        useNativeDriver: true,
      }).start(),
    ),
  );
  const [pressed, setPressed] = useState(false);
  // Re-rendered on a press only when the style or children ask for it.
  const watchesPressed = typeof style === "function" || typeof children === "function";

  // Hover is web only, and the app runs on phones.
  const state = { pressed, hovered: false };
  const own = StyleSheet.flatten(typeof style === "function" ? style(state) : style) ?? {};
  // The call site's own opacity (a disabled look) under the pressed look: a value of its own, set when it changes. Once
  // a press has run on the native driver, a new interpolation's opacity never reached the view: a button disabled as
  // its own press took effect (the placing card's Here turning into Confirm) stayed dim once enabled.
  const base = typeof own.opacity === "number" ? own.opacity : 1;
  const [baseOpacity] = useState(() => new Animated.Value(base));
  const [opacity] = useState(() =>
    Animated.multiply(baseOpacity, progress.interpolate({ inputRange: [0, 1], outputRange: [1, PRESSED_OPACITY] })),
  );
  // Set while rendering, not in an effect: React commits the node's JS-side value as the view's opacity from this very
  // render, and a value set by an effect reached the view after it, in either order with the native driver's update.
  // A button enabled again after a page where it was disabled (onboarding's car page, searching) kept the dim look
  // until something else rendered it again.
  const [baseSet, setBaseSet] = useState(base);
  if (baseSet !== base) {
    setBaseSet(base);
    baseOpacity.setValue(base);
  }
  let animated: Animated.WithAnimatedValue<ViewStyle> | null = null;
  if (look === "button") {
    // The call site's transform is kept under the pressed look too.
    const scale = progress.interpolate({ inputRange: [0, 1], outputRange: [1, reduceMotion ? 1 : PRESSED_SCALE] });
    animated =
      own.transform == null
        ? { opacity, transform: [{ scale }] }
        : Array.isArray(own.transform)
          ? { opacity, transform: [...own.transform, { scale }] }
          : { opacity };
  }

  const content = typeof children === "function" ? children(state) : children;
  return (
    <AnimatedPressable
      {...rest}
      ref={ref}
      disabled={disabled}
      style={animated ? [own, animated] : own}
      onPress={
        onPress &&
        ((e: GestureResponderEvent) => {
          feedback.press();
          onPress(e);
        })
      }
      onLongPress={
        onLongPress &&
        ((e: GestureResponderEvent) => {
          feedback.press();
          onLongPress(e);
        })
      }
      onPressIn={(e: GestureResponderEvent) => {
        if (!disabled) feedback.pressIn();
        if (watchesPressed) setPressed(true);
        onPressIn?.(e);
      }}
      onPressOut={(e: GestureResponderEvent) => {
        feedback.pressOut();
        if (watchesPressed) setPressed(false);
        onPressOut?.(e);
      }}
    >
      {look === "row" && (
        <Animated.View
          pointerEvents="none"
          style={[
            tintShape(own, slot),
            {
              backgroundColor: palette.text,
              opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0, ROW_TINT_OPACITY] }),
            },
          ]}
        />
      )}
      {content}
    </AnimatedPressable>
  );
}
