import { Host, Slider } from "@expo/ui";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Path } from "react-native-svg";

import { LessonIntro } from "@/components/guide/lesson-ui";
import { sayFirstInstruction } from "@/components/guide/lesson-voice-sample";
import { MiniMap, Puck } from "@/components/guide/mini-map";
import { BLOCKS, CAR, H, PARKS, plan, roads, W } from "@/components/guide/route-map";
import { RouteBanner } from "@/components/route/route-banner";
import { useAudioOutput } from "@/components/route/use-audio-output";
import { hushVoice } from "@/components/route/voice-player";
import { ScreenCard, ScreenNote, ScreenRow, SectionLabel } from "@/components/screens/screen-ui";
import { formatDistance } from "@/components/status/format-geo";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { RoadClass } from "@/nav/mapmatch/graph/format";

/** Up the main road, then right: the first instruction is a right turn. */
const DESTINATION = { x: 330, y: 200 };
/** As in Settings: a sample once the slider rests this long. */
const SAMPLE_DELAY_MS = 600;

/**
 * Lesson 8: the route banner's voice button (UI-SPEC §6.3), the real banner on a planned route: a tap mutes, a long
 * press opens the phone's own speaker list. The volume is the Settings slider, here only for the lesson.
 */
export function LessonVoice() {
  const { t, language } = useT();
  const palette = usePalette();
  const [route] = useState(() => plan(CAR, DESTINATION, true, 1));
  const [muted, setMuted] = useState(false);
  const [stop, setStop] = useState(8);
  const { offPhone } = useAudioOutput(true);
  const sample = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (sample.current) clearTimeout(sample.current);
      hushVoice();
    },
    [],
  );
  const setLevel = (v: number) => {
    const i = Math.round(v);
    if (i === stop) return;
    setStop(i);
    if (sample.current) clearTimeout(sample.current);
    if (i === 0) {
      hushVoice();
      return;
    }
    // The route's own instruction at the lesson's volume; the driver's setting stays as it is.
    sample.current = setTimeout(() => sayFirstInstruction(route.snapshot.maneuvers, t, language, i / 10), SAMPLE_DELAY_MS);
  };
  const off = stop === 0;
  const turn = route.snapshot.maneuvers?.[1];
  const distance = formatDistance(Math.round((turn?.atM ?? 0) / 10) * 10, language);
  const quiet = muted || off;
  const said = off
    ? t("voiceSilent")
    : muted
      ? t("voiceMuted")
      : t(offPhone ? "voiceSayCar" : "voiceSay").replace("{d}", distance);

  return (
    <>
      <LessonIntro>{t("voiceIntro")}</LessonIntro>
      <MiniMap
        width={W}
        height={H}
        parks={PARKS}
        blocks={BLOCKS}
        minor={roads(RoadClass.residential)}
        major={roads(RoadClass.primary)}
        overlay={
          <>
            <View style={styles.banner}>
              <RouteBanner
                route={route.snapshot}
                nowMs={route.nowMs}
                onStop={() => undefined}
                muted={muted}
                // Volume 0 in Settings: no voice button, as on the map.
                onToggleVoice={
                  off
                    ? undefined
                    : () => {
                        if (!muted) hushVoice();
                        setMuted(!muted);
                      }
                }
                offPhone={offPhone}
              />
            </View>
            <View style={[styles.said, { backgroundColor: quiet ? palette.panelSolid : palette.text }]}>
              <T w="medium" size={13} color={quiet ? palette.text2 : palette.bg} style={styles.lead}>
                {said}
              </T>
            </View>
          </>
        }
      >
        <Path d={route.path} fill="none" stroke={palette.route} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" />
        <Puck x={CAR.x} y={CAR.y} r={12} headingDeg={0} />
      </MiniMap>

      <View style={styles.group}>
        <SectionLabel>{t("voiceVolume")}</SectionLabel>
        <ScreenCard style={styles.card}>
          <ScreenRow labelKey="voiceVolumeLevel" value={off ? t("voiceVolumeOff") : `${stop * 10}%`} />
          <Host matchContents={{ vertical: true }}>
            <Slider value={stop} min={0} max={10} step={1} onValueChange={setLevel} />
          </Host>
          <ScreenNote>{t(off ? "voiceVolumeOffNote" : "voiceLessonVolumeNote")}</ScreenNote>
        </ScreenCard>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  banner: { position: "absolute", left: 10, right: 10, top: 10 },
  said: { position: "absolute", left: "34%", right: 12, top: "58%", borderRadius: Radius.rL, paddingHorizontal: 12, paddingVertical: 10 },
  lead: { lineHeight: 18 },
  group: { gap: 8 },
  card: { gap: 10 },
});
