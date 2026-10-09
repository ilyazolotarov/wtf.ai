import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Circle, G } from "react-native-svg";

import { ChoiceChips, ExplainCard, LessonIntro } from "@/components/guide/lesson-ui";
import { MapChip, MiniMap, Puck, StatusPillMock } from "@/components/guide/mini-map";
import { formatDistance } from "@/components/status/format-geo";
import { usePalette, type StatusColor } from "@/constants/theme";
import type { Strings } from "@/i18n/en";
import { useT } from "@/i18n/provider";

type State = "ok" | "approx" | "nofix" | "spoof" | "reacq";

/** Colours and labels as the map's status pill shows them (use-nav-status). */
const STATES: Record<
  State,
  {
    chip: keyof Strings;
    color: "ok" | "warn" | "idle" | "bad";
    label: keyof Strings;
    source: keyof Strings;
    accuracyM: number;
    r: number;
    app: keyof Strings;
    you: keyof Strings;
  }
> = {
  ok: { chip: "dotChipOk", color: "ok", label: "sOk", source: "srcGnss", accuracyM: 5, r: 14, app: "dotOkApp", you: "dotOkYou" },
  approx: { chip: "dotChipApprox", color: "warn", label: "sApprox", source: "dotSourceCell", accuracyM: 300, r: 74, app: "dotApproxApp", you: "dotApproxYou" },
  nofix: { chip: "dotChipNoFix", color: "idle", label: "sNoFix", source: "srcDR", accuracyM: 40, r: 36, app: "dotNoFixApp", you: "dotNoFixYou" },
  spoof: { chip: "dotChipSpoof", color: "bad", label: "sUntrusted", source: "srcDR", accuracyM: 25, r: 28, app: "dotSpoofApp", you: "dotSpoofYou" },
  reacq: { chip: "dotChipReacq", color: "warn", label: "sReacq", source: "srcVerify", accuracyM: 20, r: 22, app: "dotReacqApp", you: "dotReacqYou" },
};

/** Lesson 2: the five trust states on a drawn map (SPEC §3.3, UI-SPEC §6.3). */
export function LessonDot() {
  const { t, language } = useT();
  const palette = usePalette();
  const [state, setState] = useState<State>("nofix");
  const s = STATES[state];
  const color: StatusColor = palette[s.color];
  const since = t("sinceTrustedBack")
    .replace("{age}", t("ageMinutes").replace("{m}", "4"))
    .replace("{d}", formatDistance(2300, language));

  return (
    <>
      <LessonIntro>{t("dotIntro")}</LessonIntro>
      <MiniMap
        width={358}
        height={250}
        parks={[{ x: 196, y: 24, w: 70, h: 92 }]}
        blocks={[
          { x: 14, y: 24, w: 64, h: 92 },
          { x: 102, y: 24, w: 64, h: 92 },
          { x: 292, y: 24, w: 60, h: 92 },
          { x: 14, y: 160, w: 64, h: 80 },
          { x: 292, y: 160, w: 60, h: 80 },
        ]}
        minor="M-10 138 H370 M90 -10 V260 M280 -10 V260"
        major="M184 -10 V260"
        overlay={
          <>
            <StatusPillMock color={color} label={t(s.label)} sub={`${t(s.source)} · ±${formatDistance(s.accuracyM, language)}`} />
            {state === "nofix" && <MapChip text={since} style={styles.strip} />}
            {state === "spoof" && <MapChip text={t("showGhost")} accent style={styles.ghostButton} />}
          </>
        }
      >
        {state === "spoof" && (
          <G>
            <Circle cx={318} cy={62} r={16} fill={palette.idle.a} stroke={palette.idle.c} strokeWidth={1.5} strokeDasharray="4 3" />
            <Circle cx={318} cy={62} r={6} fill={palette.idle.c} />
          </G>
        )}
        <Puck x={184} y={168} r={s.r} />
      </MiniMap>
      <ChoiceChips<State>
        value={state}
        onChange={setState}
        options={(Object.keys(STATES) as State[]).map((key) => ({
          value: key,
          label: t(STATES[key].chip),
          color: palette[STATES[key].color].c,
        }))}
      />
      <View>
        <ExplainCard
          rows={[
            { label: t("guideApp"), text: t(s.app) },
            { label: t("guideYou"), text: t(s.you), strong: true },
          ]}
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  strip: { left: 10, top: 62 },
  ghostButton: { left: 10, right: 10, bottom: 10, height: 36, alignItems: "center" },
});
