import { Link } from "expo-router";
import { useEffect, useState, type Ref } from "react";
import { Animated, Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";

import { useLinkBadge, type LinkBadge } from "@/components/status/use-nav-status";
import { GlassFill } from "@/components/ui/glass-fill";
import { Icon, type IconName } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";

import { usePanelStyle } from "./hud-card";

const LINK_BADGE_LABEL = { ok: "badgeOk", busy: "badgeBusy", bad: "badgeBad" } as const;

/** The map's bottom bar: Route, Vehicle (with the connection dot; "Driving" while a trip records), More. */
export function BottomBar({
  recording,
  onLayout,
  ref,
}: {
  recording: boolean;
  onLayout(e: LayoutChangeEvent): void;
  /** The bar, for the map tour. */
  ref?: Ref<View>;
}) {
  const { t } = useT();
  const panel = usePanelStyle();
  const linkBadge = useLinkBadge();
  return (
    <View ref={ref} style={[panel, styles.bar]} onLayout={onLayout}>
      <GlassFill radius={30} />
      <HudAction icon="alt_route" label={t("route")} href="/route" />
      <HudAction
        icon="directions_car"
        label={recording ? t("driving") : t("vehicle")}
        href="/vehicle"
        badge={linkBadge}
        badgeLabel={t(LINK_BADGE_LABEL[linkBadge])}
        highlight={recording}
      />
      <HudAction icon="more_horiz" label={t("more")} href="/more" />
    </View>
  );
}

function HudAction({
  icon,
  label,
  href,
  badge,
  badgeLabel,
  highlight,
}: {
  icon: IconName;
  label: string;
  href: "/route" | "/vehicle" | "/more";
  /** Connection state dot: green ready, yellow connecting, red not connected. */
  badge?: LinkBadge;
  badgeLabel?: string;
  /** The label in the accent colour (a trip is recording). */
  highlight?: boolean;
}) {
  const palette = usePalette();
  const badgeColor = badge === "ok" ? palette.ok.c : badge === "busy" ? palette.warn.c : palette.bad.c;
  return (
    // Link asChild drops function styles, so press feedback lives on the content.
    <Link href={href} asChild>
      <Pressable style={styles.action} accessibilityRole="button">
        {({ pressed }) => (
          <View style={[styles.actionContent, pressed && { backgroundColor: palette.line }]}>
            <Icon name={icon} size={24} color={palette.text} />
            {badge && <BadgeDot color={badgeColor} border={palette.groupBg} pulse={badge === "busy"} label={badgeLabel} />}
            <T w="medium" size={12} color={highlight ? palette.accent : undefined}>
              {label}
            </T>
          </View>
        )}
      </Pressable>
    </Link>
  );
}

/** The vehicle button's connection dot; `pulse` (connecting) scales it up and down a little. */
function BadgeDot({ color, border, pulse, label }: { color: string; border: string; pulse: boolean; label?: string }) {
  const [scale] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (!pulse) {
      scale.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.35, duration: 500, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1, duration: 500, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, scale]);
  return (
    <Animated.View
      style={[styles.dot, { backgroundColor: color, borderColor: border, transform: [{ scale }] }]}
      accessibilityLabel={label}
    />
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    gap: 4,
    padding: 6,
    borderRadius: 30,
  },
  action: { flex: 1 },
  actionContent: {
    height: 60,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    borderRadius: 24,
  },
  dot: {
    position: "absolute",
    top: 8,
    right: 22,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
  },
});
