import * as Sharing from "expo-sharing";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Alert, StyleSheet, Text, useColorScheme, View } from "react-native";

import { ScreenAction, ScreenContent, ScreenNote, ScreenRow, ScreenSection } from "@/components/screens/screen-ui";
import { fmt, fmtBytes, fmtDate, fmtDuration } from "@/components/vehicle/format";
import { Colors } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { useRecorderSnapshot, useRuntime } from "@/providers/runtime-provider";
import type { TripIndexEntry } from "@/services/trip-recorder/trip-recorder";

/** Dev-only trip list: share / delete ULog files (TRIP-LOGGER-SPEC §7, §9.4). */
export default function TripsScreen() {
  const { t } = useT();
  const { recorder, uploader } = useRuntime();
  const snap = useRecorderSnapshot();
  const palette = Colors[useColorScheme() === "dark" ? "dark" : "light"];
  const [archiving, setArchiving] = useState(false);
  const upload = useSyncExternalStore(
    uploader?.subscribe ?? noSubscribe,
    uploader?.getSnapshot ?? noUpload,
    uploader?.getSnapshot ?? noUpload,
  );

  useEffect(() => recorder.refresh(), [recorder]);

  const share = async (trip: TripIndexEntry) => {
    await Sharing.shareAsync(recorder.tripUri(trip), {
      mimeType: "application/octet-stream",
      UTI: "public.data",
      dialogTitle: trip.fileName,
    });
  };

  const shareAll = () => {
    setArchiving(true);
    // Building the ZIP blocks the JS thread; let the disabled button render first.
    setTimeout(async () => {
      try {
        const uri = recorder.archiveAll();
        if (uri) await Sharing.shareAsync(uri, { mimeType: "application/zip", UTI: "public.zip-archive" });
      } catch (e) {
        Alert.alert(t("shareAll"), e instanceof Error ? e.message : String(e));
      } finally {
        setArchiving(false);
      }
    }, 50);
  };

  const finished = snap.trips.filter((trip) => trip.id !== snap.current?.id).length;

  const confirmDelete = (onYes: () => void) =>
    Alert.alert(t("delete"), undefined, [
      { text: t("no"), style: "cancel" },
      { text: t("yes"), style: "destructive", onPress: onYes },
    ]);

  return (
    <ScreenContent>
      <ScreenSection plain>
        <ScreenRow labelKey="freeSpace" value={fmtBytes(snap.freeBytes)} />
        <ScreenRow labelKey="trips" value={String(snap.trips.length)} />
        {finished > 0 && (
          <ScreenAction
            labelKey="shareAll"
            label={archiving ? t("archiving") : undefined}
            secondary
            disabled={archiving}
            onPress={shareAll}
          />
        )}
        {snap.trips.length > 0 && (
          <ScreenAction labelKey="deleteAll" secondary onPress={() => confirmDelete(() => recorder.deleteAll())} />
        )}
      </ScreenSection>
      {snap.trips.length === 0 && <ScreenNote>{t("noTrips")}</ScreenNote>}
      {snap.trips.map((trip) => {
        const live = snap.current?.id === trip.id;
        const meta = [
          live ? t("recording") : trip.complete ? fmtDuration(trip.durationS) : t("incomplete"),
          fmtBytes(live ? snap.current?.bytes : trip.bytes),
          trip.distanceM > 0 || live ? fmt(((live ? snap.current?.distanceM : trip.distanceM) ?? 0) / 1000, 2, "km") : null,
          trip.adapterName,
          trip.endReason,
          upload?.name && trip.fileName in upload.uploaded ? t("tripUploaded") : null,
          upload?.refused[trip.fileName] ? t("tripUploadRefused").replace("{error}", upload.refused[trip.fileName]) : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <View key={trip.id} style={[styles.card, { backgroundColor: palette.backgroundElement }]}>
            <Text style={[styles.title, { color: palette.text }]}>
              {fmtDate(trip.startUtcMs)} · {trip.id}
            </Text>
            <Text style={[styles.meta, { color: live ? palette.bad.c : palette.textSecondary }]}>{meta}</Text>
            <View style={styles.actions}>
              <View style={styles.action}>
                <ScreenAction labelKey="share" secondary disabled={live} onPress={() => void share(trip)} />
              </View>
              <View style={styles.action}>
                <ScreenAction labelKey="delete" secondary disabled={live} onPress={() => confirmDelete(() => recorder.deleteTrip(trip.id))} />
              </View>
            </View>
          </View>
        );
      })}
      <ScreenNote>{t("tripsHint")}</ScreenNote>
    </ScreenContent>
  );
}

const noSubscribe = () => () => {};
const noUpload = () => null;

const styles = StyleSheet.create({
  card: { padding: 16, borderRadius: 24, borderCurve: "continuous", gap: 6 },
  title: { fontSize: 15, fontWeight: "600" },
  meta: { fontSize: 13 },
  actions: { flexDirection: "row", gap: 10 },
  action: { flex: 1 },
});
