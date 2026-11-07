import { Link } from "expo-router";
import { useEffect, useState, type Ref } from "react";
import { Animated, StyleSheet, View, type LayoutChangeEvent, type ViewInstance } from "react-native";

import { useLinkBadge, type LinkBadge } from "@/components/status/use-nav-status";
import { GlassFill } from "@/components/ui/glass-fill";
import { Icon, type IconName } from "@/components/ui/icon";
import { PressableFeedback } from "@/components/ui/press-feedback";
import { T } from "@/components/ui/text";
import { usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { useUpdateBadges } from "@/services/app-update/update-center";

import { usePanelStyle } from "./hud-card";

const LINK_BADGE_LABEL = { ok: "badgeOk", busy: "badgeBusy", bad: "badgeBad" } as const;

/**
 * The map's bottom bar: Route, Vehicle (with the connection dot; "Driving" while a trip records), More (a red dot while
 * an app or map update waits: docs/UPDATES-SPEC.md §5.4).
 */
export function BottomBar({
  recording,
  onLayout,
  ref,
}: {
  recording: boolean;
  onLayout(e: LayoutChangeEvent): void;
  /** The bar, for the map tour. */
  ref?: Ref<ViewInstance>;
}) {
  const { t } = useT();
  const panel = usePanelStyle();
  const linkBadge = useLinkBadge();
  const updates = useUpdateBadges();
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
      <HudAction
        icon="more_horiz"
        label={t("more")}
        href="/more"
        badge={updates.any ? "bad" : undefined}
        badgeLabel={updates.any ? t(updates.app ? "appUpdateAvailable" : "updateAvailable") : undefined}
      />
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
  /** Connection state dot: green ready, yellow connecting, red not connected; on More, red: an update waits. */
  badge?: LinkBadge;
  badgeLabel?: string;
  /** The label in the accent colour (a trip is recording). */
  highlight?: boolean;
}) {
  const palette = usePalette();
  const badgeColor = badge === "ok" ? palette.ok.c : badge === "busy" ? palette.warn.c : palette.bad.c;
  return (
    <Link href={href} asChild>
      <PressableFeedback style={styles.action} accessibilityRole="button">
        <View style={styles.actionContent}>
          <Icon name={icon} size={24} color={palette.text} />
          {badge && <BadgeDot color={badgeColor} border={palette.groupBg} pulse={badge === "busy"} label={badgeLabel} />}
          <T w="medium" size={12} color={highlight ? palette.accent : undefined} fit>
            {label}
          </T>
        </View>
      </PressableFeedback>
    </Link>
  );
}

/**
 * The vehicle button's connection dot; `pulse` (connecting) scales it up and down a little. Drawn at its largest size
 * and scaled down to rest: a transform scales the drawn pixels, and a dot drawn small and scaled up pulsed blurry.
 */
const DOT_REST = 0.75;
function BadgeDot({ color, border, pulse, label }: { color: string; border: string; pulse: boolean; label?: string }) {
  const [scale] = useState(() => new Animated.Value(DOT_REST));
  useEffect(() => {
    if (!pulse) {
      scale.setValue(DOT_REST);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, { toValue: 1, duration: 500, useNativeDriver: true }),
        Animated.timing(scale, { toValue: DOT_REST, duration: 500, useNativeDriver: true }),
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
  // 12 px with a 2 px border at rest (DOT_REST of this), its centre where the 12 px one was.
  dot: {
    position: "absolute",
    top: 6,
    // From the button's centre (where the icon is), not its edge: a wider bar kept the dot far from its icon.
    left: "50%",
    marginLeft: 21,
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2.5,
  },
});
