import { useEffect, useState } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import type { SavedKind } from "@/services/navigation/places-store";

/**
 * Confirmation under a destination just saved (or removed): "Added to quick picks as Home",
 * what it replaced, and Undo. Fades and slides in so the tap visibly did something.
 */
export function SaveConfirmation({
  kind,
  replaced,
  onUndo,
}: {
  /** null: removed from quick picks. */
  kind: SavedKind | null;
  /** The Home or Work it replaced. */
  replaced: string | null;
  onUndo(): void;
}) {
  const { t } = useT();
  const palette = usePalette();
  const [shown] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.spring(shown, { toValue: 1, useNativeDriver: true, speed: 18, bounciness: 6 }).start();
  }, [shown]);

  const message =
    kind === null
      ? t("removedFromQuickPicks")
      : t(kind === "home" ? "addedAsHome" : kind === "work" ? "addedAsWork" : "addedToQuickPicks");
  const color = kind === null ? palette.text2 : palette.ok.c;

  return (
    <Animated.View
      accessibilityLiveRegion="polite"
      style={[
        styles.strip,
        { backgroundColor: kind === null ? palette.surface : palette.ok.a },
        {
          opacity: shown,
          transform: [
            { translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [-6, 0] }) },
            { scale: shown.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) },
          ],
        },
      ]}
    >
      <Icon name={kind === null ? "delete" : "check_circle"} size={18} color={color} />
      <View style={styles.copy}>
        <T w="semibold" size={14} color={kind === null ? palette.text : color}>
          {message}
        </T>
        {replaced && (
          <T size={12} color={palette.text2} fit>
            {t("replacedPlace").replace("{name}", replaced)}
          </T>
        )}
      </View>
      <Pressable onPress={onUndo} accessibilityRole="button" hitSlop={8} style={({ pressed }) => [styles.undo, pressed && styles.pressed]}>
        <T w="semibold" size={14} color={palette.accent}>
          {t("undo")}
        </T>
      </Pressable>
    </Animated.View>
  );
}

/** A soft accent glow over a list row that fades out once: "here is what you just saved". */
export function Flash({ onDone }: { onDone(): void }) {
  const palette = usePalette();
  const [glow] = useState(() => new Animated.Value(1));
  useEffect(() => {
    Animated.timing(glow, { toValue: 0, duration: 1600, delay: 250, useNativeDriver: true }).start(() => onDone());
    // Once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.flash, { backgroundColor: palette.accentA, opacity: glow }]}
    />
  );
}

const styles = StyleSheet.create({
  // A pill on one line; at a large text size Undo goes under the message, on the right, instead of squeezing it.
  strip: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: 10,
    rowGap: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: Radius.rL,
  },
  copy: { flex: 1, minWidth: "60%", gap: 1 },
  undo: { marginLeft: "auto" },
  pressed: { opacity: 0.6 },
  flash: { marginHorizontal: -8, borderRadius: 12 },
});
