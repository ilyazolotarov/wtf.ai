import { Host } from "@expo/ui";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { ScreenCard, ScreenNote, ScreenRow, SectionLabel } from "@/components/screens/screen-ui";
import { LevelSlider } from "@/components/ui/level-slider";
import { useT } from "@/i18n/provider";

import { loadVoiceVolume, saveVoiceVolume } from "./use-voice-guidance";
import { hushVoice, sayPhrases } from "./voice-player";

/** The slider's stops, in tenths of the recorded level; 0 turns the voice off. */
const MAX_STOP = 10;

/** How loud the route voice is (ROUTING-SPEC §8.5), with a sample to hear it. */
export function VoiceVolumeSection() {
  const { t, language } = useT();
  const [stop, setStop] = useState(() => Math.round(loadVoiceVolume() * 10));

  return (
    <View style={styles.group}>
      <SectionLabel>{t("voiceVolume")}</SectionLabel>
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
              if (i === 0) return;
              hushVoice();
              sayPhrases([{ id: "now-left", text: t("mLeft") }], language);
            }}
          />
        </Host>
        <ScreenNote>{t(stop === 0 ? "voiceVolumeOffNote" : "voiceVolumeNote")}</ScreenNote>
      </ScreenCard>
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: 8 },
  card: { gap: 10 },
});
