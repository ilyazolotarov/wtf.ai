import type { PropsWithChildren } from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { GlassFill } from "@/components/ui/glass-fill";
import { Icon, type IconName } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";

// The map screen's floating cards and chips (index.tsx: alertCard, ghostButton, chip), for the lessons' maps.

/** A card over the map: glass, the map's shadow; place it with `style` (absolute). */
export function MapCard({ style, children }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  const palette = usePalette();
  return (
    <View style={[styles.card, { boxShadow: palette.shadow }, style]}>
      <GlassFill radius={Radius.rL} />
      {children}
    </View>
  );
}

/** The card's icon, title and text. */
export function MapCardHeader({
  icon,
  tone = "accent",
  title,
  body,
  onClose,
  closeLabel,
}: {
  icon: IconName;
  tone?: "accent" | "warn";
  title: string;
  body?: string;
  /** A ✕ at the right (the dropped pin's card). */
  onClose?: () => void;
  closeLabel?: string;
}) {
  const palette = usePalette();
  const color = tone === "warn" ? palette.warn.c : palette.accent;
  return (
    <View style={styles.row}>
      <View style={[styles.icon, { backgroundColor: tone === "warn" ? palette.warn.a : palette.accentA }]}>
        <Icon name={icon} size={20} color={color} />
      </View>
      <View style={styles.text}>
        <T w="semibold" size={15}>
          {title}
        </T>
        {body ? (
          <T size={13} color={palette.text2} style={styles.body}>
            {body}
          </T>
        ) : null}
      </View>
      {onClose && (
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={closeLabel}>
          <Icon name="close" size={20} color={palette.text2} />
        </Pressable>
      )}
    </View>
  );
}

/** The card's answers, side by side, as the map's (Cancel / Here, Yes / No). */
export function MapCardButtons({
  buttons,
}: {
  buttons: { label: string; onPress(): void; muted?: boolean; disabled?: boolean }[];
}) {
  const palette = usePalette();
  return (
    <View style={styles.buttons}>
      {buttons.map((button) => (
        <Pressable
          key={button.label}
          onPress={button.onPress}
          disabled={button.disabled}
          accessibilityRole="button"
          accessibilityState={{ disabled: button.disabled }}
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: palette.surface },
            button.disabled && styles.disabled,
            pressed && styles.pressed,
          ]}
        >
          <T w="semibold" size={14} color={button.muted ? palette.text2 : palette.accent}>
            {button.label}
          </T>
        </Pressable>
      ))}
    </View>
  );
}

/** The map's chip ("Set your position on the map", "Position set manually · …"). */
export function MapChipButton({
  icon,
  label,
  onPress,
  onClose,
  closeLabel,
  style,
}: {
  icon: IconName;
  label: string;
  onPress?: () => void;
  onClose?: () => void;
  closeLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const palette = usePalette();
  return (
    <View style={[styles.chip, { boxShadow: palette.shadow }, style]}>
      <GlassFill radius={Radius.pill} />
      <Pressable
        onPress={onPress}
        disabled={!onPress}
        accessibilityRole="button"
        style={({ pressed }) => [styles.chipBody, pressed && styles.pressed]}
      >
        <Icon name={icon} size={16} color={palette.accent} />
        <T w="semibold" size={13} color={palette.accent} numberOfLines={1}>
          {label}
        </T>
      </Pressable>
      {onClose && (
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={closeLabel}>
          <Icon name="close" size={16} color={palette.text2} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { position: "absolute", left: 10, right: 10, gap: 12, padding: 16, borderRadius: Radius.rL, borderCurve: "continuous" },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  icon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  text: { flex: 1, gap: 2 },
  body: { lineHeight: 18 },
  buttons: { flexDirection: "row", gap: 8 },
  button: { flex: 1, alignItems: "center", paddingHorizontal: 16, paddingVertical: 10, borderRadius: 18 },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.75 },
  chip: {
    position: "absolute",
    maxWidth: "94%",
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingLeft: 12,
    paddingRight: 14,
    borderRadius: Radius.pill,
    borderCurve: "continuous",
  },
  chipBody: { flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 8 },
});
