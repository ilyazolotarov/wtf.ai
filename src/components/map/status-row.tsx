import type { Ref } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import type { useNavStatus } from "@/components/status/use-nav-status";
import { GlassFill } from "@/components/ui/glass-fill";
import { Icon } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";

import { usePanelStyle } from "./hud-card";

/** Above this (and without trusted GPS) the accuracy turns amber. */
const ROUGH_ACCURACY_M = 25;

/**
 * The map's top row: the status pill (trust in words, where the position comes from, its accuracy) and the speed.
 * A tap on the pill unfolds its explanation when there is one (`expandable`).
 */
export function StatusRow({
  nav,
  expandable,
  expanded,
  onToggle,
  ref,
}: {
  nav: ReturnType<typeof useNavStatus>;
  expandable: boolean;
  expanded: boolean;
  onToggle(): void;
  /** The pill, for the map tour. */
  ref?: Ref<View>;
}) {
  const { t } = useT();
  const palette = usePalette();
  const panel = usePanelStyle();
  const { position, trust } = nav;
  const accuracy = position ? Math.round(position.accuracyM) : null;
  const accuracyColor =
    accuracy != null && accuracy > ROUGH_ACCURACY_M && trust !== "TRUSTED" ? palette.warn.c : palette.text;
  const speed = position?.speedMps == null ? "—" : String(Math.round(position.speedMps * 3.6));
  return (
    <View style={styles.row}>
      <Pressable
        onPress={onToggle}
        disabled={!expandable}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        ref={ref}
        style={[panel, styles.pill]}
      >
        <GlassFill radius={Radius.pill} />
        <View style={[styles.halo, { backgroundColor: nav.color.a }]}>
          <View style={[styles.dot, { backgroundColor: nav.color.c }]} />
        </View>
        <View style={styles.copy}>
          <T w="semibold" size={15} numberOfLines={1}>
            {nav.sentence}
          </T>
          <T size={12} color={palette.text2} numberOfLines={1}>
            {position ? (
              <>
                {nav.source} · <T size={12} color={accuracyColor}>{accuracy == null ? "—" : `±${accuracy} m`}</T>
              </>
            ) : (
              "—"
            )}
          </T>
        </View>
        {expandable && (
          <View style={{ transform: [{ rotate: expanded ? "-90deg" : "90deg" }] }}>
            <Icon name="chevron_right" size={16} color={palette.text2} />
          </View>
        )}
      </Pressable>
      <View style={[panel, styles.speed]}>
        <GlassFill radius={28} />
        <T w="light" size={28} style={styles.speedNumber}>
          {speed}
        </T>
        <T size={11} color={palette.text2}>
          {t("speed")}
        </T>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "stretch", gap: 10 },
  pill: {
    flex: 1,
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingLeft: 12,
    paddingRight: 18,
    paddingVertical: 8,
    borderRadius: Radius.pill,
  },
  halo: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  dot: { width: 12, height: 12, borderRadius: 6 },
  copy: { flex: 1, gap: 1 },
  speed: {
    minWidth: 76,
    minHeight: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  speedNumber: {
    lineHeight: 28,
    letterSpacing: -0.8,
    fontVariant: ["tabular-nums"],
  },
});
