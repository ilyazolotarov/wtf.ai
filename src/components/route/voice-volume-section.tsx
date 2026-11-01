import { Host } from "@expo/ui";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { ScreenCard, ScreenNote, ScreenRow, SectionLabel, Segmented } from "@/components/screens/screen-ui";
import { SwitchRow } from "@/components/screens/setting-rows";
import { LevelSlider } from "@/components/ui/level-slider";
import { T } from "@/components/ui/text";
import { useT } from "@/i18n/provider";

import {
  loadVoiceVolume,
  saveFewerAnnouncements,
  saveVoiceName,
  saveVoiceVolume,
  useFewerAnnouncements,
  useVoiceName,
} from "./use-voice-guidance";
import type { VoiceName } from "./voice-phrases";
import { hushVoice, sayPhrases } from "./voice-player";

/** The slider's stops, in tenths of the recorded level; 0 turns the voice off. */
const MAX_STOP = 10;

/**
 * The route voice (ROUTING-SPEC §8.5): how loud, whose voice and how much it says, with a sample of the level and of
 * the voice.
 */
export function VoiceVolumeSection() {
  const { t, language } = useT();
  const [stop, setStop] = useState(() => Math.round(loadVoiceVolume() * 10));
  const voice = useVoiceName();
  const fewer = useFewerAnnouncements();
  const sample = () => {
    hushVoice();
    sayPhrases([{ id: "now-left", text: t("mLeft") }], language);
  };

  return (
    <View style={styles.group}>
      <SectionLabel>{t("routeVoice")}</SectionLabel>
      <ScreenCard style={styles.card}>
        <ScreenRow labelKey="voiceVolumeLevel" value={stop === 0 ? t("voiceVolumeOff") : `${stop * 10}%`} />
        <Host matchContents={{ vertical: true }}>
          <LevelSlider
            value={stop}
            min={0}
            max={MAX_STOP}
            step={1}
            onValueChange={(i) => {
              if (i === stop) return;
              setStop(i);
              saveVoiceVolume(i / 10);
            }}
            // A sample once the finger lifts, at the level it stopped on (already saved).
            onRelease={(i) => {
              if (i !== 0) sample();
            }}
          />
        </Host>
        <ScreenNote>{t(stop === 0 ? "voiceVolumeOffNote" : "voiceVolumeNote")}</ScreenNote>
        {stop > 0 && (
          <>
            <T size={14}>{t("voiceName")}</T>
            <Segmented<VoiceName>
              value={voice}
              onChange={(v) => {
                saveVoiceName(v);
                sample();
              }}
              options={[
                { value: "female", label: t("voiceFemale") },
                { value: "male", label: t("voiceMale") },
              ]}
            />
            <SwitchRow value={fewer} onValueChange={saveFewerAnnouncements} label={t("fewerAnnouncements")} />
            <ScreenNote>{t("fewerAnnouncementsNote")}</ScreenNote>
          </>
        )}
      </ScreenCard>
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: 8 },
  card: { gap: 10 },
});
