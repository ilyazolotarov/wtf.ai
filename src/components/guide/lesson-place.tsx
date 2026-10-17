import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { G, Path, Rect } from "react-native-svg";

import { PoseTab } from "@/components/guide/lesson-pose";
import { LessonIntro, LessonTabs, PulseRing, StepsCard } from "@/components/guide/lesson-ui";
import { MapCard, MapCardButtons, MapCardHeader, MapChipButton } from "@/components/guide/map-ui";
import { PinDot, useMapColors, useNudgedHeading, type Box } from "@/components/guide/mini-map";
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

type Tab = "set" | "start";

/**
 * Lesson 3: what to do when the dot is missing or wrong, the steps under two cases: putting the car on the map
 * (NAVIGATOR-SPEC §6.2), and the question when a drive starts from where the car was parked (UI-SPEC §6.2).
 */
export function LessonPlace() {
  const { t } = useT();
  const [tab, setTab] = useState<Tab>("set");
  return (
    <>
      <LessonIntro>{t("placeIntro")}</LessonIntro>
      <LessonTabs<Tab>
        value={tab}
        onChange={setTab}
        options={[
          { value: "set", label: t("placeTabSet") },
          { value: "start", label: t("placeTabStart") },
        ]}
      />
      {tab === "set" ? <SetPositionTab /> : <PoseTab />}
      {/* Set off from a parking spot, the car already stands: no stop to make, the question to answer. */}
      <StepsCard
        steps={
          tab === "set"
            ? [t("placeStep1"), t("placeStep2"), t("placeStep3"), t("placeStep4")]
            : [t("placeStep2"), t("placeStartStep"), t("placeStep4")]
        }
      />
    </>
  );
}

/** Putting the car on the map the way the map screen does, on a drawn map: from the chip, or a long press and I'm here. */
function SetPositionTab() {
  const { t } = useT();
  const palette = usePalette();
  const c = useMapColors();
  const [step, setStep] = useState<PlaceStep>("idle");
  // A new attempt starts the map afresh.
  const [attempt, setAttempt] = useState(0);
  const heading = useNudgedHeading(0);
  // A long press drops a pin; I'm here starts placing from it.
  const [pin, setPin] = useState<Point | null>(null);
  const [startAt, setStartAt] = useState<Point | undefined>(undefined);
  const reset = () => {
    setStep("idle");
    setPin(null);
    setStartAt(undefined);
    setAttempt(attempt + 1);
  };

  return (
    <>
      <LessonIntro>{t("placeSetIntro")}</LessonIntro>
      <PlacingMap
        key={attempt}
        step={step}
        onStep={setStep}
        onCancel={reset}
        car={CAR}
        dot={DOT}
        dotR={44}
        dotHeadingDeg={heading}
        startAt={startAt}
        onLongPress={setPin}
        scene={
          <>
            {CELLS.map((b, i) => (
              <Rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} rx={b.park ? 6 : 3} fill={b.park ? c.park : c.building} />
            ))}
            <G fill="none" strokeLinecap="round">
              <Path d={MINOR} stroke={c.minorCasing} strokeWidth={13} />
              <Path d={MINOR} stroke={c.minor} strokeWidth={10} />
              <Path d={MAJOR} stroke={c.majorCasing} strokeWidth={17} />
              <Path d={MAJOR} stroke={c.major} strokeWidth={13} />
            </G>
            {pin && step === "idle" && <PinDot x={pin.x} y={pin.y} />}
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
            {pin ? (
              <MapCard style={styles.bottom}>
                <MapCardHeader icon="place" title={t("droppedPin")} body={t("placePinBody")} onClose={() => setPin(null)} closeLabel={t("cancel")} />
                <MapCardButtons
                  buttons={[
                    {
                      label: t("placeMeHere"),
                      // As the map: placing starts at the pin.
                      onPress: () => {
                        setStartAt(pin);
                        setPin(null);
                        setStep("position");
                      },
                    },
                  ]}
                />
              </MapCard>
            ) : (
              <>
                <PulseRing {...at(CAR)} />
                <View pointerEvents="none" style={[styles.hint, { backgroundColor: palette.text }]}>
                  <T w="medium" size={13} color={palette.bg}>
                    {t("placeHoldHint")}
                  </T>
                </View>
              </>
            )}
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
    </>
  );
}

const styles = StyleSheet.create({
  tag: { position: "absolute", paddingHorizontal: 9, paddingVertical: 4, borderRadius: 8 },
  topLeft: { top: 10, left: 10 },
  bottom: { bottom: 10 },
  // Under the chip, clear of the dot's tag at the bottom.
  hint: { position: "absolute", top: 56, alignSelf: "center", paddingHorizontal: 14, paddingVertical: 8, borderRadius: Radius.pill },
  verdict: { borderRadius: Radius.rL, padding: 14, flexDirection: "row", alignItems: "center", gap: 12 },
  verdictText: { flex: 1, lineHeight: 20 },
});
