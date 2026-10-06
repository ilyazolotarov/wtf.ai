import { router, type Href } from "expo-router";
import { Pressable, StyleSheet, useColorScheme, View } from "react-native";

import { ScreenContent, ScreenSection } from "@/components/screens/screen-ui";
import { Icon, type IconName } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { useMapPacks } from "@/services/offline-map/map-packs";

export default function MoreScreen() {
  const { t, language } = useT();
  const palette = usePalette();
  const dark = useColorScheme() === "dark";
  const { installed } = useMapPacks();
  // A region holds everything offline: the map, the road graph and the search index.
  const ready = installed.active != null;

  const items: { icon: IconName; label: string; sub: string; subColor?: string; href: Href }[] = [
    {
      icon: "download",
      label: t("downloads"),
      sub: ready ? t("readyOffline") : t("notDownloaded"),
      subColor: ready ? palette.ok.c : undefined,
      href: "/downloads?from=more",
    },
    {
      icon: "settings",
      label: t("settings"),
      sub: `${language === "uk" ? "Українська" : "English"} · ${dark ? t("darkAppearance") : t("lightAppearance")}`,
      href: "/settings?from=more",
    },
  ];

  return (
    <ScreenContent title={t("more")}>
      <ScreenSection>
        {items.map((item) => (
          <Pressable
            key={item.label}
            onPress={() => router.push(item.href)}
            accessibilityRole="button"
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <View style={[styles.tile, { backgroundColor: palette.accentA }]}>
              <Icon name={item.icon} size={20} color={palette.accent} />
            </View>
            <View style={styles.copy}>
              <T w="medium" size={16}>
                {item.label}
              </T>
              <T size={13} color={item.subColor ?? palette.text2} numberOfLines={1}>
                {item.sub}
              </T>
            </View>
            <Icon name="chevron_right" size={14} color={palette.text2} />
          </Pressable>
        ))}
      </ScreenSection>
    </ScreenContent>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: 14 },
  pressed: { opacity: 0.7 },
  tile: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: { flex: 1, gap: 2 },
});
