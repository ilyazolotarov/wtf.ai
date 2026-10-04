import { router } from "expo-router";
import { useState } from "react";
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
import { Icon } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { Font, Radius, usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { bearingRad, haversineM } from "@/nav/geo";
import { usePosition } from "@/providers/position-provider";
import type { Destination } from "@/providers/route-provider";
import { destinations, useRoute } from "@/providers/route-provider";

const KYIV = { lat: 50.4501, lon: 30.5234 };

export default function RouteScreen() {
  const { t, language } = useT();
  const palette = usePalette();
  const position = usePosition();
  const { route, startRoute, stopRoute } = useRoute();
  const routeId = route?.destination.id ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(routeId);
  const [query, setQuery] = useState("");
  const selected = destinations.find(({ id }) => id === selectedId) ?? null;
  const origin = position ?? KYIV;
  const summary = (d: Destination) => {
    const distanceM = haversineM(origin, d);
    const bearing = toDegrees(bearingRad(origin, d));
    return { distanceM, bearing };
  };
  const q = query.trim().toLocaleLowerCase();
  const filtered = destinations.filter(({ name }) =>
    `${name.en} ${name.uk}`.toLocaleLowerCase().includes(q),
  );

  return (
    <ScreenContent title={t("route")}>
      <View style={[styles.search, { backgroundColor: palette.surface }]}>
        <Icon name="search" size={18} color={palette.text2} />
        <TextInput
          value={query}
          onChangeText={(text) => {
            setQuery(text);
            setSelectedId(null);
          }}
          placeholder={t("routeSearch")}
          placeholderTextColor={palette.text2}
          autoCorrect={false}
          returnKeyType="search"
          style={[styles.searchInput, { color: palette.text }]}
        />
      </View>

      {!selected && (
        <ScreenSection>
          {filtered.length === 0 ? (
            <View style={styles.empty}>
              <T size={14} color={palette.text2}>
                {t("noDestinations")}
              </T>
            </View>
          ) : (
            filtered.map((d) => {
              const { distanceM, bearing } = summary(d);
              return (
                <Pressable
                  key={d.id}
                  onPress={() => setSelectedId(d.id)}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.destination, pressed && styles.pressed]}
                >
                  <View style={styles.destinationCopy}>
                    <T w="semibold" size={16}>
                      {d.name[language]}
                    </T>
                    <T size={12} color={palette.text2}>
                      {`${formatDistance(distanceM, language)} · ${cardinal(bearing, language)}`}
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
          <T w="semibold" size={28} style={styles.selectedName}>
            {selected.name[language]}
          </T>
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
                startRoute({ lat: selected.lat, lon: selected.lon, name: selected.name[language], id: selected.id });
                router.back();
              }}
            />
          )}
          <ScreenLink label={t("chooseAnotherCity")} onPress={() => setSelectedId(null)} />
        </ScreenCard>
      )}

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
  selectedName: { letterSpacing: -0.56 },
  metrics: { flexDirection: "row", gap: 10 },
  metric: { flex: 1, gap: 4 },
  tabular: { fontVariant: ["tabular-nums"] },
});
