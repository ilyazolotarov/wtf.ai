import { router } from "expo-router";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";

import { RegionDownloads } from "@/components/downloads/region-downloads";
import { ScreenContent } from "@/components/screens/screen-ui";
import { Icon } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { usePalette } from "@/constants/theme";
import { useHasUsableMap } from "@/config/map";
import { useT } from "@/i18n/provider";

/**
 * Required first download (UI-SPEC §7.4): the app has no online map, so until a region is
 * installed this screen can't be dismissed. It closes itself once the region's map is usable.
 */
export default function MapSetupScreen() {
  const { t } = useT();
  const palette = usePalette();
  const ready = useHasUsableMap();

  useEffect(() => {
    if (ready && router.canGoBack()) router.back();
  }, [ready]);

  return (
    <ScreenContent fullScreen>
      <View style={styles.intro}>
        <View style={[styles.iconTile, { backgroundColor: palette.accentA }]}>
          <Icon name="download" size={30} color={palette.accent} />
        </View>
        <T w="semibold" size={30} style={styles.title}>
          {t("mapSetupTitle")}
        </T>
        <T size={16} color={palette.text2} style={styles.lead}>
          {t("mapSetupBody")}
        </T>
      </View>
      <RegionDownloads />
    </ScreenContent>
  );
}

const styles = StyleSheet.create({
  intro: { gap: 14, paddingTop: 24, paddingBottom: 4 },
  iconTile: { width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center" },
  title: { lineHeight: 34, letterSpacing: -0.6 },
  lead: { lineHeight: 24 },
});
