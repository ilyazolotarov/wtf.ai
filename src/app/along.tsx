import { router, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { ScreenContent, ScreenLink, ScreenNote, ScreenSection } from "@/components/screens/screen-ui";
import { formatDistance } from "@/components/status/format-geo";
import { CATEGORY_ICON, CATEGORY_LABEL, detourText, placeDetail, placeName, STOP_CATEGORIES } from "@/components/route/stop-text";
import { Icon } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { detourMinutes } from "@/nav/routing/detour";
import type { PlaceCategory } from "@/nav/search/search-index";
import { useRoute } from "@/providers/route-provider";
import type { AlongItem } from "@/services/navigation/route-service";
import { getRuntime } from "@/services/runtime";

/**
 * Places to pull in at along the route ahead (STOPS-SPEC §7.2): a kind at a time, in order along the route, each with
 * its side, what the map knows of it, how far and its detour. A row shows it on the map as a stop to add.
 */
export default function AlongScreen() {
  const { t, language } = useT();
  const palette = usePalette();
  const { route } = useRoute();
  const params = useLocalSearchParams<{ category?: string }>();
  const routes = getRuntime().routes;
  const category: PlaceCategory = STOP_CATEGORIES.includes(params.category as PlaceCategory) ? (params.category as PlaceCategory) : "fuel";
  const along = route?.along?.category === category ? route.along : null;
  const routeOn = route?.status === "active";

  // Searched when the kind changes or the route comes; the list goes with the page.
  useEffect(() => {
    if (routeOn) getRuntime().routes.findAlong(category);
  }, [category, routeOn]);
  useEffect(() => () => getRuntime().routes.closeAlong(), []);

  const carM = route?.guidance?.alongM ?? 0;
  const show = (item: AlongItem) => {
    routes.previewStop({
      lat: item.place.lat,
      lon: item.place.lon,
      name: placeName(item.place, t),
      id: `place:${item.place.key}`,
      category: item.place.category,
      flags: item.place.flags,
    });
    router.dismissAll();
  };

  return (
    <ScreenContent title={t("alongTitle")}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {STOP_CATEGORIES.map((c) => {
          const on = c === category;
          return (
            <Pressable
              key={c}
              onPress={() => router.setParams({ category: c })}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              style={({ pressed }) => [styles.chip, { backgroundColor: on ? palette.accent : palette.groupBg }, pressed && styles.pressed]}
            >
              <Icon name={CATEGORY_ICON[c]} size={18} color={on ? palette.onAccent : palette.accent} />
              <T w="medium" size={15} color={on ? palette.onAccent : palette.text}>
                {t(CATEGORY_LABEL[c])}
              </T>
            </Pressable>
          );
        })}
      </ScrollView>

      {!routeOn || along?.status === "no-route" ? (
        <ScreenNote>{t("alongNoRoute")}</ScreenNote>
      ) : along?.status === "no-places" ? (
        <ScreenNote>{t("alongNoPlaces")}</ScreenNote>
      ) : along && along.items.length === 0 && along.status === "done" ? (
        <ScreenNote>{t("alongNone")}</ScreenNote>
      ) : (
        <ScreenSection>
          {(along?.items ?? []).map((item) => {
            const detail = placeDetail(item.place, item.side, t);
            const onTheWay = item.detourS !== undefined && detourMinutes(item.detourS) === 0;
            return (
              <Pressable
                key={item.place.key}
                onPress={() => show(item)}
                accessibilityRole="button"
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              >
                <View style={[styles.icon, { backgroundColor: palette.accentA }]}>
                  <Icon name={CATEGORY_ICON[item.place.category]} size={18} color={palette.accent} />
                </View>
                <View style={styles.copy}>
                  <T w="semibold" size={16} numberOfLines={2}>
                    {placeName(item.place, t)}
                  </T>
                  {detail ? (
                    <T size={13} color={palette.text2} fit>
                      {detail}
                    </T>
                  ) : null}
                </View>
                <View style={styles.right}>
                  <T w="semibold" size={15} style={styles.tabular}>
                    {formatDistance(Math.max(0, item.alongM - carM), language)}
                  </T>
                  <T w="medium" size={13} color={onTheWay ? palette.ok.c : palette.text2} style={styles.tabular}>
                    {detourText(item.detourS, t)}
                  </T>
                </View>
              </Pressable>
            );
          })}
        </ScreenSection>
      )}
      {along?.more && along.status === "done" && <ScreenLink label={t("alongMore")} onPress={() => routes.findAlong(category, true)} />}
    </ScreenContent>
  );
}

const styles = StyleSheet.create({
  chips: { gap: 8, paddingVertical: 2 },
  chip: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 10, paddingRight: 14, borderRadius: Radius.pill },
  row: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: 12 },
  icon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  copy: { flex: 1, gap: 2 },
  right: { alignItems: "flex-end", gap: 2 },
  pressed: { opacity: 0.7 },
  tabular: { fontVariant: ["tabular-nums"] },
});
