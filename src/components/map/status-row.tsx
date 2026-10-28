import { Pressable, StyleSheet, View } from "react-native";

import type { useNavStatus } from "@/components/status/use-nav-status";
import { GlassFill } from "@/components/ui/glass-fill";
import { Icon } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";

import { usePanelStyle } from "./hud-card";
import { SpeedLimitSign } from "./speed-limit-sign";
import type { SpeedShown } from "./use-speed-warning";

/** How far the speed numeral grows with the system's text size (the rest of the app: up to 150 %). */
const SPEED_MAX_FONT_SCALE = 1.2;

/** Above this (and without trusted GPS) the accuracy turns amber. */
const ROUGH_ACCURACY_M = 25;

/**
 * The map's top row: the status pill (trust in words, where the position comes from, its accuracy) and the speed with
 * the limit's sign beside it (UI-SPEC §6.4), red when too fast. A tap on the pill unfolds its explanation when there is
 * one (`expandable`).
 */
export function StatusRow({
  nav,
  speed: shown,
  expandable,
  expanded,
  onToggle,
}: {
  nav: ReturnType<typeof useNavStatus>;
  speed: SpeedShown;
  expandable: boolean;
  expanded: boolean;
  onToggle(): void;
}) {
  const { t, language } = useT();
  const palette = usePalette();
  const panel = usePanelStyle();
  const { position, trust } = nav;
  const accuracy = position ? Math.round(position.accuracyM) : null;
  const accuracyColor =
    accuracy != null && accuracy > ROUGH_ACCURACY_M && trust !== "TRUSTED" ? palette.warn.c : palette.text;
  const speed = shown.speedKph === undefined ? "—" : String(shown.speedKph);
  const { limitKph, over } = shown;
  const speedLabel =
    limitKph === undefined
      ? `${speed} ${t("speed")}`
      : t(over ? "speedOverLimitA11y" : "speedLimitA11y").replace("{speed}", speed).replace("{limit}", String(limitKph));
  return (
    <View style={styles.row}>
      <Pressable
        onPress={onToggle}
        disabled={!expandable}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        style={[panel, styles.pill]}
      >
        <GlassFill radius={Radius.pill} />
        <View style={[styles.halo, { backgroundColor: nav.color.a }]}>
          <View style={[styles.dot, { backgroundColor: nav.color.c }]} />
        </View>
        {/* At a large text size each line wraps once before it shrinks: the trust state stays readable at a glance. */}
        <View style={styles.copy}>
          <T w="semibold" size={15} fit={2}>
            {nav.sentence}
          </T>
          <T size={12} color={palette.text2} fit={2}>
            {position ? (
              <>
                {nav.source} · <T size={12} color={accuracyColor}>{accuracy == null ? "—" : `±${accuracy}\u00a0${language === "uk" ? "м" : "m"}`}</T>
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
      <View
        style={[panel, styles.speed, limitKph !== undefined && styles.withSign]}
        accessible
        accessibilityRole="text"
        accessibilityLabel={speedLabel}
      >
        <GlassFill radius={28} />
        {limitKph !== undefined && <SpeedLimitSign kph={limitKph} />}
        <View style={styles.speedValue}>
          {/*
            The red in a view of its own, made red and round at once: a background colour added later to the speed's
            view came out square on Android (new architecture), its corner radius lost.
          */}
          {over && <View style={[styles.overFill, { backgroundColor: palette.bad.c }]} />}
          {/*
            Already large: it grows less than the text beside it, which needs the room. No unit under it: the app's
            speeds are all km/h, and the pill beside it needs the width "км/год" took (the label read aloud says it).
          */}
          <T
            w={over ? "medium" : "light"}
            size={over ? 26 : 28}
            color={over ? palette.bad.fg : palette.text}
            style={styles.speedNumber}
            maxFontSizeMultiplier={SPEED_MAX_FONT_SCALE}
          >
            {speed}
          </T>
        </View>
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
    paddingRight: 14,
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
  // Tight: the sign takes its width from the pill beside it, whose second line must still fit a 375 pt phone in
  // Ukrainian ("Перевірка GPS · ±140 м").
  speed: {
    minWidth: 76,
    minHeight: 56,
    borderRadius: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    padding: 6,
  },
  /** The sign at the left end, round inside the bubble's round end. */
  withSign: { justifyContent: "flex-start" },
  /** Red, a pill of its own inside the bubble, when too fast. */
  overFill: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, borderRadius: 22 },
  /** As wide red or not: crossing the margin doesn't move the pill's text. */
  speedValue: {
    minWidth: 48,
    minHeight: 44,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  speedNumber: {
    lineHeight: 28,
    letterSpacing: -0.8,
    fontVariant: ["tabular-nums"],
  },
});
