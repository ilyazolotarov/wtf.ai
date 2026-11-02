import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Keyboard, Pressable, StyleSheet, TextInput, View } from "react-native";

import { ScreenAction, ScreenCard, ScreenContent, ScreenLink, ScreenNote, ScreenSection } from "@/components/screens/screen-ui";
import { cardinal, formatDistance, toDegrees } from "@/components/status/format-geo";
import { formatArrival, formatDurationS } from "@/components/route/guidance-text";
import { Metric, metricStyles, PlaceCard, SAVED_ICON, takeSavedLast, type PlaceCardExit } from "@/components/route/place-card";
import { CATEGORY_ICON, CATEGORY_LABEL, detourText, STOP_CATEGORIES } from "@/components/route/stop-text";
import { Flash } from "@/components/route/save-feedback";
import { addStopWithUndo, useTripUndo } from "@/components/route/trip-undo";
import { useStopDrag } from "@/components/route/use-stop-drag";
import { pointPlace, resultPlace } from "@/components/route/place-search";
import { Icon, type IconName } from "@/components/ui/icon";
import { INPUT_MAX_FONT_SCALE, T } from "@/components/ui/text";
import { Font, Radius, usePalette } from "@/constants/theme";
import type { Strings } from "@/i18n/en";
import { useT } from "@/i18n/provider";
import { bearingRad, haversineM, type Coordinate } from "@/nav/geo";
import { geoSearchText } from "@/nav/search/geo-uri";
import type { SearchIndex, SearchResult } from "@/nav/search/search-index";
import { inBounds, places, usePlaces } from "@/providers/places";
import { usePosition } from "@/providers/position-provider";
import { destinations, useRoute } from "@/providers/route-provider";
import type { Place, SavedKind } from "@/services/navigation/places-store";
import { useMapPacks } from "@/services/offline-map/map-packs";
import { activeSearchIndex } from "@/services/offline-map/search-file";
import type { RouteSnapshot } from "@/services/navigation/route-service";
import { getRuntime } from "@/services/runtime";

/** Search after typing pauses this long (ms). */
const SEARCH_DELAY_MS = 120;
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

/** The active region's cities and towns from its search index; null without one (older releases). */
function useMajorSettlements(region: string | null): Place[] | null {
  const { language, t } = useT();
  const index = activeSearchIndex();
  return useMemo(() => {
    if (!index) return null;
    try {
      return index.majorSettlements(8).map((r) => resultPlace(r, language, t));
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
  const { route, stopRoute } = useRoute();
  const { installed } = useMapPacks();
  const { saved, recent } = usePlaces();
  const routeId = route?.destination.id ?? null;
  const region = installed.active ? installed.regions[installed.active] : null;
  const bounds = region?.bounds ?? null;
  // A place another app sent (a `geo:` link, +native-intent.tsx): its words or coordinates, searched. `adding`: this
  // page is the stop search (STOPS-SPEC §7.1), pushed over the trip: a result picked becomes a stop, each shown with
  // its detour.
  const { q: linked = "", adding: addingParam } = useLocalSearchParams<{ q?: string; adding?: string }>();
  const adding = addingParam === "1";
  // A stop held by its handle: the page doesn't scroll under it.
  const [dragging, setDragging] = useState(false);
  // A route planned or failed (not followed yet): the page opens on its destination's card, in the page itself (no
  // list under it to go back to). With a route on, the page opens on its trip.
  const [destinationCard, setDestinationCard] = useState<Place | null>(() => {
    const d = route?.destination;
    return !linked && !adding && d?.id && route?.status !== "active" ? { id: d.id, title: d.name ?? "", detail: null, lat: d.lat, lon: d.lon } : null;
  });
  const routes = getRuntime().routes;
  const routeOn = route != null && route.status !== "failed";
  const [query, setQuery] = useState(linked);
  // Another link while the screen is open: searched instead.
  const [shownLink, setShownLink] = useState(linked);
  if (linked !== shownLink) {
    setShownLink(linked);
    if (linked) {
      setQuery(linked);
      setDestinationCard(null);
    }
  }
  // A pasted `geo:` or Apple Maps link reads as its place.
  const text = geoSearchText(query) ?? query;
  // Distances from the car; without a fix, from the region's middle.
  const origin: Coordinate =
    position ?? (bounds ? { lat: (bounds[1] + bounds[3]) / 2, lon: (bounds[0] + bounds[2]) / 2 } : { lat: 50.45, lon: 30.52 });
  // Coordinates are a place of their own, not words to search.
  const index = activeSearchIndex(installed);
  const point = useMemo(() => pointPlace(text, index, bounds, language, t), [text, index, bounds, language, t]);
  const searched = useAddressSearch(point ? "" : text, position);
  const majors = useMajorSettlements(installed.active);
  const q = text.trim().toLocaleLowerCase();
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
        ? searched.results.map((r) => resultPlace(r, language, t))
        : cities.filter((c) => c.title.toLocaleLowerCase().includes(q));
  const savedHere = reachable(saved);
  // Adding a stop: the detours of what is listed (results, else saved places), worked out one by one.
  const estimating = adding && route?.status === "active" ? (results ?? savedHere).slice(0, ESTIMATED) : null;
  const estimateKey = estimating?.map((d) => d.id).join("|") ?? "";
  useEffect(() => {
    if (!estimating?.length) return;
    getRuntime().routes.estimateDetours(estimating.map((d) => ({ key: d.id, lat: d.lat, lon: d.lon })));
    return () => getRuntime().routes.clearEstimates();
    // The list's ids say when it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimateKey]);
  const recentHere = reachable(recent);
  // The saved row that glows once when the list comes back from a card.
  const [flashId, setFlashId] = useState<string | null>(null);

  // Back from a place's card or the stop search after the trip changed (a stop added, a route started): the trip, not
  // the search it was found in. A change while this page is in front (a stop reached) leaves the search alone.
  const tripKey = route ? `${route.destination.lat},${route.destination.lon}|${route.stops.map((s) => s.key).join(",")}` : "";
  const tripKeyNow = useRef(tripKey);
  useEffect(() => {
    tripKeyNow.current = tripKey;
  }, [tripKey]);
  const tripKeyLeft = useRef<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (tripKeyLeft.current !== null && tripKeyLeft.current !== tripKeyNow.current) setQuery("");
      const savedId = takeSavedLast();
      if (savedId) setFlashId(savedId);
      return () => {
        tripKeyLeft.current = tripKeyNow.current;
      };
    }, []),
  );

  const open = (d: Place) => {
    Keyboard.dismiss();
    router.push({ pathname: "/place", params: { place: JSON.stringify(d) } });
  };
  const addStop = (d: Place) => {
    addStopWithUndo(routes, { lat: d.lat, lon: d.lon, name: d.title, id: d.id });
    Keyboard.dismiss();
    // Back to the trip, the stop in it.
    router.back();
  };
  // The destination's own card left: as the card on its page would be.
  const exitDestinationCard = (how: PlaceCardExit) => {
    setDestinationCard(null);
    const savedId = takeSavedLast();
    if (savedId) setFlashId(savedId);
    if (how === "map") router.back();
    else if (how === "adding") router.push({ pathname: "/route", params: { adding: "1" } });
  };

  const row = (
    d: Place,
    key: string,
    options: { icon?: IconName; title?: string; detail?: string | null; flash?: boolean } = {},
  ) => {
    const distanceM = haversineM(origin, d);
    const bearing = toDegrees(bearingRad(origin, d));
    // Elsewhere than the Saved section, a saved place shows its kind's icon at the end.
    const savedKind = options.icon ? null : (places.savedAt(d)?.kind ?? null);
    const estimate = adding ? route?.estimates : undefined;
    const where = estimate
      ? detourText(d.id in estimate ? estimate[d.id] : undefined, t)
      : `${formatDistance(distanceM, language)} · ${cardinal(bearing, language)}`;
    const detail = options.detail === undefined ? d.detail : options.detail;
    return (
      <Pressable
        key={key}
        onPress={() => (adding ? addStop(d) : open(d))}
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
    <ScreenContent title={t(adding ? "addStopTitle" : "route")} scrollEnabled={!dragging}>
      {routeOn && !adding && !destinationCard && !q && (
        <TripSection
          route={route}
          nowMs={position?.timestamp ?? 0}
          onAdd={() => router.push({ pathname: "/route", params: { adding: "1" } })}
          onStop={stopRoute}
          onDragging={setDragging}
        />
      )}
      {/* The stop search opens on the kinds to pull in at, not on an empty list. */}
      {adding && route?.status === "active" && !q && <PullInTiles back={2} />}
      <View style={[styles.search, { backgroundColor: palette.surface }]}>
        <Icon name="search" size={18} color={palette.text2} />
        <TextInput
          value={query}
          onChangeText={(typed) => {
            setQuery(typed);
            setDestinationCard(null);
            // Coordinates pasted (not typed a digit at a time): straight to their card.
            const pasted = typed.length - query.length > 1 ? pointPlace(geoSearchText(typed) ?? typed, index, bounds, language, t) : null;
            if (pasted) (adding ? addStop : open)(pasted);
          }}
          onSubmitEditing={() => point && (adding ? addStop : open)(point)}
          placeholder={t(searched ? "searchPlaces" : "routeSearch")}
          placeholderTextColor={palette.text2}
          autoCorrect={false}
          returnKeyType="search"
          maxFontSizeMultiplier={INPUT_MAX_FONT_SCALE}
          style={[styles.searchInput, { color: palette.text }]}
        />
      </View>

      {!destinationCard && results && (
        <ScreenSection>
          {results.length > 0 ? (
            byDetour(results, adding ? route?.estimates : undefined).map((d) => row(d, d.id))
          ) : !searched || searched.settled ? (
            <View style={styles.empty}>
              <T size={14} color={palette.text2}>
                {t(searched ? "noSearchResults" : "noDestinations")}
              </T>
            </View>
          ) : null /* the first results still to come: nothing rather than "No results" */}
        </ScreenSection>
      )}

      {!destinationCard && !results && (
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
          {!adding && recentHere.length > 0 && (
            <ScreenSection title={t("recentPlaces")}>
              {recentHere.map((p) => row(p, `recent:${p.id}`, { icon: "history" }))}
            </ScreenSection>
          )}
          {!adding && recentHere.length > 0 && <ScreenLink label={t("clearRecent")} onPress={() => places.clearRecent()} />}
          {!adding && (
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
          )}
          {adding && <ScreenLink label={t("cancel")} onPress={() => router.back()} />}
        </>
      )}

      {destinationCard && <PlaceCard place={destinationCard} onExit={exitDestinationCard} />}

      {!searched && q !== "" && !point && <ScreenNote>{t("searchNeedsData")}</ScreenNote>}
      <ScreenNote>{`${t("routeTip")} ${t("routeOutsideRegion")}`}</ScreenNote>
    </ScreenContent>
  );
}

/**
 * The kinds to pull in at along the route (STOPS-SPEC §6.2), each opening its list; `back`: the pages a place picked
 * there goes back to reach the trip (2 from the stop search, pushed over the trip).
 */
function PullInTiles({ back = 1 }: { back?: number }) {
  const { t } = useT();
  const palette = usePalette();
  return (
    <ScreenSection title={t("pullInOnTheWay")} plain>
      <View style={tripStyles.tiles}>
        {STOP_CATEGORIES.map((c) => (
          <Pressable
            key={c}
            onPress={() => router.push({ pathname: "/along", params: { category: c, back: String(back) } })}
            accessibilityRole="button"
            style={({ pressed }) => [tripStyles.tile, { backgroundColor: palette.groupBg }, pressed && styles.pressed]}
          >
            <Icon name={CATEGORY_ICON[c]} size={24} color={palette.accent} />
            <T w="medium" size={15} fit>
              {t(CATEGORY_LABEL[c])}
            </T>
          </Pressable>
        ))}
      </View>
    </ScreenSection>
  );
}

/** The add-a-stop search's results with their detours shown: once every detour is known, the least first. */
const ESTIMATED = 10;

function byDetour(list: Place[], estimates: RouteSnapshot["estimates"]): Place[] {
  if (!estimates) return list;
  const head = list.slice(0, ESTIMATED);
  if (!head.every((d) => d.id in estimates)) return list;
  const cost = (d: Place) => estimates[d.id] ?? Infinity;
  return [...head.sort((a, b) => cost(a) - cost(b)), ...list.slice(ESTIMATED)];
}

/**
 * The trip on the route page (STOPS-SPEC §7.1): "Pull in on the way" by kind, then my position, the stops (earlier,
 * remove), the destination with the arrival, "Add a stop", the whole trip's distance and time, and Stop guidance.
 */
function TripSection({
  route,
  nowMs,
  onAdd,
  onStop,
  onDragging,
}: {
  route: RouteSnapshot;
  nowMs: number;
  onAdd(): void;
  onStop(): void;
  onDragging(on: boolean): void;
}) {
  const { t, language } = useT();
  const palette = usePalette();
  const routes = getRuntime().routes;
  const keys = useMemo(() => route.stops.map((s) => s.key), [route.stops]);
  const move = useMemo(() => routes.moveStop.bind(routes), [routes]);
  const drag = useStopDrag(keys, move, onDragging);
  // The stop just added (here, or from the places on the way): its row glows once.
  const undo = useTripUndo();
  const [glowed, setGlowed] = useState<number | null>(null);
  const added = undo?.kind === "stop" && undo.id !== glowed ? undo.stopKey : undefined;
  const plan = route.plan;
  const g = route.guidance;
  const leftS = g?.remainingS ?? plan?.durationS ?? 0;
  const leftM = g?.remainingM ?? plan?.lengthM ?? 0;
  // The plan's time already behind the car: each stop's arrival is its time on the plan less that.
  const doneS = plan ? plan.durationS - leftS : 0;
  const atStopS = (key: string) => {
    const at = plan?.stops?.find((x) => x.key === key);
    return at ? Math.max(0, at.atS - doneS) : null;
  };
  return (
    <>
      {route.status === "active" && <PullInTiles />}
      <ScreenSection>
        <View style={styles.destination}>
          <View style={[tripStyles.stop, { borderColor: palette.accentA, backgroundColor: palette.accentA }]}>
            <Icon name="my_location" size={16} color={palette.accent} />
          </View>
          <T w="medium" size={16} style={styles.flex}>
            {t("myPosition")}
          </T>
        </View>
        {route.stops.map((stop, i) => {
          const s = atStopS(stop.key);
          const name = stop.name ?? t("droppedPin");
          return (
            <Animated.View
              key={stop.key}
              onLayout={drag.layout(i)}
              style={[styles.destination, { backgroundColor: palette.groupBg }, drag.offset(i)]}
            >
              {stop.key === added && <Flash onDone={() => setGlowed(undo!.id)} />}
              <View style={[tripStyles.stop, { borderColor: palette.accentA, backgroundColor: palette.accentA }]}>
                {stop.category ? (
                  <Icon name={CATEGORY_ICON[stop.category]} size={16} color={palette.accent} />
                ) : (
                  <T w="semibold" size={14} color={palette.accent}>
                    {String(i + 1)}
                  </T>
                )}
              </View>
              <View style={styles.destinationCopy}>
                <T w="semibold" size={16} numberOfLines={2}>
                  {name}
                </T>
                {(s !== null || stop.detail) && (
                  <T size={12} color={palette.text2} numberOfLines={2}>
                    {[stop.detail, s !== null ? t("stopAt").replace("{time}", formatArrival(s, nowMs)) : null].filter(Boolean).join(" · ")}
                  </T>
                )}
              </View>
              {route.stops.length > 1 && (
                // Dragged to its place; screen readers move it a place at a time.
                <View
                  {...drag.handlers[i]}
                  accessible
                  accessibilityLabel={t("reorderStop").replace("{name}", name)}
                  accessibilityActions={[
                    ...(i > 0 ? [{ name: "earlier", label: t("moveStopUp").replace("{name}", name) }] : []),
                    ...(i < route.stops.length - 1 ? [{ name: "later", label: t("moveStopDown").replace("{name}", name) }] : []),
                  ]}
                  onAccessibilityAction={(e) => routes.moveStop(stop.key, e.nativeEvent.actionName === "earlier" ? -1 : 1)}
                  hitSlop={6}
                  style={[tripStyles.button, { backgroundColor: palette.surface }]}
                >
                  <Icon name="drag_handle" size={16} color={palette.text2} />
                </View>
              )}
              <Pressable
                onPress={() => routes.removeStop(stop.key)}
                accessibilityRole="button"
                accessibilityLabel={t("removeStop").replace("{name}", name)}
                hitSlop={6}
                style={({ pressed }) => [tripStyles.button, { backgroundColor: palette.surface }, pressed && styles.pressed]}
              >
                <Icon name="close" size={16} color={palette.text2} />
              </Pressable>
            </Animated.View>
          );
        })}
        <View onLayout={drag.layout(route.stops.length)} style={styles.destination}>
          <View style={[tripStyles.stop, { borderColor: palette.accentA, backgroundColor: palette.accentA }]}>
            <Icon name="flag" size={16} color={palette.accent} />
          </View>
          <View style={styles.destinationCopy}>
            <T w="semibold" size={16} numberOfLines={2}>
              {route.destination.name ?? t("droppedPin")}
            </T>
            {(plan || route.destination.detail) && (
              <T size={12} color={palette.text2} numberOfLines={2}>
                {[route.destination.detail, plan ? t("arriveAt").replace("{time}", formatArrival(leftS, nowMs)) : null].filter(Boolean).join(" · ")}
              </T>
            )}
          </View>
        </View>
        {route.stops.length < routes.maxStops && (
          <Pressable onPress={onAdd} accessibilityRole="button" style={({ pressed }) => [styles.destination, pressed && styles.pressed]}>
            <View style={[tripStyles.stop, { borderColor: palette.accentA, backgroundColor: palette.accentA }]}>
              <Icon name="add" size={18} color={palette.accent} />
            </View>
            <T w="semibold" size={16} color={palette.accent}>
              {t("addStop")}
            </T>
          </Pressable>
        )}
      </ScreenSection>
      {route.status === "planning" && <ScreenNote>{t("planningRoute")}</ScreenNote>}
      {plan && (
        <ScreenCard>
          <View style={metricStyles.row}>
            <Metric label={t("distance")} value={formatDistance(leftM, language)} />
            <Metric label={t("eta")} value={formatDurationS(leftS, t)} />
            <Metric label={t("stopArrival")} value={formatArrival(leftS, nowMs)} />
          </View>
        </ScreenCard>
      )}
      <ScreenAction labelKey="stopGuidance" secondary onPress={onStop} />
    </>
  );
}

const tripStyles = StyleSheet.create({
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tile: { flexBasis: "31%", flexGrow: 1, minHeight: 76, borderRadius: 16, alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 6 },
  stop: { width: 36, height: 36, borderRadius: 18, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  button: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
});

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
  flex: { flex: 1 },
  rowIcon: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
});
