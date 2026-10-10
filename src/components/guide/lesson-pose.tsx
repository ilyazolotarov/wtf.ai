import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Circle, G, Line, Path, Rect, Text as SvgText } from "react-native-svg";

import { ExplainCard, LessonIntro } from "@/components/guide/lesson-ui";
import { MapCard, MapCardButtons, MapCardHeader } from "@/components/guide/map-ui";
import { MapChip, useMapColors, useNudgedHeading } from "@/components/guide/mini-map";
import { PlacingMap, type PlaceStep, type Point } from "@/components/guide/placing-map";
import { formatDistance } from "@/components/status/format-geo";
import { Icon } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";

/** Where the car was parked (the dot at startup), where Wi-Fi puts it, and where it really is: up the street. */
const PARKED: Point = { x: 106, y: 233 };
const WIFI: Point = { x: 318, y: 70 };
const WIFI_GUESS: Point = { x: 300, y: 90 };
const WIFI_DISTANCE_M = 1200;
const CAR: Point = { x: 176, y: 120 };

const MINOR = "M-150 276 H510 M176 -150 V580 M-150 -40 H510 M420 -150 V580";
const BLOCKS = [
  { x: 14, y: 290, w: 150, h: 120 },
  { x: 190, y: 290, w: 216, h: 120 },
  { x: 14, y: -26, w: 150, h: 160 },
  { x: -136, y: -26, w: 136, h: 288 },
  { x: -136, y: 290, w: 136, h: 120 },
  { x: 434, y: -26, w: 76, h: 288 },
  { x: 434, y: 290, w: 76, h: 120 },
  { x: 14, y: -150, w: 392, h: 96 },
  { x: 14, y: 424, w: 392, h: 140 },
];
const PARK = { x: 190, y: -26, w: 216, h: 288 };
const LOT = { x: 56, y: 196, w: 100, h: 74 };
/**
 * The question card covers the map's top (~175 points): the map shows from 130 above the scene, so Wi-Fi's circle and
 * the lot sit below it. 480 high at most: placing centres Wi-Fi's guess (y 90) with the frame's top at the map's (-150).
 */
const VIEW = { top: -130, height: 480 };

/** Lesson 6: the parked-pose question (UI-SPEC §6.2) and what each answer does; "No" goes on to placing the car. */
export function LessonPose() {
  const { t, language } = useT();
  const palette = usePalette();
  const c = useMapColors();
  const [answer, setAnswer] = useState<"yes" | "no" | null>(null);
  const [step, setStep] = useState<PlaceStep>("idle");
  const [attempt, setAttempt] = useState(0);
  // Parked in a north–south bay.
  const heading = useNudgedHeading(0);
  const distance = formatDistance(WIFI_DISTANCE_M, language);
  const askAgain = () => {
    setAnswer(null);
    setStep("idle");
    setAttempt(attempt + 1);
  };

  return (
    <>
      <LessonIntro>{t("poseIntro")}</LessonIntro>
      <PlacingMap
        key={attempt}
        view={VIEW}
        step={step}
        onStep={setStep}
        onCancel={askAgain}
        car={CAR}
        // The car shows once the answer is No: then it is somewhere else.
        carVisible={answer === "no"}
        // No: the dot goes to Wi-Fi's guess, and placing starts there, as on the map.
        dot={answer === "no" ? WIFI_GUESS : PARKED}
        dotR={answer === "no" ? 70 : 12}
        dotHeadingDeg={heading}
        startAt={WIFI_GUESS}
        scene={
          <>
            <Rect x={PARK.x} y={PARK.y} width={PARK.w} height={PARK.h} rx={6} fill={c.park} />
            {BLOCKS.map((b, i) => (
              <Rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} rx={3} fill={c.building} />
            ))}
            <Rect x={LOT.x} y={LOT.y} width={LOT.w} height={LOT.h} rx={6} fill={c.minorCasing} />
            <G stroke="#FFFFFF" strokeWidth={2}>
              {[76, 96, 116, 136].map((x) => (
                <G key={x}>
                  <Line x1={x} y1={200} x2={x} y2={222} />
                  <Line x1={x} y1={244} x2={x} y2={266} />
                </G>
              ))}
            </G>
            <Rect x={62} y={172} width={18} height={18} rx={4} fill={palette.accent} />
            <SvgText x={71} y={185.5} fontSize={12} fontWeight="bold" fill={palette.onAccent} textAnchor="middle">
              P
            </SvgText>
            <G fill="none" strokeLinecap="round">
              <Path d={MINOR} stroke={c.minorCasing} strokeWidth={13} />
              <Path d={MINOR} stroke={c.minor} strokeWidth={10} />
            </G>
            {answer === null && (
              <G>
                <Circle cx={WIFI.x} cy={WIFI.y} r={96} fill={palette.idle.a} stroke={palette.idle.c} strokeWidth={1.5} strokeDasharray="5 4" />
                <Circle cx={WIFI.x} cy={WIFI.y} r={5} fill={palette.idle.c} />
              </G>
            )}
          </>
        }
        overlay={(at) => (
          <>
            {answer === null && <MapChip text={t("poseWifiTag").replace("{d}", distance)} style={[styles.wifiTag, at({ x: 224, y: 176 })]} />}
            {answer === null && (
              // The map's parked-pose card (index.tsx).
              <MapCard style={styles.cardTop}>
                <MapCardHeader icon="directions_car" tone="warn" title={t("poseQuestion")} body={t("poseQuestionWhy").replace("{d}", distance)} />
                <MapCardButtons
                  buttons={[
                    { label: t("poseYes"), onPress: () => setAnswer("yes") },
                    {
                      label: t("poseNo"),
                      onPress: () => {
                        setAnswer("no");
                        setStep("position");
                      },
                    },
                  ]}
                />
              </MapCard>
            )}
          </>
        )}
      />

      {answer !== null && (
        <View style={[styles.result, { backgroundColor: palette.groupBg }]}>
          <T w="semibold" size={15}>
            {t(answer === "yes" ? "poseYesTitle" : "poseNoTitle")}
          </T>
          <T size={14} color={palette.text2} style={styles.resultBody}>
            {t(answer === "yes" ? "poseYesBody" : "poseNoBody")}
          </T>
          {step === "done" && (
            <View style={styles.doneRow}>
              <Icon name="check" size={18} color={palette.ok.c} />
              <T size={14} style={styles.doneText}>
                {t("placeDone")}
              </T>
            </View>
          )}
          <Pressable onPress={askAgain} hitSlop={8} accessibilityRole="button" style={styles.again}>
            <T w="semibold" size={14} color={palette.accent}>
              {t("poseAskAgain")}
            </T>
          </Pressable>
        </View>
      )}

      <ExplainCard
        rows={[
          { label: t("guideWhen"), text: t("poseWhen") },
          { label: t("poseNotSureLabel"), text: t("poseNotSure") },
        ]}
      />
    </>
  );
}

const styles = StyleSheet.create({
  wifiTag: { position: "absolute" },
  cardTop: { top: 10 },
  result: { borderRadius: Radius.rL, padding: 16, gap: 8, borderCurve: "continuous" },
  resultBody: { lineHeight: 20 },
  doneText: { flex: 1, lineHeight: 20 },
  doneRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  again: { alignSelf: "flex-start", paddingTop: 4 },
});
