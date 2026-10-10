import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { formatMb } from "@/components/downloads/region-downloads";
import {
  ScreenAction,
  ScreenCard,
  ScreenContent,
  ScreenNote,
  ScreenRow,
  ScreenSection,
} from "@/components/screens/screen-ui";
import { T } from "@/components/ui/text";
import { appCode } from "@/components/update/app-code";
import { usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import type { AppBuildInfo } from "@/services/app-update/decide";
import { openAltStore, ownBuild, platform } from "@/services/app-update/native-build";
import {
  cancelBuildDownload,
  checkForUpdates,
  getBuild,
  openBuild,
  useUpdateCenter,
  type BuildDownload,
} from "@/services/app-update/update-center";

/** App update (docs/UPDATES-SPEC.md §5.5): this app, what is new, and getting it installed. */
export default function UpdateScreen() {
  const { t } = useT();
  const palette = usePalette();
  const { found, latest, jsMessage, checking, lastCheck, checkError, download } = useUpdateCenter();
  const own = ownBuild();
  const [altStoreMissing, setAltStoreMissing] = useState(false);
  const native = found.native;

  const altStore = async () => setAltStoreMissing(!(await openAltStore()));

  return (
    <ScreenContent title={t("appUpdate")}>
      <ScreenSection title={t("appUpdateThisApp")}>
        <ScreenRow labelKey="appVersion" value={Constants.expoConfig?.version ?? t("unavailableValue")} />
        <ScreenRow labelKey="appUpdateBuild" value={own.build != null ? String(own.build) : "dev"} />
        <ScreenRow labelKey="appCode" value={appCode(t)} />
      </ScreenSection>

      {!own.release && <ScreenNote>{t("appUpdateOff")}</ScreenNote>}

      {found.js && (
        <ScreenCard style={styles.card}>
          <T w="semibold" size={16}>
            {t("appUpdateReady")}
          </T>
          {jsMessage && <T size={14}>{jsMessage}</T>}
          <ScreenNote>{t("appUpdateRestartNote")}</ScreenNote>
          <ScreenAction labelKey="appUpdateRestart" icon="refresh" onPress={() => void Updates.reloadAsync()} />
        </ScreenCard>
      )}

      {native ? (
        <ScreenCard style={styles.card}>
          <T w="semibold" size={16}>
            {t("appUpdateNew")}: {native.version} ({t("appUpdateBuild").toLowerCase()} {native.build})
          </T>
          <T size={13} color={palette.text2}>
            {new Date(native.date).toLocaleDateString()} · {formatMb(native.size)}
          </T>
          <Notes build={native} />
          {platform === "android" ? (
            <AndroidInstall download={download?.build === native.build ? download : null} />
          ) : (
            <View style={styles.actions}>
              <ScreenAction labelKey="appUpdateOpenAltStore" icon="open_in_new" onPress={() => void altStore()} />
              <IpaShare download={download?.build === native.build ? download : null} />
            </View>
          )}
        </ScreenCard>
      ) : (
        !found.js &&
        own.release && (
          <ScreenCard style={styles.card}>
            <View style={styles.status}>
              {checking && <ActivityIndicator />}
              <T w="semibold" size={16} color={checking ? undefined : palette.ok.c}>
                {checking ? t("appUpdateChecking") : t("appUpdateUpToDate")}
              </T>
            </View>
          </ScreenCard>
        )
      )}

      {platform === "ios" && (
        <>
          <ScreenNote>{t("appUpdateAltStoreNote")}</ScreenNote>
          {!native && <ScreenAction labelKey="appUpdateOpenAltStore" secondary compact onPress={() => void altStore()} />}
          {altStoreMissing && <ScreenNote color={palette.bad.c}>{t("appUpdateNoAltStore")}</ScreenNote>}
          {altStoreMissing && !native && latest && <IpaShare download={download?.build === latest.build ? download : null} />}
        </>
      )}

      {checkError && <ScreenNote color={palette.bad.c}>{t("appUpdateFailed").replace("{error}", checkError)}</ScreenNote>}
      {lastCheck != null && (
        <ScreenNote>{t("appUpdateLastCheck").replace("{time}", new Date(lastCheck).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</ScreenNote>
      )}
      <ScreenAction labelKey="appUpdateCheckNow" secondary disabled={checking} onPress={() => void checkForUpdates("manual")} />
    </ScreenContent>
  );
}

function Notes({ build }: { build: AppBuildInfo }) {
  const { t } = useT();
  if (!build.notes.length) return null;
  return (
    <View style={styles.notes}>
      <T w="medium" size={13}>
        {t("appUpdateWhatsNew")}
      </T>
      {build.notes.map((note) => (
        <T key={note} size={13}>
          • {note}
        </T>
      ))}
    </View>
  );
}

function Progress({ download }: { download: BuildDownload }) {
  const { t } = useT();
  const palette = usePalette();
  return (
    <View style={styles.progress}>
      <T size={13} color={palette.text2}>
        {t("appUpdateDownloading").replace("{done}", formatMb(download.bytes)).replace("{total}", formatMb(download.total))}
      </T>
      <View style={[styles.bar, { backgroundColor: palette.surface }]}>
        <View
          style={[
            styles.barFill,
            { backgroundColor: palette.accent, width: `${download.total ? Math.min(100, (100 * download.bytes) / download.total) : 0}%` },
          ]}
        />
      </View>
      <ScreenAction labelKey="cancel" compact secondary onPress={cancelBuildDownload} />
    </View>
  );
}

/** Android: download the APK, then the system installer. */
function AndroidInstall({ download }: { download: BuildDownload | null }) {
  const { t } = useT();
  const palette = usePalette();
  if (download?.phase === "downloading") return <Progress download={download} />;
  return (
    <View style={styles.actions}>
      {download?.phase === "failed" && <ScreenNote color={palette.bad.c}>{download.error}</ScreenNote>}
      {download?.phase === "ready" ? (
        <ScreenAction labelKey="appUpdateInstall" icon="install_mobile" onPress={() => void openBuild()} />
      ) : (
        <ScreenAction labelKey="appUpdateDownloadInstall" icon="download" onPress={() => void getBuild({ install: true })} />
      )}
      <ScreenNote>{t("appUpdateInstallNote")}</ScreenNote>
    </View>
  );
}

/** iOS without AltStore: the IPA to the share sheet. */
function IpaShare({ download }: { download: BuildDownload | null }) {
  const palette = usePalette();
  if (download?.phase === "downloading") return <Progress download={download} />;
  return (
    <>
      {download?.phase === "failed" && <ScreenNote color={palette.bad.c}>{download.error}</ScreenNote>}
      <ScreenAction
        labelKey="appUpdateShareIpa"
        icon="ios_share"
        secondary
        compact
        onPress={() => void (download?.phase === "ready" ? openBuild() : getBuild({ install: true }))}
      />
    </>
  );
}

const styles = StyleSheet.create({
  card: { gap: 10 },
  status: { flexDirection: "row", alignItems: "center", gap: 10 },
  notes: { gap: 4 },
  actions: { gap: 10 },
  progress: { gap: 8 },
  bar: { height: 6, borderRadius: 3, overflow: "hidden" },
  barFill: { height: 6, borderRadius: 3 },
});
