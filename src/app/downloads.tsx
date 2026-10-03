import { StyleSheet, View } from "react-native";

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

/** Offline packs are not built yet (SPEC §3.8): Download stays disabled. */
export default function DownloadsScreen() {
  const { t } = useT();
  const palette = usePalette();
  return (
    <ScreenContent title={t("downloads")}>
      {downloadsMock.map((pack) => {
        const ready = pack.status === "ready";
        return (
          <ScreenCard key={pack.id} style={styles.card}>
            <View style={styles.head}>
              <View style={styles.copy}>
                <T w="semibold" size={16}>
                  {t(pack.id === "map" ? "mapTiles" : "routingData")}
                </T>
                <T size={12} color={palette.text2}>
                  {`${pack.size} · v${pack.version}`}
                </T>
              </View>
              <T w="semibold" size={13} color={ready ? palette.ok.c : palette.text2}>
                {ready ? t("readyOffline") : t("notDownloaded")}
              </T>
            </View>
            <ScreenAction labelKey="download" compact disabled />
          </ScreenCard>
        );
      })}
      <ScreenNote>{t("onlineMapNote")}</ScreenNote>
    </ScreenContent>
  );
}

const styles = StyleSheet.create({
  card: { gap: 12 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 10 },
  copy: { flex: 1, gap: 3 },
});
