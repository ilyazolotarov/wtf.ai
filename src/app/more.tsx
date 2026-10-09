import { router, type Href } from "expo-router";
import { Pressable, StyleSheet, useColorScheme, View } from "react-native";

import { AVAILABLE_LESSONS } from "@/components/guide/lesson-bodies";
import { ScreenContent, ScreenSection } from "@/components/screens/screen-ui";
import { useNavStatus } from "@/components/status/use-nav-status";
import { Icon, type IconName } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { fmtBytes } from "@/components/vehicle/format";
import { usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { useRecorderSnapshot } from "@/providers/runtime-provider";
import { useLessonsDone } from "@/services/guide/guide-progress";
import { useMapPacks } from "@/services/offline-map/map-packs";

type Item = { icon: IconName; label: string; sub: string; subColor?: string; href: Href };

export default function MoreScreen() {
  const { t, language } = useT();
  const palette = usePalette();
  const dark = useColorScheme() === "dark";
  const { installed } = useMapPacks();
  const nav = useNavStatus();
  const rec = useRecorderSnapshot();
  const lessonsDone = useLessonsDone();
  // A region holds everything offline: the map, the road graph and the search index.
  const ready = installed.active != null;
  const logBytes = rec.trips.reduce((sum, trip) => sum + (trip.id === rec.current?.id ? (rec.current?.bytes ?? 0) : trip.bytes), 0);

  const items: Item[] = [
    {
      icon: "menu_book",
      label: t("guideTitle"),
      sub: t("guideProgress")
        .replace("{done}", String(AVAILABLE_LESSONS.filter((lesson) => lessonsDone.has(lesson.id)).length))
        .replace("{total}", String(AVAILABLE_LESSONS.length)),
      href: "/guide?from=more",
    },
    {
      icon: "map",
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
  const diagnostics: Item[] = [
    {
      icon: "my_location",
      label: t("position"),
      sub: `${nav.label} · ${nav.source}`,
      subColor: nav.color.c,
      href: "/position?from=more",
    },
    {
      icon: "radio_button_checked",
      label: t("tripRecorder"),
      sub:
        rec.state === "recording"
          ? t("recording")
          : t("tripLogsSummary").replace("{n}", String(rec.trips.length)).replace("{size}", fmtBytes(logBytes)),
      subColor: rec.state === "recording" ? palette.bad.c : undefined,
      href: "/recorder?from=more",
    },
    {
      icon: "tune",
      label: t("developer"),
      sub: t("developerSub"),
      href: "/developer?from=more",
    },
  ];

  const row = (item: Item) => (
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
  );

  return (
    <ScreenContent title={t("more")}>
      <ScreenSection>{items.map(row)}</ScreenSection>
      <ScreenSection>{diagnostics.map(row)}</ScreenSection>
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
