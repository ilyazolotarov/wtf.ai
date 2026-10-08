import { Host, Slider } from "@expo/ui";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { ScreenCard, ScreenNote, ScreenRow, SectionLabel } from "@/components/screens/screen-ui";
import { fmtBytes } from "@/components/vehicle/format";
import { useT } from "@/i18n/provider";
import { useRecorderSnapshot, useRuntime } from "@/providers/runtime-provider";

/** The slider's stops: fine steps where a phone's space is tight, coarse above. */
const STOPS_GB = [0.25, 0.5, 1, 2, 3, 5, 10];

const nearestStop = (gb: number) =>
  STOPS_GB.reduce((best, s, i) => (Math.abs(s - gb) < Math.abs(STOPS_GB[best] - gb) ? i : best), 0);

const fmtGb = (gb: number) => (gb < 1 ? `${Math.round(gb * 1000)} MB` : `${gb} GB`);

/** How much space trip logs may take before the oldest are deleted (TRIP-LOGGER-SPEC §7.2). */
export function TripStorageSection() {
  const { t } = useT();
  const { recorder } = useRuntime();
  const rec = useRecorderSnapshot();
  // The thumb follows the finger; the setting is saved on each stop (pruning waits until the slider rests).
  const [stop, setStop] = useState(() => nearestStop(rec.settings.storageLimitGb));
  const used = rec.trips.reduce((sum, trip) => sum + (trip.id === rec.current?.id ? (rec.current?.bytes ?? 0) : trip.bytes), 0);

  return (
    <View style={styles.group}>
      <SectionLabel>{t("tripStorage")}</SectionLabel>
      <ScreenCard style={styles.card}>
        <ScreenRow labelKey="tripStorageLimit" value={fmtGb(STOPS_GB[stop])} />
        <Host matchContents={{ vertical: true }}>
          <Slider
            value={stop}
            min={0}
            max={STOPS_GB.length - 1}
            step={1}
            onValueChange={(v) => {
              const i = Math.round(v);
              if (i === stop) return;
              setStop(i);
              recorder.updateSettings({ storageLimitGb: STOPS_GB[i] });
            }}
          />
        </Host>
        <ScreenRow labelKey="tripStorageUsed" value={fmtBytes(used)} />
        <ScreenNote>{t("tripStorageNote")}</ScreenNote>
      </ScreenCard>
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: 8 },
  card: { gap: 10 },
});
