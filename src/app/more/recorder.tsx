import { router } from "expo-router";
import { StyleSheet, View } from "react-native";

import { TripStorageSection } from "@/components/recorder/trip-storage-section";
import { TripUploadSection } from "@/components/recorder/trip-upload-section";
import { ScreenAction, ScreenContent, ScreenNote, ScreenRow, ScreenSection } from "@/components/screens/screen-ui";
import { CycleRow, SwitchRow } from "@/components/screens/setting-rows";
import { dash, fmt, fmtBytes, fmtDuration } from "@/components/vehicle/format";
import { usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { useRecorderSnapshot, useRuntime } from "@/providers/runtime-provider";

/** Everything about trip logs in one sheet: the trip now, the logs, how they are recorded, sent and kept. */
export default function RecorderScreen() {
  const { t } = useT();
  const palette = usePalette();
  const { recorder, uploader } = useRuntime();
  const rec = useRecorderSnapshot();
  const recording = rec.state === "recording";

  return (
    <ScreenContent title={t("tripRecorder")}>
      <ScreenSection>
        <ScreenRow labelKey="recorderState" value={rec.state} valueColor={recording ? palette.bad.c : undefined} />
        <ScreenRow labelKey="tripId" value={rec.current?.id ?? dash} />
        <ScreenRow labelKey="startReason" value={rec.current?.startReason ?? dash} />
        <ScreenRow labelKey="tripDuration" value={rec.current ? fmtDuration(rec.current.durationS) : dash} />
        <ScreenRow labelKey="fileSize" value={rec.current ? fmtBytes(rec.current.bytes) : dash} />
        <ScreenRow labelKey="distance" value={rec.current ? fmt(rec.current.distanceM / 1000, 2, "km") : dash} />
        {rec.lastError && <ScreenRow labelKey="lastError" value={rec.lastError} valueColor={palette.bad.c} />}
      </ScreenSection>
      <View style={styles.stack}>
        {recording ? (
          <>
            <ScreenAction labelKey="stopTrip" onPress={() => recorder.manualStop()} />
            <ScreenAction labelKey="addMarker" secondary onPress={() => recorder.marker()} />
          </>
        ) : (
          <ScreenAction labelKey="startManualTrip" onPress={() => recorder.manualStart()} />
        )}
        <ScreenAction labelKey="trips" secondary onPress={() => router.push("/trips")} />
      </View>
      <ScreenNote>{t("tripsHint")}</ScreenNote>

      <ScreenSection title={t("recordingSettings")} plain>
        <CycleRow
          labelKey="parkedTimeout"
          value={rec.settings.parkedTimeoutMin}
          options={[1, 3, 5, 10]}
          format={(v) => `${v} ${t("minutesShort")}`}
          onChange={(v) => recorder.updateSettings({ parkedTimeoutMin: v })}
        />
        <CycleRow
          labelKey="lingerTime"
          value={rec.settings.lingerMin}
          options={[5, 15, 30]}
          format={(v) => `${v} ${t("minutesShort")}`}
          onChange={(v) => recorder.updateSettings({ lingerMin: v })}
        />
        <ScreenNote>{t("recordingTimesNote")}</ScreenNote>
        <SwitchRow
          value={rec.settings.rawImu}
          onValueChange={(v) => recorder.updateSettings({ rawImu: v })}
          label={t("rawImu")}
        />
        <SwitchRow
          value={rec.settings.imuRateHz === 100}
          onValueChange={(v) => recorder.updateSettings({ imuRateHz: v ? 100 : 50 })}
          label={t("imuRate100")}
        />
      </ScreenSection>

      {uploader && <TripUploadSection uploader={uploader} />}
      <TripStorageSection />
    </ScreenContent>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 10, marginTop: -6 },
});
