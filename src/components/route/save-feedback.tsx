import { useEffect, useState } from "react";
import { Animated, StyleSheet, View } from "react-native";

import { Icon, type IconName } from "@/components/ui/icon";
import { PressableFeedback } from "@/components/ui/press-feedback";
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
  const message =
    kind === null
      ? t("removedFromQuickPicks")
      : t(kind === "home" ? "addedAsHome" : kind === "work" ? "addedAsWork" : "addedToQuickPicks");
  return (
    <UndoStrip
      done={kind !== null}
      icon={kind === null ? "delete" : "check_circle"}
      message={message}
      detail={replaced ? t("replacedPlace").replace("{name}", replaced) : undefined}
      onUndo={onUndo}
    />
  );
}

/**
 * A change just made and Undo (a place saved, a stop added on the way): green with a check when something was added,
 * grey when removed. Fades and slides in so the tap visibly did something.
 */
export function UndoStrip({
  done,
  icon,
  message,
  detail,
  onUndo,
}: {
  /** Added (green), or removed (grey). */
  done: boolean;
  icon: IconName;
  message: string;
  detail?: string;
  onUndo(): void;
}) {
  const { t } = useT();
  const palette = usePalette();
  const [shown] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.spring(shown, { toValue: 1, useNativeDriver: true, speed: 18, bounciness: 6 }).start();
  }, [shown]);
  const color = done ? palette.ok.c : palette.text2;

  return (
    <Animated.View
      accessibilityLiveRegion="polite"
      style={[
        styles.strip,
        { backgroundColor: done ? palette.ok.a : palette.surface },
        {
          opacity: shown,
          transform: [
            { translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [-6, 0] }) },
            { scale: shown.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) },
          ],
        },
      ]}
    >
      <Icon name={icon} size={18} color={color} />
      <View style={styles.copy}>
        <T w="semibold" size={14} color={done ? color : palette.text}>
          {message}
        </T>
        {detail && (
          <T size={12} color={palette.text2} fit>
            {detail}
          </T>
        )}
      </View>
      <PressableFeedback onPress={onUndo} accessibilityRole="button" hitSlop={8} style={styles.undo}>
        <T w="semibold" size={14} color={palette.text}>
          {t("undo")}
        </T>
      </PressableFeedback>
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
  flash: { marginHorizontal: -8, borderRadius: 12 },
});
