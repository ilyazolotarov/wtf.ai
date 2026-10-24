import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, Pressable, StyleSheet, TextInput, View } from "react-native";

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
import { Flash, SaveConfirmation } from "@/components/route/save-feedback";
import { resultDetail, resultTitle } from "@/components/route/search-text";
import { Icon, type IconName } from "@/components/ui/icon";
import { INPUT_MAX_FONT_SCALE, T } from "@/components/ui/text";
import { Font, Radius, usePalette } from "@/constants/theme";
import type { Strings } from "@/i18n/en";
import { useT } from "@/i18n/provider";
import { bearingRad, haversineM, type Coordinate } from "@/nav/geo";
import { orientPoint, parseCoordinates } from "@/nav/search/coordinates";
import type { SearchIndex, SearchResult } from "@/nav/search/search-index";
import { inBounds, places, usePlaces } from "@/providers/places";
import { usePosition } from "@/providers/position-provider";
import { destinations, useRoute } from "@/providers/route-provider";
import { requestPlacing } from "@/services/navigation/place-request";
import type { Place, SavedKind, SavedPlace } from "@/services/navigation/places-store";
import { useMapPacks } from "@/services/offline-map/map-packs";
import { activeSearchIndex } from "@/services/offline-map/search-file";

/** Search after typing pauses this long (ms). */
const SEARCH_DELAY_MS = 120;
const SAVED_ICON: Record<SavedKind, IconName> = { home: "home", work: "work", favorite: "star" };
const SAVED_TITLE: Partial<Record<SavedKind, keyof Strings>> = { home: "placeHome", work: "placeWork" };

const NOTHING_FOUND = { index: null, query: "", results: [] };

/**
 * Offline search of the active region as the query changes; null when the region has no index. `settled`: the
 * results answer the query as typed (not the one before it, still shown meanwhile).
 */
function useAddressSearch(query: string, near: Coordinate | null): { results: SearchResult[]; settled: boolean } | null {
  const index = activeSearchIndex(useMapPacks().installed); // again when a region (and its index) is installed or switched
  // The last results stay while the next query waits for its turn (no blank list on every keystroke); an emptied
  // field or another region's index drops them, so a new search doesn't open on the old one's rows.
  const [found, setFound] = useState<{ index: SearchIndex | null; query: string; results: SearchResult[] }>(NOTHING_FOUND);
  const dropped = found !== NOTHING_FOUND && (!query.trim() || found.index !== index);
  if (dropped) setFound(NOTHING_FOUND);
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
      setFound({ index, query, results });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [index, query]);
  if (!index) return null;
  return { results: dropped ? [] : found.results, settled: !dropped && found.query === query };
}

/**
 * Coordinates typed or pasted (SEARCH-SPEC §5): the place at that point, named by the house there (within 75 m, as a
 * dropped pin), else "Selected location" in its settlement; the coordinates follow. The route goes to the exact point.
 */
function pointPlace(
  text: string,
  index: SearchIndex | null,
  bounds: [number, number, number, number] | null,
  language: "en" | "uk",
  t: (key: keyof Strings) => string,
): Place | null {
  const typed = parseCoordinates(text);
  if (!typed) return null;
  const at = orientPoint(typed, (c) => inBounds(bounds, c));
  let named: { title: string; detail: string | null } | null = null;
  try {
    const town = index?.settlementAt(at) ?? null;
    const house = index?.nearestAddress(at) ?? null;
    // A house's detail is its settlement; one addressed by its quarter or village names none of its own.
    const detail = house && (house.settlement || !town ? resultDetail(house, language, t) : resultTitle(town, language, t));
    named = house
      ? { title: resultTitle(house, language, t), detail }
      : { title: t("selectedLocation"), detail: town ? resultTitle(town, language, t) : null };
  } catch (e) {
    console.warn(`point name: ${e instanceof Error ? e.message : String(e)}`);
  }
  const coordinates = `${at.lat.toFixed(5)}, ${at.lon.toFixed(5)}`;
  return {
    id: `point:${at.lat.toFixed(6)},${at.lon.toFixed(6)}`,
    title: named?.title ?? t("selectedLocation"),
    detail: named?.detail ? `${named.detail} · ${coordinates}` : coordinates,
    lat: at.lat,
    lon: at.lon,
  };
}

/** The active region's cities and towns from its search index; null without one (older releases). */
function useMajorSettlements(region: string | null): Place[] | null {
  const { language, t } = useT();
  const index = activeSearchIndex();
  return useMemo(() => {
    if (!index) return null;
    try {
      return index.majorSettlements(8).map((r) => ({
        id: `search:${r.key}`,
        title: resultTitle(r, language, t),
        detail: resultDetail(r, language, t),
        lat: r.lat,
        lon: r.lon,
      }));
    } catch (e) {
      console.warn(`major settlements: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
    // `region` re-reads when the active region changes (the index is cached per file).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, region, language]);
}

export default function RouteScreen() {
  const { t, language } = useT();
  const palette = usePalette();
  const position = usePosition();
  const { route, startRoute, stopRoute } = useRoute();
  const { installed } = useMapPacks();
  const { saved, recent } = usePlaces();
  const routeId = route?.destination.id ?? null;
  const region = installed.active ? installed.regions[installed.active] : null;
  const bounds = region?.bounds ?? null;
  const [selected, setSelected] = useState<Place | null>(() => {
    const d = route?.destination;
    return d?.id ? { id: d.id, title: d.name ?? "", detail: null, lat: d.lat, lon: d.lon } : null;
  });
  const [query, setQuery] = useState("");
  // "I'm here": the car is at the place, not going there (NAVIGATOR-SPEC §6.2); the map puts it there, at any speed.
  // Distances from the car; without a fix, from the region's middle.
  const origin: Coordinate =
    position ?? (bounds ? { lat: (bounds[1] + bounds[3]) / 2, lon: (bounds[0] + bounds[2]) / 2 } : { lat: 50.45, lon: 30.52 });
  // Coordinates are a place of their own, not words to search.
  const index = activeSearchIndex(installed);
  const point = useMemo(() => pointPlace(query, index, bounds, language, t), [query, index, bounds, language, t]);
  const searched = useAddressSearch(point ? "" : query, position);
  const majors = useMajorSettlements(installed.active);
  const summary = (d: Coordinate) => {
    const distanceM = haversineM(origin, d);
    const bearing = toDegrees(bearingRad(origin, d));
    return { distanceM, bearing };
  };
  const q = query.trim().toLocaleLowerCase();
  // Only what a route can reach: places inside the active region.
  const reachable = <P extends Coordinate>(list: P[]) => list.filter((p) => inBounds(bounds, p));
  // The region's cities: from its search index, else the built-in list inside its bounds.
  const cities: Place[] =
    majors ??
    reachable(destinations).map((d) => ({ id: d.id, title: d.name[language], detail: null, lat: d.lat, lon: d.lon }));
  const results: Place[] | null = !q
    ? null
    : point
      ? [point]
      : searched
        ? searched.results.map((r) => ({
            id: `search:${r.key}`,
            title: resultTitle(r, language, t),
            detail: resultDetail(r, language, t),
            lat: r.lat,
            lon: r.lon,
            ...(r.entrances.length > 0 ? { entrances: r.entrances.map((e) => ({ ref: e.ref!, lat: e.lat, lon: e.lon })) } : {}),
          }))
        : cities.filter((c) => c.title.toLocaleLowerCase().includes(q));
  const savedHere = reachable(saved);
  const recentHere = reachable(recent);
  const selectedSaved = selected ? places.savedAt(selected) : null;
  // What the last save or removal on the card did, with what Undo puts back.
  const [feedback, setFeedback] = useState<{ placeId: string; kind: SavedKind | null; replaced: string | null; undo: SavedPlace[] } | null>(null);
  // The saved row that glows once when the list comes back.
  const [flashId, setFlashId] = useState<string | null>(null);
  // The entrance picked on the card (its number); null: the building itself.
  const [door, setDoor] = useState<string | null>(null);
  const select = (d: Place | null) => {
    setSelected(d);
    setDoor(null);
    setFeedback(null);
    // A place picked: its card in full, not under the keyboard.
    if (d) Keyboard.dismiss();
  };
  // Where the card routes: the building, or the entrance picked ("…, 16-Б, під'їзд 2" at its door).
  const doorAt = door ? selected?.entrances?.find((e) => e.ref === door) : undefined;
  const target: Place | null =
    selected && doorAt
      ? {
          id: `${selected.id}:e${doorAt.ref}`,
          title: `${selected.title}, ${t("searchEntrance").replace("{n}", doorAt.ref)}`,
          detail: selected.detail,
          lat: doorAt.lat,
          lon: doorAt.lon,
        }
      : selected;
  const save = (place: Place, kind: SavedKind) => {
    const before = places.getSnapshot().saved;
    const was = places.savedAt(place);
    const replaced = kind === "favorite" ? null : (before.find((s) => s.kind === kind && s !== was)?.title ?? null);
    places.save(place, kind);
    setFeedback({ placeId: place.id, kind, replaced, undo: before });
    setFlashId(place.id);
  };
  const unsave = (place: Place) => {
    const before = places.getSnapshot().saved;
    places.unsave(place);
    setFeedback({ placeId: place.id, kind: null, replaced: null, undo: before });
    setFlashId(null);
  };
  const undo = () => {
    if (feedback) places.restoreSaved(feedback.undo);
    setFeedback(null);
    setFlashId(null);
  };

  const row = (
    d: Place,
    key: string,
    options: { icon?: IconName; title?: string; detail?: string | null; flash?: boolean } = {},
  ) => {
    const { distanceM, bearing } = summary(d);
    // Elsewhere than the Saved section, a saved place shows its kind's icon at the end.
    const savedKind = options.icon ? null : (places.savedAt(d)?.kind ?? null);
    const where = `${formatDistance(distanceM, language)} · ${cardinal(bearing, language)}`;
    const detail = options.detail === undefined ? d.detail : options.detail;
    return (
      <Pressable
        key={key}
        onPress={() => select(d)}
        accessibilityRole="button"
        style={({ pressed }) => [styles.destination, pressed && styles.pressed]}
      >
        {options.flash && <Flash onDone={() => setFlashId(null)} />}
        {options.icon && (
          <View style={[styles.rowIcon, { backgroundColor: palette.accentA }]}>
            <Icon name={options.icon} size={15} color={palette.accent} />
          </View>
        )}
        <View style={styles.destinationCopy}>
          <T w="semibold" size={16} numberOfLines={2}>
            {options.title ?? d.title}
          </T>
          <T size={12} color={palette.text2} fit>
            {detail ? `${detail} · ${where}` : where}
          </T>
        </View>
        {routeId === d.id && (
          <View style={[styles.badge, { backgroundColor: palette.accentA }]}>
            <T w="semibold" size={11} color={palette.accent}>
              {t("activeRoute")}
            </T>
          </View>
        )}
        {savedKind && (
          <Icon name={SAVED_ICON[savedKind]} size={14} color={palette.accent} />
        )}
        <Icon name="chevron_right" size={14} color={palette.text2} />
      </Pressable>
    );
  };

  return (
    <ScreenContent title={t("route")}>
      <View style={[styles.search, { backgroundColor: palette.surface }]}>
        <Icon name="search" size={18} color={palette.text2} />
        <TextInput
          value={query}
          onChangeText={(text) => {
            setQuery(text);
            // Coordinates pasted (not typed a digit at a time): straight to their card.
            select(text.length - query.length > 1 ? pointPlace(text, index, bounds, language, t) : null);
          }}
          onSubmitEditing={() => point && select(point)}
          placeholder={t(searched ? "searchPlaces" : "routeSearch")}
          placeholderTextColor={palette.text2}
          autoCorrect={false}
          returnKeyType="search"
          maxFontSizeMultiplier={INPUT_MAX_FONT_SCALE}
          style={[styles.searchInput, { color: palette.text }]}
        />
      </View>

      {!selected && results && (
        <ScreenSection>
          {results.length > 0 ? (
            results.map((d) => row(d, d.id))
          ) : !searched || searched.settled ? (
            <View style={styles.empty}>
              <T size={14} color={palette.text2}>
                {t(searched ? "noSearchResults" : "noDestinations")}
              </T>
            </View>
          ) : null /* the first results still to come: nothing rather than "No results" */}
        </ScreenSection>
      )}

      {!selected && !results && (
        <>
          {savedHere.length > 0 && (
            <ScreenSection title={t("savedPlaces")}>
              {savedHere.map((p) => {
                const title = SAVED_TITLE[p.kind];
                return row(p, `saved:${p.id}`, {
                  icon: SAVED_ICON[p.kind],
                  flash: flashId === p.id,
                  ...(title ? { title: t(title), detail: p.title } : {}),
                });
              })}
            </ScreenSection>
          )}
          {recentHere.length > 0 && (
            <ScreenSection title={t("recentPlaces")}>
              {recentHere.map((p) => row(p, `recent:${p.id}`, { icon: "history" }))}
            </ScreenSection>
          )}
          {recentHere.length > 0 && <ScreenLink label={t("clearRecent")} onPress={() => places.clearRecent()} />}
          <ScreenSection title={region ? `${t("regionCities")} · ${region.name[language]}` : t("regionCities")}>
            {cities.length === 0 ? (
              <View style={styles.empty}>
                <T size={14} color={palette.text2}>
                  {t("noDestinations")}
                </T>
              </View>
            ) : (
              cities.map((d) => row(d, `city:${d.id}`))
            )}
          </ScreenSection>
        </>
      )}

      {selected && target && (
        <ScreenCard style={styles.selected}>
          <View style={styles.selectedHead}>
            <T w="semibold" size={28} style={styles.selectedName}>
              {target.title}
            </T>
            {selected.detail && (
              <T size={14} color={palette.text2}>
                {selected.detail}
              </T>
            )}
          </View>
          {selected.entrances && selected.entrances.length > 0 && (
            // The house's numbered entrances: the route ends at the one picked.
            <View style={styles.doors}>
              <T size={13} color={palette.text2}>
                {t("entrances")}
              </T>
              <View style={styles.doorRow}>
                {[null, ...selected.entrances.map((e) => e.ref)].map((ref) => {
                  const on = door === ref;
                  return (
                    <Pressable
                      key={ref ?? "building"}
                      onPress={() => setDoor(ref)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={ref ? t("searchEntrance").replace("{n}", ref) : t("entranceBuilding")}
                      style={({ pressed }) => [
                        styles.door,
                        { backgroundColor: on ? palette.accent : palette.surface },
                        pressed && styles.pressed,
                      ]}
                    >
                      <T w="semibold" size={15} color={on ? palette.onAccent : palette.text} style={styles.tabular}>
                        {ref ?? t("entranceBuilding")}
                      </T>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          )}
          {!position && <ScreenNote>{t("currentPositionUnknown")}</ScreenNote>}
          {routeId === target.id && route?.plan ? (
            // The planned route: its road distance and time.
            <View style={styles.metrics}>
              <Metric label={t("distance")} value={formatDistance(route.plan.lengthM, language)} />
              <Metric label={t("eta")} value={formatDurationS(route.plan.durationS, t)} />
            </View>
          ) : (
            <View style={styles.metrics}>
              <Metric label={t("distance")} value={formatDistance(summary(target).distanceM, language)} />
              <Metric
                label={t("bearing")}
                value={`${Math.round(summary(target).bearing)}° ${cardinal(summary(target).bearing, language)}`}
              />
              <Metric label={t("etaStraight")} value={formatEta(summary(target).distanceM, language)} />
            </View>
          )}
          {routeId === target.id && route?.status === "planning" && <ScreenNote>{t("planningRoute")}</ScreenNote>}
          {routeId === target.id && route?.status === "failed" && (
            <ScreenNote>{t(route.failure ? PROBLEM_TEXT[route.failure] : "routeCancelled")}</ScreenNote>
          )}
          {routeId === target.id && route?.status !== "failed" ? (
            <ScreenAction labelKey="stopGuidance" secondary onPress={stopRoute} />
          ) : (
            <ScreenAction
              labelKey="startGuidance"
              icon="navigation"
              onPress={() => {
                places.addRecent(target);
                startRoute({ lat: target.lat, lon: target.lon, name: target.title, id: target.id });
                router.back();
              }}
            />
          )}
          <ScreenAction
            labelKey="placeMeHere"
            icon="location_on"
            secondary
            onPress={() => {
              requestPlacing(target);
              router.back();
            }}
          />
          {feedback?.placeId === selected.id && (
            <SaveConfirmation
              key={`${feedback.kind}:${feedback.undo.length}`}
              kind={feedback.kind}
              replaced={feedback.replaced}
              onUndo={undo}
            />
          )}
          {selectedSaved ? (
            <View style={styles.saveRow}>
              <Icon name={SAVED_ICON[selectedSaved.kind]} size={16} color={palette.accent} />
              <T size={14} color={palette.text2} style={styles.flex}>
                {t(selectedSaved.kind === "home" ? "savedAsHome" : selectedSaved.kind === "work" ? "savedAsWork" : "savedPlace")}
              </T>
              <ScreenLink label={t("removeSaved")} onPress={() => unsave(selected)} />
            </View>
          ) : (
            <View style={styles.saveRow}>
              <ScreenAction labelKey="placeHome" icon="home" compact secondary onPress={() => save(selected, "home")} />
              <ScreenAction labelKey="placeWork" icon="work" compact secondary onPress={() => save(selected, "work")} />
              <ScreenAction labelKey="savePlace" icon="star_border" compact secondary onPress={() => save(selected, "favorite")} />
            </View>
          )}
          <ScreenLink label={t("chooseAnotherCity")} onPress={() => select(null)} />
        </ScreenCard>
      )}

      {!searched && q !== "" && !point && <ScreenNote>{t("searchNeedsData")}</ScreenNote>}
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
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    borderRadius: Radius.pill,
  },
  searchInput: { flex: 1, minHeight: 48, paddingVertical: 8, fontSize: 16, fontFamily: Font.regular },
  empty: { paddingVertical: 18 },
  destination: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: 12 },
  destinationCopy: { flex: 1, gap: 2 },
  pressed: { opacity: 0.7 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: Radius.pill },
  selected: { gap: 18, paddingTop: 18 },
  selectedHead: { gap: 4 },
  doors: { gap: 8 },
  doorRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  door: { minWidth: 48, minHeight: 44, paddingHorizontal: 14, borderRadius: Radius.pill, alignItems: "center", justifyContent: "center" },
  saveRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  flex: { flex: 1 },
  rowIcon: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  selectedName: { letterSpacing: -0.56 },
  metrics: { flexDirection: "row", gap: 10 },
  metric: { flex: 1, gap: 4 },
  tabular: { fontVariant: ["tabular-nums"] },
});
