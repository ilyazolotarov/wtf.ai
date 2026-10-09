import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { G, Path, Rect } from "react-native-svg";

import { ExplainCard, LessonIntro } from "@/components/guide/lesson-ui";
import { MapChipButton } from "@/components/guide/map-ui";
import { useMapColors, useNudgedHeading, type Box } from "@/components/guide/mini-map";
import { PlacingMap, type PlaceStep, type Point } from "@/components/guide/placing-map";
import { Icon } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";

/** The car stands on the main road facing up it; the dot thinks it is a block away. */
const CAR: Point = { x: 250, y: 210 };
const DOT: Point = { x: 110, y: 380 };

const VERTICAL = [-40, 110, 250, 400];
const HORIZONTAL = [-40, 120, 300, 470];
const MAJOR = "M250 -150 V580";
const MINOR = [
  ...VERTICAL.filter((x) => x !== 250).map((x) => `M${x} -150 V580`),
  ...HORIZONTAL.map((y) => `M-150 ${y} H510`),
].join(" ");
/** The blocks between the roads; one is a park. */
const CELLS: (Box & { park?: boolean })[] = [];
const edges = (lines: number[], lo: number, hi: number) => [lo, ...lines, hi];
const xs = edges(VERTICAL, -150, 510);
const ys = edges(HORIZONTAL, -150, 580);
for (let i = 0; i + 1 < xs.length; i++) {
  for (let j = 0; j + 1 < ys.length; j++) {
    const inset = 14;
    CELLS.push({
      x: xs[i] + inset,
      y: ys[j] + inset,
      w: xs[i + 1] - xs[i] - 2 * inset,
      h: ys[j + 1] - ys[j] - 2 * inset,
      park: i === 3 && j === 1,
    });
  }
}

/** Lesson 5: put the car on the map (NAVIGATOR-SPEC §6.2) the way the map screen does, on a drawn map. */
export function LessonPlace() {
  const { t } = useT();
  const palette = usePalette();
  const c = useMapColors();
  const [step, setStep] = useState<PlaceStep>("idle");
  // A new attempt starts the map afresh.
  const [attempt, setAttempt] = useState(0);
  const heading = useNudgedHeading(0);
  const reset = () => {
    setStep("idle");
    setAttempt(attempt + 1);
  };

  return (
    <>
      <LessonIntro>{t("placeIntro")}</LessonIntro>
      <PlacingMap
        key={attempt}
        step={step}
        onStep={setStep}
        onCancel={reset}
        car={CAR}
        dot={DOT}
        dotR={44}
        dotHeadingDeg={heading}
        scene={
          <>
            {CELLS.map((b, i) => (
              <Rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} rx={b.park ? 6 : 3} fill={b.park ? c.park : c.block} />
            ))}
            <G fill="none" strokeLinecap="round">
              <Path d={MINOR} stroke={c.minorCasing} strokeWidth={13} />
              <Path d={MINOR} stroke={c.minor} strokeWidth={10} />
              <Path d={MAJOR} stroke={c.majorCasing} strokeWidth={17} />
              <Path d={MAJOR} stroke={c.major} strokeWidth={13} />
            </G>
          </>
        }
        overlay={(at) => (
          <>
            <View pointerEvents="none" style={[styles.tag, { backgroundColor: palette.text }, at({ x: DOT.x + 22, y: DOT.y + 24 })]}>
              <T w="medium" size={12} color={palette.bg}>
                {t("placeDotTag")}
              </T>
            </View>
            <View pointerEvents="none" style={[styles.tag, { backgroundColor: palette.text }, at({ x: CAR.x + 18, y: CAR.y - 14 })]}>
              <T w="medium" size={12} color={palette.bg}>
                {t("placeCarTag")}
              </T>
            </View>
            <MapChipButton icon="location_on" label={t("placeOffer")} onPress={() => setStep("position")} style={styles.topLeft} />
          </>
        )}
      />

      {step === "done" && (
        <View style={[styles.verdict, { backgroundColor: palette.ok.a }]}>
          <Icon name="check" size={20} color={palette.ok.c} />
          <T size={14} style={styles.verdictText}>
            {t("placeDone")}
          </T>
          <Pressable onPress={reset} hitSlop={8} accessibilityRole="button">
            <T w="semibold" size={14} color={palette.accent}>
              {t("placeAgain")}
            </T>
          </Pressable>
        </View>
      )}

      <ExplainCard
        rows={[
          { label: t("guideWhen"), text: t("placeWhen") },
          { label: t("guideAlso"), text: t("placeAlso") },
        ]}
      />
    </>
  );
}

const styles = StyleSheet.create({
  tag: { position: "absolute", paddingHorizontal: 9, paddingVertical: 4, borderRadius: 8 },
  topLeft: { top: 10, left: 10 },
  verdict: { borderRadius: Radius.rL, padding: 14, flexDirection: "row", alignItems: "center", gap: 12 },
  verdictText: { flex: 1, lineHeight: 20 },
});
