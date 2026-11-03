import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { ScreenContent, ScreenLink, ScreenNote, ScreenSection } from "@/components/screens/screen-ui";
import { formatDistance } from "@/components/status/format-geo";
import { resultTitle } from "@/components/route/search-text";
import { CATEGORY_COLOR, CATEGORY_ICON, CATEGORY_LABEL, detourText, placeDetail, placeName, STOP_CATEGORIES } from "@/components/route/stop-text";
import { addStopWithUndo, offerRouteUndo } from "@/components/route/trip-undo";
import { Icon } from "@/components/ui/icon";
import { PressableFeedback } from "@/components/ui/press-feedback";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { detourMinutes } from "@/nav/routing/detour";
import type { PlaceCategory } from "@/nav/search/search-index";
import { usePosition } from "@/providers/position-provider";
import { useRoute } from "@/providers/route-provider";
import type { AlongItem } from "@/services/navigation/route-service";
import { activeSearchIndex } from "@/services/offline-map/search-file";
import { getRuntime } from "@/services/runtime";

/**
 * Places to pull in at along the route ahead (STOPS-SPEC §7.2): a kind at a time, in order along the route, each with
 * its side, what the map knows of it, how far and its detour. A row is added as a stop at once (Undo on the map), and
 * the page goes back to the trip. Parking is where the driver is going instead (§6.5): near the destination, then near
 * each stop, with the walk; a row makes it where the car goes in that one's place.
 */
export default function AlongScreen() {
  const { t, language } = useT();
  const palette = usePalette();
  // Open or closed now: the clock of the last position (a render reads no clock of its own).
  const nowMs = usePosition()?.timestamp ?? 0;
  const { route } = useRoute();
  // `back`: the pages to go back after a pick to reach the trip (2 from the stop search, pushed over it).
  const params = useLocalSearchParams<{ category?: string; back?: string }>();
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
  const parking = category === "parking";
  // A place without a name (most parking) by the address nearest to it, so the rows can be told apart.
  const titles = useMemo(() => {
    const index = activeSearchIndex();
    return new Map(
      (along?.items ?? []).map((item) => {
        let title = item.place.name;
        if (!title) {
          try {
            const house = index?.nearestAddress(item.place, 150) ?? null;
            title = house ? resultTitle(house, language, t) : null;
          } catch (e) {
            console.warn(`place address: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        return [item.place.key, title] as const;
      }),
    );
  }, [along?.items, language, t]);
  const titleOf = (item: AlongItem) => titles.get(item.place.key) ?? placeName(item.place, t);
  const forName = (key: string) =>
    key === "destination" ? route?.destination.name : route?.stops.find((x) => x.key === key)?.name;

  const pick = (item: AlongItem) => {
    const stop = {
      lat: item.place.lat,
      lon: item.place.lon,
      name: titleOf(item),
      id: `place:${item.place.key}`,
      category: item.place.category,
      flags: item.place.flags,
      hours: item.place.hours,
    };
    if (item.parkFor) {
      // Named for what it is for ("Parking near Хрещатик, 22"), everywhere the trip shows it; its own name under it.
      const parking = { ...stop, name: t("parkingNearName").replace("{name}", forName(item.parkFor) ?? t("droppedPin")), detail: stop.name };
      offerRouteUndo(routes, route, parking.name);
      routes.parkAt(parking, item.parkFor);
    } else addStopWithUndo(routes, stop);
    router.dismiss(Math.max(1, Number(params.back) || 1));
  };

  const row = (item: AlongItem) => {
    const detail = placeDetail(item.place, item.side, t, nowMs);
    const onTheWay = item.detourS !== undefined && detourMinutes(item.detourS) === 0;
    return (
      <PressableFeedback
        key={item.place.key}
        onPress={() => pick(item)}
        accessibilityRole="button"
        look="row"
        style={styles.row}
      >
        <View style={[styles.icon, { backgroundColor: CATEGORY_COLOR[item.place.category] }]}>
          <Icon name={CATEGORY_ICON[item.place.category]} size={18} color="#FFFFFF" />
        </View>
        <View style={styles.copy}>
          <T w="medium" size={16} numberOfLines={2}>
            {titleOf(item)}
          </T>
          {detail ? (
            <T size={13} color={palette.text2} fit>
              {detail}
            </T>
          ) : null}
        </View>
        {item.walkM !== undefined ? (
          // Parking: the walk from it to where the driver is going.
          <View style={styles.right}>
            <T w="semibold" size={15} style={styles.tabular}>
              {formatDistance(item.walkM, language)}
            </T>
            <T w="medium" size={13} color={palette.text2}>
              {t("parkingWalk")}
            </T>
          </View>
        ) : (
          <View style={styles.right}>
            <T w="semibold" size={15} style={styles.tabular}>
              {formatDistance(Math.max(0, item.alongM - carM), language)}
            </T>
            <T w="medium" size={13} color={onTheWay ? palette.ok.c : palette.text2} style={styles.tabular}>
              {detourText(item.detourS, t)}
            </T>
          </View>
        )}
      </PressableFeedback>
    );
  };

  return (
    <ScreenContent title={t("alongTitle")}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {STOP_CATEGORIES.map((c) => {
          const on = c === category;
          return (
            <PressableFeedback
              key={c}
              onPress={() => router.setParams({ category: c })}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              // Each kind in its colour (the Route page's tiles, the map's icons): its icon, and the chip filled when on.
              style={[styles.chip, { backgroundColor: on ? CATEGORY_COLOR[c] : palette.groupBg }]}
            >
              <Icon name={CATEGORY_ICON[c]} size={18} color={on ? "#FFFFFF" : CATEGORY_COLOR[c]} />
              <T w="medium" size={15} color={on ? "#FFFFFF" : palette.text}>
                {t(CATEGORY_LABEL[c])}
              </T>
            </PressableFeedback>
          );
        })}
      </ScrollView>

      {!routeOn || along?.status === "no-route" ? (
        <ScreenNote>{t("alongNoRoute")}</ScreenNote>
      ) : along?.status === "no-places" ? (
        <ScreenNote>{t("alongNoPlaces")}</ScreenNote>
      ) : along && along.items.length === 0 && along.status === "done" ? (
        <ScreenNote>{t(parking ? "parkingNone" : "alongNone")}</ScreenNote>
      ) : parking ? (
        <>
          <ScreenNote>{t("parkingNote")}</ScreenNote>
          {/* Grouped by where each is for: the destination first, then the stops in order. */}
          {[...new Set((along?.items ?? []).map((item) => item.parkFor!))].map((key) => (
            <ScreenSection key={key} title={t("parkingFor").replace("{name}", forName(key) ?? t("droppedPin"))}>
              {along!.items.filter((item) => item.parkFor === key).map((item) => row(item))}
            </ScreenSection>
          ))}
        </>
      ) : (
        <ScreenSection>{(along?.items ?? []).map((item) => row(item))}</ScreenSection>
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
  tabular: { fontVariant: ["tabular-nums"] },
});
