import { StyleSheet, View } from "react-native";

import { SpeedLimitSign } from "@/components/map/speed-limit-sign";
import { speedBesideCard } from "@/components/map/speed-alerts";
import { useSpeedAlerts } from "@/components/map/use-speed-alerts";
import { GlassFill } from "@/components/ui/glass-fill";
import { T } from "@/components/ui/text";
import { Colors } from "@/constants/theme";

/** The pill this far in from a corner of the car's map, points: the top right, or the visible map's bottom left. */
export type CarSpeedAt = { right: number; top: number } | { left: number; bottom: number };

const SIGN = 30;
const PAD = 4;
const RADIUS = SIGN / 2 + PAD;

/**
 * CarPlay's speed (docs/CARPLAY-SPEC.md §4, UI-SPEC §6.4): Android Auto's pill (CarSpeedViews.kt) drawn by the map's
 * root, where CarMapRoot puts it (`at`): the top right corner above the map's buttons, the visible map's bottom left
 * while CarPlay's bar shows. In the car's day or night and at its own points (the car's text, not the phone's text
 * size). The limit's sign and the speed in the phone's glass, as CarPlay's map buttons are in theirs; past the driver's
 * margin the whole pill red and the sign ringed in white on it, as the phone's bubble (UI-SPEC §6.4); no speed, no
 * pill. No unit under the speed, as on the phone's pill: all the app's speeds are km/h.
 * While the camera's alert shows the camera's sign (`cameraSign`, CarPlaySession): none of its own
 * (`speedBesideCard`); the alert closed by the driver, the road's again.
 * Nothing on it to press, inside the safe area. Apple's guide allows no overlays in the base view; the pill rests on
 * Apple developer support's reading that a speed and its limit drawn so are allowed, a review risk (CARPLAY-SPEC §7).
 */
export function CarSpeedPill({ at, dark, cameraSign }: { at: CarSpeedAt; dark: boolean; cameraSign: boolean }) {
  const { speed, camera } = useSpeedAlerts();
  const scheme = dark ? "dark" : "light";
  const palette = Colors[scheme];
  const { speedKph, limitKph, over } = cameraSign ? speedBesideCard(speed, camera) : speed;
  if (speedKph === undefined) return null;
  return (
    <View pointerEvents="none" style={[styles.pill, at, { boxShadow: palette.shadow }]}>
      {/* The red in a view of its own, red and round at once, as the phone's bubble has it. */}
      {over ? (
        <View style={[styles.fill, { backgroundColor: palette.bad.c }]} />
      ) : (
        <GlassFill radius={RADIUS} scheme={scheme} />
      )}
      {limitKph !== undefined && (
        // On red, a ring of the sign's white keeps its own red ring apart, drawn outside the sign's place.
        <View style={over && [styles.signOnRed, { borderColor: palette.signFill }]}>
          <SpeedLimitSign kph={limitKph} size={SIGN} scheme={scheme} />
        </View>
      )}
      {/* As wide red or not: crossing the margin doesn't move the pill's numbers. */}
      <View style={styles.value}>
        <T
          w={over ? "medium" : "light"}
          size={19}
          color={over ? palette.bad.fg : palette.text}
          maxFontSizeMultiplier={1}
          style={styles.number}
        >
          {speedKph}
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
    borderRadius: RADIUS,
  },
  fill: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, borderRadius: RADIUS },
  signOnRed: { margin: -2, borderRadius: SIGN / 2 + 2, borderWidth: 2 },
  // As tall as the sign, the number centred.
  value: {
    minWidth: 40,
    minHeight: SIGN,
    paddingHorizontal: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  number: { lineHeight: 22, letterSpacing: -0.5, fontVariant: ["tabular-nums"] },
});
