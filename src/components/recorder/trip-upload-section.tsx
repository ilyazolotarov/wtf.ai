import { Host, Switch } from "@expo/ui";
import { useState, useSyncExternalStore } from "react";
import { Alert, StyleSheet, TextInput, View } from "react-native";

import { ScreenAction, ScreenCard, ScreenNote, ScreenRow, SectionLabel } from "@/components/screens/screen-ui";
import { INPUT_MAX_FONT_SCALE, T } from "@/components/ui/text";
import { usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { useRecorderSnapshot } from "@/providers/runtime-provider";
import { pendingLogs, type TripUploader, type UploaderSnapshot } from "@/services/trip-upload/trip-uploader";

/**
 * Opt-in trip log upload for testers (TRIP-LOGGER-SPEC §7.1): enter the developer's code, confirm what is sent and under
 * which name, then logs go by themselves.
 */
export function TripUploadSection({ uploader }: { uploader: TripUploader }) {
  const { t } = useT();
  const palette = usePalette();
  const snap = useSyncExternalStore(uploader.subscribe, uploader.getSnapshot, uploader.getSnapshot);
  const recording = useRecorderSnapshot();
  const [typed, setTyped] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setChecking(true);
    setError(null);
    const result = await uploader.connect(typed, (name) => confirmSending(name, t));
    setChecking(false);
    if (result === "ok") setTyped("");
    else if (result === "cancelled") return;
    else setError(t(result === "malformed" ? "tripUploadMalformed" : result === "rejected" ? "tripUploadRejected" : result === "failed" ? "tripUploadServerError" : "tripUploadOffline"));
  };

  // From the snapshots, not `uploader.pending()`: the React Compiler kept that call's first result (`pendingLogs`).
  const waiting = pendingLogs(recording, snap).length;

  return (
    <View style={styles.group}>
      <SectionLabel>{t("tripUpload")}</SectionLabel>
      <ScreenCard style={styles.card}>
        <T size={14} color={palette.text2} style={styles.lines}>
          {t("tripUploadAbout")}
        </T>
        {snap.name === null ? (
          <>
            <TextInput
              value={typed}
              onChangeText={(text) => {
                setTyped(text);
                setError(null);
              }}
              onSubmitEditing={() => void connect()}
              placeholder="bakim-tuvod-segap"
              maxFontSizeMultiplier={INPUT_MAX_FONT_SCALE}
              placeholderTextColor={palette.text2}
              accessibilityLabel={t("tripUploadCode")}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              returnKeyType="done"
              style={[styles.input, { color: palette.text, backgroundColor: palette.secBg }]}
            />
            {error && <ScreenNote color={palette.bad.c}>{error}</ScreenNote>}
            <ScreenAction
              labelKey="tripUploadConnect"
              label={checking ? t("tripUploadChecking") : undefined}
              disabled={checking || !typed.trim()}
              onPress={() => void connect()}
            />
          </>
        ) : (
          <>
            <ScreenRow labelKey="tripUploadAs" value={snap.name} />
            <ScreenRow labelKey="tripUploadSent" value={String(snap.sentCount)} />
            <ScreenRow labelKey="tripUploadWaiting" value={String(waiting)} />
            <ScreenNote color={snap.status === "codeRejected" || snap.status === "error" ? palette.bad.c : undefined}>
              {statusText(snap, t)} {t("tripUploadDeleted")}
            </ScreenNote>
            <View style={styles.switchRow}>
              <T size={14} color={palette.text} style={styles.flex}>
                {t("tripUploadWifiOnly")}
              </T>
              <Host matchContents>
                <Switch value={snap.wifiOnly} onValueChange={(v) => uploader.setWifiOnly(v)} />
              </Host>
            </View>
            <ScreenAction labelKey="tripUploadNow" secondary disabled={snap.status === "uploading"} onPress={() => void uploader.run()} />
            <ScreenAction labelKey="tripUploadOff" secondary onPress={() => void uploader.disconnect()} />
          </>
        )}
      </ScreenCard>
    </View>
  );
}

/** What leaves the phone, and as whom, before the first log does (SPEC §2.2). */
function confirmSending(name: string, t: ReturnType<typeof useT>["t"]): Promise<boolean> {
  return new Promise((resolve) =>
    Alert.alert(t("tripUploadConfirmTitle").replace("{name}", name), t("tripUploadConfirmBody"), [
      { text: t("cancel"), style: "cancel", onPress: () => resolve(false) },
      { text: t("tripUploadConfirmYes"), onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) }),
  );
}

function statusText(snap: UploaderSnapshot, t: ReturnType<typeof useT>["t"]): string {
  switch (snap.status) {
    case "uploading":
      return t("tripUploadSending").replace("{name}", snap.current ?? "");
    case "waitingWifi":
      return t("tripUploadWaitingWifi");
    case "offline":
      return t("tripUploadNoNetwork");
    case "codeRejected":
      return t("tripUploadCodeRevoked");
    case "error":
      return t("tripUploadFailed").replace("{error}", snap.lastError ?? "?");
    default:
      return t("tripUploadIdle");
  }
}

const styles = StyleSheet.create({
  group: { gap: 8 },
  card: { gap: 12 },
  lines: { lineHeight: 20 },
  input: { fontSize: 16, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, borderCurve: "continuous" },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  flex: { flex: 1 },
});
