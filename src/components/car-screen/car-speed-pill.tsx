import { useEffect } from "react";
import { StyleSheet, View } from "react-native";

import { SpeedLimitSign } from "@/components/map/speed-limit-sign";
import { speedBesideCard } from "@/components/map/speed-alerts";
import { useSpeedAlerts } from "@/components/map/use-speed-alerts";
import { T } from "@/components/ui/text";
import { Colors } from "@/constants/theme";
import { useT } from "@/i18n/provider";

/** The pill this far in from the visible map's bottom left corner, points. */
export interface CarSpeedAt {
  left: number;
  bottom: number;
}

const SIGN = 30;
const PAD = 4;

/**
 * CarPlay's speed (docs/CARPLAY-SPEC.md §4, UI-SPEC §6.4): Android Auto's pill (CarSpeedViews.kt) drawn by the map's
 * root, in the visible map's bottom left corner, in the car's day or night and at its own points (the car's text,
 * not the phone's text size). The limit's sign and the speed with its unit, the speed red past the driver's margin;
 * no speed, no pill. While the camera's alert shows the camera's sign (`cameraSign`, CarPlaySession): none of its
 * own (`speedBesideCard`); the alert closed by the driver, the road's again.
 * Nothing on it to press, inside the safe area. Apple's guide allows no overlays in the base view; the pill rests on
 * Apple developer support's reading that a speed and its limit drawn so are allowed, a review risk (CARPLAY-SPEC §7).
 * `onWidth`: the pill's width, 0 while there is none, for the credit beside it.
 */
export function CarSpeedPill({
  at,
  dark,
  cameraSign,
  onWidth,
}: {
  at: CarSpeedAt;
  dark: boolean;
  cameraSign: boolean;
  onWidth(width: number): void;
}) {
  const { speed, camera } = useSpeedAlerts();
  const { t } = useT();
  const scheme = dark ? "dark" : "light";
  const palette = Colors[scheme];
  const { speedKph, limitKph, over } = cameraSign ? speedBesideCard(speed, camera) : speed;
  const shown = speedKph !== undefined;
  useEffect(() => {
    if (!shown) onWidth(0);
  }, [shown, onWidth]);
  if (!shown) return null;
  return (
    <View
      pointerEvents="none"
      onLayout={(e) => onWidth(Math.ceil(e.nativeEvent.layout.width))}
      style={[styles.pill, at, { backgroundColor: palette.panelSolid, boxShadow: palette.shadow }]}
    >
      {limitKph !== undefined && <SpeedLimitSign kph={limitKph} size={SIGN} scheme={scheme} />}
      {/* As wide red or not: crossing the margin doesn't move the pill's numbers. */}
      <View style={[styles.value, over && { backgroundColor: palette.bad.c }]}>
        <T
          w={over ? "medium" : "light"}
          size={19}
          color={over ? palette.bad.fg : palette.text}
          maxFontSizeMultiplier={1}
          style={styles.number}
        >
          {speedKph}
        </T>
        <T size={9} color={over ? palette.bad.fg : palette.text2} maxFontSizeMultiplier={1} style={styles.unit}>
          {t("speed")}
        </T>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    position: "absolute",
    flexDirection: "row",
    alignItems: "center",
    gap: PAD,
    padding: PAD,
    borderRadius: SIGN / 2 + PAD,
  },
  // Not round as the sign: the unit under the number met a capsule's curve.
  value: {
    minWidth: 40,
    minHeight: SIGN,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  number: { lineHeight: 19, letterSpacing: -0.5, fontVariant: ["tabular-nums"] },
  unit: { lineHeight: 9 },
});
