import { useEffect, useState } from "react";
import { Animated, Easing, Pressable, StyleSheet, View } from "react-native";
import { Circle, Path } from "react-native-svg";

import { ExplainCard, FadeIn, LessonIntro } from "@/components/guide/lesson-ui";
import { CarGlyph, MapChip, MiniMap, Puck, StatusPillMock } from "@/components/guide/mini-map";
import { useTween } from "@/components/guide/use-tween";
import { Segmented } from "@/components/screens/screen-ui";
import { formatDistance } from "@/components/status/format-geo";
import { Icon } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { usePalette } from "@/constants/theme";
import type { Strings } from "@/i18n/en";
import { useT } from "@/i18n/provider";

type Stage = 0 | 1 | 2 | 3 | 4;

/** The drive: up the main road, then right at the junction. Positions are distances along it, map units. */
const START = { x: 120, y: 270 };
const CORNER = { x: 120, y: 70 };
const END_X = 270;
const LEG1 = START.y - CORNER.y;
const ALONG: Record<Stage, number> = { 0: 20, 1: 75, 2: 150, 3: 265, 4: 350 };
const STAGE_LABELS: (keyof Strings)[] = ["jamStageOk", "jamStageJammed", "jamStageLater", "jamStageTurn", "jamStageBack"];
/** Playing moves on a stage this often: long enough to read. */
const STAGE_MS = 4000;
/** Between stages the car drives, the circle eases. */
const MOVE_MS = 1600;

/** Point and heading (degrees, clockwise from up) at a distance along the drive. */
function along(d: number): { x: number; y: number; headingDeg: number } {
  if (d <= LEG1) return { x: START.x, y: START.y - d, headingDeg: 0 };
  return { x: Math.min(END_X, CORNER.x + d - LEG1), y: CORNER.y, headingDeg: 90 };
}

/** The driven stretch, as an SVG path. */
function trail(d: number): string {
  if (d <= LEG1) return `M${START.x} ${START.y} V${START.y - d}`;
  return `M${START.x} ${START.y} V${CORNER.y} H${along(d).x}`;
}

interface StageView {
  color: "ok" | "idle" | "warn";
  label: keyof Strings;
  source: keyof Strings;
  accuracyM: number;
  r: number;
  /** The "Trusted GPS …" chip: how long ago, and (with odometry) how far back. */
  since?: { minutes: number; backM?: number };
  /** Without the adapter the dot holds the last good fix. */
  hold?: boolean;
  /** Unsure between this road and one beside it (a hollow ring). */
  alt?: boolean;
  app: keyof Strings;
  you: keyof Strings;
}

const WITH: StageView[] = [
  { color: "ok", label: "sOk", source: "srcGnss", accuracyM: 5, r: 9, app: "jamOkApp", you: "dotOkYou" },
  { color: "idle", label: "sNoFix", source: "srcDR", accuracyM: 12, r: 14, since: { minutes: 0, backM: 250 }, app: "jamJammedApp", you: "dotOkYou" },
  { color: "idle", label: "sNoFix", source: "srcDR", accuracyM: 40, r: 34, since: { minutes: 4, backM: 2300 }, alt: true, app: "jamLaterApp", you: "jamLaterYou" },
  { color: "idle", label: "sNoFix", source: "srcDR", accuracyM: 15, r: 16, since: { minutes: 6, backM: 3100 }, app: "jamTurnApp", you: "jamTurnYou" },
  { color: "warn", label: "sReacq", source: "srcVerify", accuracyM: 8, r: 9, app: "jamBackApp", you: "dotReacqYou" },
];

/** No OBD speed: the map holds the last fix integrity passed, the circle growing at 15 m/s (SPEC §3.3 item 6). */
const WITHOUT: StageView[] = [
  WITH[0],
  { color: "idle", label: "sNoFix", source: "jamLastGps", accuracyM: 300, r: 46, since: { minutes: 0 }, hold: true, app: "jamNoAdJammedApp", you: "jamNoAdJammedYou" },
  { color: "idle", label: "sNoFix", source: "jamLastGps", accuracyM: 3600, r: 210, since: { minutes: 4 }, hold: true, app: "jamNoAdLaterApp", you: "jamNoAdLaterYou" },
  { color: "idle", label: "sNoFix", source: "jamLastGps", accuracyM: 5400, r: 260, since: { minutes: 6 }, hold: true, app: "jamNoAdTurnApp", you: "jamNoAdTurnYou" },
  { ...WITH[4], app: "jamNoAdBackApp" },
];

/** Lesson 4: a drive under jamming played in five stages, with and without the adapter (SPEC §3.3–3.7). */
export function LessonJamming() {
  const { t, language } = useT();
  const palette = usePalette();
  const [stage, setStage] = useState<Stage>(0);
  const [adapter, setAdapter] = useState(true);
  const [playing, setPlaying] = useState(false);

  // One stage at a time while playing, its button filling as its time runs; it stops after the last.
  const [fill] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!playing) return;
    fill.setValue(0);
    const timer = Animated.timing(fill, { toValue: 1, duration: STAGE_MS, easing: Easing.linear, useNativeDriver: false });
    timer.start(({ finished }) => {
      if (!finished) return;
      if (stage >= 4) setPlaying(false);
      else setStage((stage + 1) as Stage);
    });
    return () => timer.stop();
  }, [playing, stage, fill]);

  const view = (adapter ? WITH : WITHOUT)[stage];
  const carAlong = useTween(ALONG[stage], MOVE_MS);
  const dotAlong = useTween(view.hold ? ALONG[0] : ALONG[stage], MOVE_MS);
  const r = useTween(view.r, MOVE_MS);
  const altOpacity = useTween(view.alt ? 0.7 : 0, MOVE_MS);
  const carOpacity = useTween(!adapter && stage > 0 && stage < 4 ? 1 : 0, 500);
  const car = along(carAlong);
  const dot = along(dotAlong);
  const since = view.since
    ? (() => {
        const age = view.since.minutes === 0 ? t("ageJustNow") : t("ageMinutes").replace("{m}", String(view.since.minutes));
        return view.since.backM === undefined
          ? t("sinceTrusted").replace("{age}", age)
          : t("sinceTrustedBack").replace("{age}", age).replace("{d}", formatDistance(view.since.backM, language));
      })()
    : null;

  return (
    <>
      <LessonIntro>{t("jamIntro")}</LessonIntro>
      <Segmented<"with" | "without">
        value={adapter ? "with" : "without"}
        onChange={(value) => setAdapter(value === "with")}
        options={[
          { value: "with", label: t("jamWithAdapter") },
          { value: "without", label: t("jamWithoutAdapter") },
        ]}
      />
      <MiniMap
        width={358}
        height={290}
        parks={[{ x: 230, y: 92, w: 110, h: 88 }]}
        blocks={[
          { x: 140, y: 92, w: 52, h: 88 },
          { x: 14, y: 92, w: 86, h: 88 },
          { x: 14, y: 220, w: 86, h: 80 },
          { x: 140, y: 220, w: 52, h: 80 },
          { x: 14, y: -10, w: 86, h: 58 },
          { x: 230, y: 220, w: 110, h: 80 },
        ]}
        minor="M-10 200 H370 M210 -10 V300"
        major={`M120 300 V70 M-10 70 H370`}
        overlay={
          <>
            <StatusPillMock
              color={palette[view.color]}
              label={t(view.label)}
              source={t(view.source)}
              accuracyM={view.accuracyM}
              trusted={stage === 0}
            />
            {since && <MapChip text={since} style={styles.strip} />}
            {carOpacity > 0.5 && <MapChip text={t("jamCarTag")} style={styles.carTag} />}
          </>
        }
      >
        {adapter && (
          <Path d={trail(carAlong)} fill="none" stroke={palette.accent} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" opacity={0.35} />
        )}
        {carOpacity > 0 && <CarGlyph x={car.x} y={car.y} rotate={car.headingDeg} opacity={carOpacity} />}
        {altOpacity > 0 && <Circle cx={210} cy={dot.y} r={9} fill="none" stroke={palette.warn.c} strokeWidth={2.5} opacity={altOpacity} />}
        <Puck x={dot.x} y={dot.y} r={r} trusted={stage === 0} headingDeg={view.hold ? null : dot.headingDeg} />
      </MiniMap>

      <View style={styles.controls}>
        <Pressable
          onPress={() => {
            if (playing) setPlaying(false);
            else {
              if (stage >= 4) setStage(0);
              setPlaying(true);
            }
          }}
          accessibilityRole="button"
          accessibilityLabel={playing ? t("jamPause") : t("jamPlay")}
          style={({ pressed }) => [styles.play, { backgroundColor: palette.accent }, pressed && styles.pressed]}
        >
          <Icon name={playing ? "pause" : "play_arrow"} size={18} color={palette.onAccent} />
        </Pressable>
        <View style={styles.stops}>
          {STAGE_LABELS.map((label, i) => (
            <Pressable
              key={label}
              onPress={() => {
                setPlaying(false);
                setStage(i as Stage);
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: i === stage }}
              style={[styles.stop, i === stage && { backgroundColor: palette.groupBg }]}
            >
              <View style={[styles.track, { backgroundColor: palette.line }]}>
                <Animated.View
                  style={[
                    styles.bar,
                    {
                      backgroundColor: palette.accent,
                      width:
                        i === stage && playing
                          ? fill.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] })
                          : i <= stage
                            ? "100%"
                            : "0%",
                    },
                  ]}
                />
              </View>
              <T w="semibold" size={11} color={i === stage ? palette.text : palette.text2} numberOfLines={1}>
                {t(label)}
              </T>
            </Pressable>
          ))}
        </View>
      </View>

      <FadeIn key={`${adapter}-${stage}`}>
        <ExplainCard
          rows={[
            { label: t("guideApp"), text: t(view.app) },
            { label: t("guideYou"), text: t(view.you), strong: true },
          ]}
        />
      </FadeIn>
    </>
  );
}

const styles = StyleSheet.create({
  strip: { left: 10, top: 74 },
  carTag: { right: 10, bottom: 10 },
  controls: { flexDirection: "row", gap: 6 },
  play: { width: 44, height: 52, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.75 },
  stops: { flex: 1, flexDirection: "row", gap: 4 },
  stop: { flex: 1, height: 52, borderRadius: 12, alignItems: "center", justifyContent: "center", gap: 5 },
  track: { width: "78%", height: 4, borderRadius: 2, overflow: "hidden" },
  bar: { height: 4, borderRadius: 2 },
});
