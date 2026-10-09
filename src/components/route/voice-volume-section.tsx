import { Host, Slider } from "@expo/ui";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { ScreenCard, ScreenNote, ScreenRow, SectionLabel } from "@/components/screens/screen-ui";
import { useT } from "@/i18n/provider";

import { loadVoiceVolume, saveVoiceVolume } from "./use-voice-guidance";
import { hushVoice, sayPhrases } from "./voice-player";

/** The slider's stops, in tenths of the recorded level; 0 turns the voice off. */
const MAX_STOP = 10;
/** A sample is said once the slider rests this long. */
const SAMPLE_DELAY_MS = 600;

/** How loud the route voice is (ROUTING-SPEC §8.5), with a sample to hear it. */
export function VoiceVolumeSection() {
  const { t, language } = useT();
  const [stop, setStop] = useState(() => Math.round(loadVoiceVolume() * 10));
  const sample = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (sample.current) clearTimeout(sample.current);
    },
    [],
  );

  return (
    <View style={styles.group}>
      <SectionLabel>{t("voiceVolume")}</SectionLabel>
      <ScreenCard style={styles.card}>
        <ScreenRow labelKey="voiceVolumeLevel" value={stop === 0 ? t("voiceVolumeOff") : `${stop * 10}%`} />
        <Host matchContents={{ vertical: true }}>
          <Slider
            value={stop}
            min={0}
            max={MAX_STOP}
            step={1}
            onValueChange={(v) => {
              const i = Math.round(v);
              if (i === stop) return;
              setStop(i);
              saveVoiceVolume(i / 10);
              if (sample.current) clearTimeout(sample.current);
              if (i === 0) return;
              sample.current = setTimeout(() => {
                hushVoice();
                sayPhrases([{ id: "now-left", text: t("mLeft") }], language);
              }, SAMPLE_DELAY_MS);
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
