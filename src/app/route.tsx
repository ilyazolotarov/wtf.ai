import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";

import {
    ScreenAction,
    ScreenCard,
    ScreenContent,
    ScreenLink,
    ScreenNote,
    ScreenSection,
} from "@/components/screens/screen-ui";
import {
    cardinal,
    formatDistance,
    formatEta,
    toDegrees,
} from "@/components/status/format-geo";
import { formatDurationS, PROBLEM_TEXT } from "@/components/route/guidance-text";
import { resultDetail, resultTitle } from "@/components/route/search-text";
import { Icon } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { Font, Radius, usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { bearingRad, haversineM, type Coordinate } from "@/nav/geo";
import type { SearchResult } from "@/nav/search/search-index";
import { usePosition } from "@/providers/position-provider";
import { destinations, useRoute } from "@/providers/route-provider";
import { useMapPacks } from "@/services/offline-map/map-packs";
import { activeSearchIndex } from "@/services/offline-map/search-file";

const KYIV = { lat: 50.4501, lon: 30.5234 };
/** Search after typing pauses this long (ms). */
const SEARCH_DELAY_MS = 120;

/** A list entry: a city from the built-in list or a search result. */
interface Pick extends Coordinate {
  id: string;
  title: string;
  detail: string | null;
}

/** Offline search of the active region as the query changes; null when the region has no index. */
function useAddressSearch(query: string, near: Coordinate | null): SearchResult[] | null {
  useMapPacks(); // re-render when a region (and its index) is installed or switched
  const index = activeSearchIndex();
  // Results with the query they answer: stale ones (typing went on) aren't shown.
  const [found, setFound] = useState<{ query: string; results: SearchResult[] }>({ query: "", results: [] });
  const nearRef = useRef(near);
  useEffect(() => {
    nearRef.current = near;
  }, [near]);
  useEffect(() => {
    if (!index || !query.trim()) return;
    const timer = setTimeout(() => {
      let results: SearchResult[] = [];
      try {
        results = index.search(query, { near: nearRef.current, limit: 25 });
      } catch (e) {
        console.warn(`search: ${e instanceof Error ? e.message : String(e)}`);
      }
      setFound({ query, results });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [index, query]);
  if (!index) return null;
  return found.query === query ? found.results : [];
}

export default function RouteScreen() {
  const { t, language } = useT();
  const palette = usePalette();
  const position = usePosition();
  const { route, startRoute, stopRoute } = useRoute();
  const routeId = route?.destination.id ?? null;
  const [selected, setSelected] = useState<Pick | null>(() => {
    const d = route?.destination;
    if (!d?.id) return null;
    const city = destinations.find(({ id }) => id === d.id);
    return { id: d.id, title: city ? city.name[language] : (d.name ?? ""), detail: null, lat: d.lat, lon: d.lon };
  });
  const [query, setQuery] = useState("");
  const origin = position ?? KYIV;
  const searched = useAddressSearch(query, position);
  const summary = (d: Coordinate) => {
    const distanceM = haversineM(origin, d);
    const bearing = toDegrees(bearingRad(origin, d));
    return { distanceM, bearing };
  };
  const q = query.trim().toLocaleLowerCase();
  // With the region's index: what it finds (the city list while the field is empty).
  const picks: Pick[] =
    searched && q
      ? searched.map((r) => ({
          id: `search:${r.key}`,
          title: resultTitle(r, language),
          detail: resultDetail(r, language, t),
          lat: r.lat,
          lon: r.lon,
        }))
      : destinations
          .filter(({ name }) => `${name.en} ${name.uk}`.toLocaleLowerCase().includes(q))
          .map((d) => ({ id: d.id, title: d.name[language], detail: null, lat: d.lat, lon: d.lon }));

  return (
    <ScreenContent title={t("route")}>
      <View style={[styles.search, { backgroundColor: palette.surface }]}>
        <Icon name="search" size={18} color={palette.text2} />
        <TextInput
          value={query}
          onChangeText={(text) => {
            setQuery(text);
            setSelected(null);
          }}
          placeholder={t(searched ? "searchPlaces" : "routeSearch")}
          placeholderTextColor={palette.text2}
          autoCorrect={false}
          returnKeyType="search"
          style={[styles.searchInput, { color: palette.text }]}
        />
      </View>

      {!selected && (
        <ScreenSection>
          {picks.length === 0 ? (
            <View style={styles.empty}>
              <T size={14} color={palette.text2}>
                {t(searched && q ? "noSearchResults" : "noDestinations")}
              </T>
            </View>
          ) : (
            picks.map((d) => {
              const { distanceM, bearing } = summary(d);
              const where = `${formatDistance(distanceM, language)} · ${cardinal(bearing, language)}`;
              return (
                <Pressable
                  key={d.id}
                  onPress={() => setSelected(d)}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.destination, pressed && styles.pressed]}
                >
                  <View style={styles.destinationCopy}>
                    <T w="semibold" size={16} numberOfLines={2}>
                      {d.title}
                    </T>
                    <T size={12} color={palette.text2} numberOfLines={1}>
                      {d.detail ? `${d.detail} · ${where}` : where}
                    </T>
                  </View>
                  {routeId === d.id && (
                    <View style={[styles.badge, { backgroundColor: palette.accentA }]}>
                      <T w="semibold" size={11} color={palette.accent}>
                        {t("activeRoute")}
                      </T>
                    </View>
                  )}
                  <Icon name="chevron_right" size={14} color={palette.text2} />
                </Pressable>
              );
            })
          )}
        </ScreenSection>
      )}

      {selected && (
        <ScreenCard style={styles.selected}>
          <View style={styles.selectedHead}>
            <T w="semibold" size={28} style={styles.selectedName}>
              {selected.title}
            </T>
            {selected.detail && (
              <T size={14} color={palette.text2}>
                {selected.detail}
              </T>
            )}
          </View>
          {!position && <ScreenNote>{t("currentPositionUnknown")}</ScreenNote>}
          {routeId === selected.id && route?.plan ? (
            // The planned route: its road distance and time.
            <View style={styles.metrics}>
              <Metric label={t("distance")} value={formatDistance(route.plan.lengthM, language)} />
              <Metric label={t("eta")} value={formatDurationS(route.plan.durationS, t)} />
            </View>
          ) : (
            <View style={styles.metrics}>
              <Metric label={t("distance")} value={formatDistance(summary(selected).distanceM, language)} />
              <Metric
                label={t("bearing")}
                value={`${Math.round(summary(selected).bearing)}° ${cardinal(summary(selected).bearing, language)}`}
              />
              <Metric label={t("etaStraight")} value={formatEta(summary(selected).distanceM, language)} />
            </View>
          )}
          {routeId === selected.id && route?.status === "planning" && <ScreenNote>{t("planningRoute")}</ScreenNote>}
          {routeId === selected.id && route?.status === "failed" && (
            <ScreenNote>{t(route.failure ? PROBLEM_TEXT[route.failure] : "routeCancelled")}</ScreenNote>
          )}
          {routeId === selected.id && route?.status !== "failed" ? (
            <ScreenAction labelKey="stopGuidance" secondary onPress={stopRoute} />
          ) : (
            <ScreenAction
              labelKey="startGuidance"
              icon="navigation"
              onPress={() => {
                startRoute({ lat: selected.lat, lon: selected.lon, name: selected.title, id: selected.id });
                router.back();
              }}
            />
          )}
          <ScreenLink label={t("chooseAnotherCity")} onPress={() => setSelected(null)} />
        </ScreenCard>
      )}

      {!searched && q !== "" && <ScreenNote>{t("searchNeedsData")}</ScreenNote>}
      <ScreenNote>{`${t("routeTip")} ${t("routeOutsideRegion")}`}</ScreenNote>
    </ScreenContent>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  const palette = usePalette();
  return (
    <View style={styles.metric}>
      <T w="medium" size={12} color={palette.text2}>
        {label}
      </T>
      <T selectable w="semibold" size={17} style={styles.tabular}>
        {value}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  search: {
    height: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    borderRadius: Radius.pill,
  },
  searchInput: { flex: 1, height: 48, fontSize: 16, fontFamily: Font.regular },
  empty: { paddingVertical: 18 },
  destination: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: 12 },
  destinationCopy: { flex: 1, gap: 2 },
  pressed: { opacity: 0.7 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: Radius.pill },
  selected: { gap: 18, paddingTop: 18 },
  selectedHead: { gap: 4 },
  selectedName: { letterSpacing: -0.56 },
  metrics: { flexDirection: "row", gap: 10 },
  metric: { flex: 1, gap: 4 },
  tabular: { fontVariant: ["tabular-nums"] },
});
