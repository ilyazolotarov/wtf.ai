import { Fragment } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";

/** Labelled rows under a lesson's map: "The app" / "You", "When" / "Also". */
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

const styles = StyleSheet.create({
  card: { borderRadius: Radius.rL, paddingHorizontal: 16, paddingVertical: 4, borderCurve: "continuous" },
  line: { height: StyleSheet.hairlineWidth },
  explainRow: { flexDirection: "row", gap: 12, paddingVertical: 12 },
  explainLabel: { width: 72, paddingTop: 2, letterSpacing: 0.3 },
  explainText: { flex: 1, lineHeight: 20 },
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
});
