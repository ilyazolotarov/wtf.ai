// A place's card (UI-SPEC §7.1, STOPS-SPEC §7.1): its name, entrances, distance or the route's, and what to do with it:
// start guidance, add it as a stop, put the car there, save it. A page of its own over the route page (`/place`), so
// the back swipe returns to the list it was picked from; the host says where each action leaves to.

import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { ScreenAction, ScreenCard, ScreenLink, ScreenNote } from "@/components/screens/screen-ui";
import { cardinal, formatDistance, formatEta, toDegrees } from "@/components/status/format-geo";
import { formatDurationS, PROBLEM_TEXT } from "@/components/route/guidance-text";
import { SaveConfirmation } from "@/components/route/save-feedback";
import { addStopWithUndo, offerRouteUndo } from "@/components/route/trip-undo";
import { Icon, type IconName } from "@/components/ui/icon";
import { PressableFeedback } from "@/components/ui/press-feedback";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { bearingRad, haversineM, type Coordinate } from "@/nav/geo";
import { places } from "@/providers/places";
import { usePosition } from "@/providers/position-provider";
import { useRoute } from "@/providers/route-provider";
import { requestPlacing } from "@/services/navigation/place-request";
import type { Place, SavedKind, SavedPlace } from "@/services/navigation/places-store";
import { useMapPacks } from "@/services/offline-map/map-packs";
import { getRuntime } from "@/services/runtime";

export const SAVED_ICON: Record<SavedKind, IconName> = { home: "home", work: "work", favorite: "star" };

/**
 * How the card was left: `map` (a route started, the car placed: back to the map), `trip` (added as a stop: back to the
 * trip), `adding` (a route started to it: the stop search next), `list` (another place wanted).
 */
export type PlaceCardExit = "map" | "trip" | "adding" | "list";

/** The place saved last on a card: its row in the list glows once when the list comes back. */
let savedLast: string | null = null;
export function takeSavedLast(): string | null {
  const id = savedLast;
  savedLast = null;
  return id;
}

export function PlaceCard({ place: selected, onExit }: { place: Place; onExit(how: PlaceCardExit): void }) {
  const { t, language } = useT();
  const palette = usePalette();
  const position = usePosition();
  const { route, startRoute, stopRoute } = useRoute();
  const { installed } = useMapPacks();
  const routes = getRuntime().routes;
  const routeOn = route != null && route.status !== "failed";
  const routeId = route?.destination.id ?? null;
  const bounds = installed.active ? (installed.regions[installed.active]?.bounds ?? null) : null;
  // Distances from the car; without a fix, from the region's middle.
  const origin: Coordinate =
    position ?? (bounds ? { lat: (bounds[1] + bounds[3]) / 2, lon: (bounds[0] + bounds[2]) / 2 } : { lat: 50.45, lon: 30.52 });
  // The entrance picked (its number); null: the building itself.
  const [door, setDoor] = useState<string | null>(null);
  // What the last save or removal did, with what Undo puts back.
  const [feedback, setFeedback] = useState<{ kind: SavedKind | null; replaced: string | null; undo: SavedPlace[] } | null>(null);
  // Where the card routes: the building, or the entrance picked ("…, 16-Б, під'їзд 2" at its door).
  const doorAt = door ? selected.entrances?.find((e) => e.ref === door) : undefined;
  const target: Place = doorAt
    ? {
        id: `${selected.id}:e${doorAt.ref}`,
        title: `${selected.title}, ${t("searchEntrance").replace("{n}", doorAt.ref)}`,
        detail: selected.detail,
        lat: doorAt.lat,
        lon: doorAt.lon,
      }
    : selected;
  const distanceM = haversineM(origin, target);
  const bearing = toDegrees(bearingRad(origin, target));
  // Already a stop of the trip: not offered again.
  const isStop = route?.stops.some((s) => s.id === target.id) ?? false;
  const selectedSaved = places.savedAt(selected);

  const save = (kind: SavedKind) => {
    const before = places.getSnapshot().saved;
    const was = places.savedAt(selected);
    const replaced = kind === "favorite" ? null : (before.find((s) => s.kind === kind && s !== was)?.title ?? null);
    places.save(selected, kind);
    setFeedback({ kind, replaced, undo: before });
    savedLast = selected.id;
  };
  const unsave = () => {
    const before = places.getSnapshot().saved;
    places.unsave(selected);
    setFeedback({ kind: null, replaced: null, undo: before });
    savedLast = null;
  };
  const undo = () => {
    if (feedback) places.restoreSaved(feedback.undo);
    setFeedback(null);
    savedLast = null;
  };

  return (
    <ScreenCard style={styles.card}>
      <View style={styles.head}>
        <T w="semibold" size={28} style={styles.name}>
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
                <PressableFeedback
                  key={ref ?? "building"}
                  onPress={() => setDoor(ref)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={ref ? t("searchEntrance").replace("{n}", ref) : t("entranceBuilding")}
                  style={[styles.door, { backgroundColor: on ? palette.accent : palette.surface }]}
                >
                  <T w="semibold" size={15} color={on ? palette.onAccent : palette.text} style={styles.tabular}>
                    {ref ?? t("entranceBuilding")}
                  </T>
                </PressableFeedback>
              );
            })}
          </View>
        </View>
      )}
      {!position && <ScreenNote>{t("currentPositionUnknown")}</ScreenNote>}
      {routeId === target.id && route?.plan ? (
        // The planned route: its road distance and time.
        <View style={metricStyles.row}>
          <Metric label={t("distance")} value={formatDistance(route.plan.lengthM, language)} />
          <Metric label={t("eta")} value={formatDurationS(route.plan.durationS, t)} />
        </View>
      ) : (
        <View style={metricStyles.row}>
          <Metric label={t("distance")} value={formatDistance(distanceM, language)} />
          <Metric label={t("bearing")} value={`${Math.round(bearing)}° ${cardinal(bearing, language)}`} />
          <Metric label={t("etaStraight")} value={formatEta(distanceM, language)} />
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
            // Replacing a route on: Undo on the map puts it back (STOPS-SPEC §7.4).
            if (routeOn) offerRouteUndo(routes, route, target.title);
            startRoute({ lat: target.lat, lon: target.lon, name: target.title, id: target.id });
            onExit("map");
          }}
        />
      )}
      {routeOn && routeId !== target.id && route.stops.length < routes.maxStops && !isStop ? (
        // A route on: this place as a stop on the way instead of the new destination (not twice).
        <ScreenAction
          labelKey="addAsStop"
          icon="add"
          secondary
          onPress={() => {
            addStopWithUndo(routes, { lat: target.lat, lon: target.lon, name: target.title, id: target.id });
            onExit("trip");
          }}
        />
      ) : !routeOn ? (
        // No route yet: go there, then pick a stop on the way.
        <ScreenAction
          labelKey="addStop"
          icon="add"
          secondary
          onPress={() => {
            places.addRecent(target);
            startRoute({ lat: target.lat, lon: target.lon, name: target.title, id: target.id });
            onExit("adding");
          }}
        />
      ) : null}
      <ScreenAction
        labelKey="placeMeHere"
        icon="location_on"
        secondary
        onPress={() => {
          requestPlacing(target);
          onExit("map");
        }}
      />
      {feedback && <SaveConfirmation key={`${feedback.kind}:${feedback.undo.length}`} kind={feedback.kind} replaced={feedback.replaced} onUndo={undo} />}
      {selectedSaved ? (
        <View style={styles.saveRow}>
          <Icon name={SAVED_ICON[selectedSaved.kind]} size={16} color={palette.accent} />
          <T size={14} color={palette.text2} style={styles.flex}>
            {t(selectedSaved.kind === "home" ? "savedAsHome" : selectedSaved.kind === "work" ? "savedAsWork" : "savedPlace")}
          </T>
          <ScreenLink label={t("removeSaved")} onPress={unsave} />
        </View>
      ) : (
        <View style={styles.saveRow}>
          <ScreenAction labelKey="placeHome" icon="home" compact secondary style={styles.saveAction} onPress={() => save("home")} />
          <ScreenAction labelKey="placeWork" icon="work" compact secondary style={styles.saveAction} onPress={() => save("work")} />
          <ScreenAction labelKey="savePlace" icon="star_border" compact secondary style={styles.saveAction} onPress={() => save("favorite")} />
        </View>
      )}
      <ScreenLink label={t("chooseAnotherCity")} onPress={() => onExit("list")} />
    </ScreenCard>
  );
}

/** A figure with its label above, in a row of them (`metricStyles.row`). */
export function Metric({ label, value }: { label: string; value: string }) {
  const palette = usePalette();
  return (
    <View style={metricStyles.metric}>
      <T w="medium" size={12} color={palette.text2}>
        {label}
      </T>
      <T selectable w="semibold" size={17} style={styles.tabular}>
        {value}
      </T>
    </View>
  );
}

export const metricStyles = StyleSheet.create({
  // Columns as wide as their words, the room left shared: "Кінець маршруту о" on one line beside the others.
  row: { flexDirection: "row", gap: 6 },
  metric: { flexGrow: 1, flexShrink: 1, flexBasis: "auto", gap: 4 },
});

const styles = StyleSheet.create({
  card: { gap: 18, paddingTop: 18 },
  head: { gap: 4 },
  name: { letterSpacing: -0.56 },
  doors: { gap: 8 },
  doorRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  door: { minWidth: 48, minHeight: 44, paddingHorizontal: 14, borderRadius: Radius.pill, alignItems: "center", justifyContent: "center" },
  saveRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  // Home, Work and Save in one line on a 393-pt phone in Ukrainian: the compact 16 left it ~2 pt short.
  saveAction: { paddingHorizontal: 14 },
  flex: { flex: 1 },
  tabular: { fontVariant: ["tabular-nums"] },
});
