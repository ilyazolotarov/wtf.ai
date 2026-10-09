import { createContext, Fragment, useContext, useEffect, useState, type PropsWithChildren } from "react";
import { Animated, Pressable, StyleSheet, View, type DimensionValue } from "react-native";

import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";

/** Labelled rows under a lesson's map: "The app" / "You", "When" / "Also". Each label sits above its text, so a
 * long one (Ukrainian "Застосунок") never breaks mid-word. */
export function ExplainCard({ rows }: { rows: { label: string; text: string; strong?: boolean }[] }) {
  const palette = usePalette();
  return (
    <View style={[styles.card, { backgroundColor: palette.groupBg }]}>
      {rows.map((row, i) => (
        <Fragment key={row.label}>
          {i > 0 && <View style={[styles.line, { backgroundColor: palette.line }]} />}
          <View style={styles.explainRow}>
            <T w="semibold" size={12} color={palette.text2} style={styles.explainLabel}>
              {row.label.toUpperCase()}
            </T>
            <T w={row.strong ? "medium" : "regular"} size={14} style={styles.explainText}>
              {row.text}
            </T>
          </View>
        </Fragment>
      ))}
    </View>
  );
}

/** One-of choices as pills, each with a coloured dot (trust states, the car button's colours). */
export function ChoiceChips<K extends string>({
  options,
  value,
  onChange,
  columns,
}: {
  options: { value: K; label: string; color: string }[];
  value: K;
  onChange(value: K): void;
  /** Equal-width grid instead of wrapping to content. */
  columns?: number;
}) {
  const palette = usePalette();
  return (
    <View style={styles.chips} accessibilityRole="radiogroup">
      {options.map((option) => {
        const on = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            style={({ pressed }) => [
              styles.chip,
              columns ? { width: `${100 / columns - 2}%` } : null,
              { borderColor: on ? palette.accent : palette.line, backgroundColor: on ? palette.groupBg : "transparent" },
              pressed && styles.pressed,
            ]}
          >
            <View style={[styles.chipDot, { backgroundColor: option.color }]} />
            <T w="medium" size={14}>
              {option.label}
            </T>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The lesson's lead paragraph. */
export function LessonIntro({ children }: { children: string }) {
  const palette = usePalette();
  return (
    <T size={15} color={palette.text2} style={styles.intro}>
      {children}
    </T>
  );
}

/** Lets a lesson stop its screen scrolling while a finger drags its map (the lesson screen provides it). */
export const ScrollLockContext = createContext<(locked: boolean) => void>(() => undefined);

export function useScrollLock(): (locked: boolean) => void {
  return useContext(ScrollLockContext);
}

/** Fades its children in when mounted: key it by what it shows to fade between states. */
export function FadeIn({ children, ms = 400 }: PropsWithChildren<{ ms?: number }>) {
  const [opacity] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(opacity, { toValue: 1, duration: ms, useNativeDriver: true }).start();
  }, [opacity, ms]);
  return <Animated.View style={{ opacity }}>{children}</Animated.View>;
}

/** A ring growing out of a point over a lesson map: press and hold here. `left`/`top` are its centre. */
export function PulseRing({ left, top, size = 80 }: { left: DimensionValue; top: DimensionValue; size?: number }) {
  const palette = usePalette();
  const [progress] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(progress, { toValue: 1, duration: 1400, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [progress]);
  return (
    <View pointerEvents="none" style={[styles.ringAnchor, { left, top }]}>
      <Animated.View
        style={{
          width: size,
          height: size,
          marginLeft: -size / 2,
          marginTop: -size / 2,
          borderRadius: size / 2,
          borderWidth: 3,
          borderColor: palette.accent,
          opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0] }),
          transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1.4] }) }],
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: Radius.rL, paddingHorizontal: 16, paddingVertical: 4, borderCurve: "continuous" },
  line: { height: StyleSheet.hairlineWidth },
  explainRow: { gap: 4, paddingVertical: 12 },
  explainLabel: { letterSpacing: 0.3 },
  explainText: { lineHeight: 20 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    height: 42,
    borderRadius: Radius.pill,
    borderWidth: 1.5,
    paddingLeft: 12,
    paddingRight: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  chipDot: { width: 10, height: 10, borderRadius: 5 },
  pressed: { opacity: 0.75 },
  intro: { lineHeight: 21 },
  ringAnchor: { position: "absolute", width: 0, height: 0, overflow: "visible" },
});
