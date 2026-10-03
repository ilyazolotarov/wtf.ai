import { useRef, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";

import {
    ScreenAction,
    ScreenCard,
    ScreenContent,
    ScreenNote,
} from "@/components/screens/screen-ui";
import { T } from "@/components/ui/text";
import { usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { downloadsMock } from "@/mocks";
import { kvStore } from "@/services/kv-store";
import {
    installMapPack,
    removeMapPack,
    useActiveMapPack,
    type InstallProgress,
} from "@/services/offline-map/map-pack";

const PACK_URL_KEY = "map-pack-url";
const DEFAULT_PACK_URL = "http://192.168.1.10:8765/chernihiv/";

const formatMb = (bytes: number) => `${(bytes / 1e6).toFixed(bytes < 1e8 ? 1 : 0)} MB`;

/**
 * Map pack: real (installed from `tiles serve` on the PC until hosted downloads
 * exist, SPEC §3.8). Routing pack is still a mock with Download disabled.
 */
export default function DownloadsScreen() {
  const { t } = useT();
  const palette = usePalette();
  const pack = useActiveMapPack();
  const [url, setUrl] = useState(() => kvStore.getJson<string>(PACK_URL_KEY) ?? DEFAULT_PACK_URL);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const install = async () => {
    kvStore.setJson(PACK_URL_KEY, url.trim());
    const controller = new AbortController();
    abort.current = controller;
    setError(null);
    try {
      await installMapPack(url, setProgress, controller.signal);
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      abort.current = null;
      setProgress(null);
    }
  };

  const routing = downloadsMock.find((p) => p.id === "routing");

  return (
    <ScreenContent title={t("downloads")}>
      <ScreenCard style={styles.card}>
        <View style={styles.head}>
          <View style={styles.copy}>
            <T w="semibold" size={16}>
              {t("mapTiles")}
            </T>
            <T size={12} color={palette.text2}>
              {pack
                ? `${pack.manifest.region} · ${formatMb(pack.manifest.total_size)} · OSM ${pack.manifest.osm_date}` +
                  (pack.source === "bundled" ? ` · ${t("bundledPack")}` : "")
                : t("onlineMapNote")}
            </T>
          </View>
          <T w="semibold" size={13} color={pack ? palette.ok.c : palette.text2}>
            {pack ? t("readyOffline") : t("notDownloaded")}
          </T>
        </View>
        {pack?.source === "downloaded" && progress == null && (
          <ScreenAction labelKey="removePack" compact secondary onPress={removeMapPack} />
        )}
      </ScreenCard>

      <ScreenCard style={styles.card}>
        <T w="semibold" size={14}>
          {t("installFromComputer")}
        </T>
        <TextInput
          value={url}
          onChangeText={setUrl}
          editable={progress == null}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={[styles.input, { color: palette.text, backgroundColor: palette.surface }]}
        />
        {progress ? (
          <>
            <T size={13} color={palette.text2}>
              {`${t("downloading")} ${formatMb(progress.bytes)} / ${formatMb(progress.total)}`}
            </T>
            <ScreenAction labelKey="cancel" compact secondary onPress={() => abort.current?.abort()} />
          </>
        ) : (
          <ScreenAction labelKey="download" compact onPress={install} />
        )}
        {error && (
          <T size={13} color={palette.bad.c}>
            {error}
          </T>
        )}
        <ScreenNote>{t("installFromComputerNote")}</ScreenNote>
      </ScreenCard>

      {routing && (
        <ScreenCard style={styles.card}>
          <View style={styles.head}>
            <View style={styles.copy}>
              <T w="semibold" size={16}>
                {t("routingData")}
              </T>
              <T size={12} color={palette.text2}>
                {`${routing.size} · v${routing.version}`}
              </T>
            </View>
            <T w="semibold" size={13} color={palette.text2}>
              {t("notDownloaded")}
            </T>
          </View>
          <ScreenAction labelKey="download" compact disabled />
        </ScreenCard>
      )}
    </ScreenContent>
  );
}

const styles = StyleSheet.create({
  card: { gap: 12 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 10 },
  copy: { flex: 1, gap: 3 },
  input: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
});
