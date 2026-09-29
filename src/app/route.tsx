import { Stack } from "expo-router";
import { useState } from "react";
import {
    Pressable,
    StyleSheet,
    Text,
    View,
    useColorScheme,
} from "react-native";

import {
    ScreenAction,
    ScreenContent,
    ScreenNote,
    ScreenSection,
    ScreenTitle,
} from "@/components/screens/screen-ui";
import { Colors } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { bearingRad, haversineM } from "@/nav/geo";
import { usePosition } from "@/providers/position-provider";
import type { Destination } from "@/providers/route-provider";
import { destinations, useRoute } from "@/providers/route-provider";

export default function RouteScreen() {
  const { t, language } = useT();
  const position = usePosition();
  const { activeRoute, startRoute, stopRoute } = useRoute();
  const [selectedDestination, setSelectedDestination] =
    useState<Destination | null>(null);
  const [query, setQuery] = useState("");
  const scheme = useColorScheme();
  const palette = Colors[scheme === "dark" ? "dark" : "light"];
  const selected =
    selectedDestination ??
    (activeRoute
      ? (destinations.find(({ id }) => id === activeRoute.id) ?? null)
      : null);
  const origin = position ?? { lat: 50.4501, lon: 30.5234 };
  const distanceM = selected ? haversineM(origin, selected) : 0;
  const bearingDegrees = selected
    ? ((bearingRad(origin, selected) * 180) / Math.PI + 360) % 360
    : 0;
  const filteredDestinations = destinations.filter(({ name }) =>
    `${name.en} ${name.uk}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );

  return (
    <>
      <Stack.SearchBar
        placeholder={t("routeSearch")}
        onChangeText={(event) => setQuery(event.nativeEvent.text)}
      />
      <ScreenContent>
        <ScreenTitle>{t("route")}</ScreenTitle>
        {!selected && (
          <ScreenSection>
            {filteredDestinations.length === 0 ? (
              <ScreenNote>{t("noDestinations")}</ScreenNote>
            ) : (
              filteredDestinations.map((destination) => (
                <DestinationRow
                  key={destination.id}
                  name={destination.name[language]}
                  selected={false}
                  onPress={() => setSelectedDestination(destination)}
                />
              ))
            )}
          </ScreenSection>
        )}

        {selected && (
          <ScreenSection title={t("routeSummary")}>
            <Text style={[styles.destination, { color: palette.text }]}>
              {selected.name[language]}
            </Text>
            {!position && (
              <ScreenNote>{t("currentPositionUnknown")}</ScreenNote>
            )}
            <Metric label={t("distance")} value={formatDistance(distanceM)} />
            <Metric
              label={t("bearing")}
              value={`${Math.round(bearingDegrees)}°`}
            />
            <Metric
              label={t("eta")}
              value={`${Math.max(1, Math.round(distanceM / 1000))} min`}
            />
            {activeRoute?.id === selected.id ? (
              <ScreenAction labelKey="stop" secondary onPress={stopRoute} />
            ) : (
              <ScreenAction
                labelKey="start"
                onPress={() => startRoute(selected, position)}
              />
            )}
            <Pressable
              onPress={() => setSelectedDestination(null)}
              style={styles.backLink}
            >
              <Text style={styles.backText}>{t("routeSearch")}</Text>
            </Pressable>
          </ScreenSection>
        )}

        <ScreenNote>{t("offlineRoutingUnavailable")}</ScreenNote>
      </ScreenContent>
    </>
  );
}

function DestinationRow({
  name,
  selected,
  onPress,
}: {
  name: string;
  selected: boolean;
  onPress(): void;
}) {
  const scheme = useColorScheme();
  const palette = Colors[scheme === "dark" ? "dark" : "light"];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.destinationRow,
        { borderBottomColor: palette.backgroundSelected },
        selected && styles.selected,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.destinationName, { color: palette.text }]}>
        {name}
      </Text>
      <Text style={[styles.chevron, { color: palette.textSecondary }]}>›</Text>
    </Pressable>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  const scheme = useColorScheme();
  const palette = Colors[scheme === "dark" ? "dark" : "light"];
  return (
    <View style={styles.metric}>
      <Text style={{ color: palette.textSecondary }}>{label}</Text>
      <Text
        selectable
        style={{
          color: palette.text,
          fontVariant: ["tabular-nums"],
          fontWeight: "700",
        }}
      >
        {value}
      </Text>
    </View>
  );
}

function formatDistance(distanceM: number): string {
  return distanceM >= 1000
    ? `${(distanceM / 1000).toFixed(1)} km`
    : `${Math.round(distanceM)} m`;
}

const styles = StyleSheet.create({
  destinationRow: {
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  destinationName: { fontSize: 16, fontWeight: "600" },
  chevron: { fontSize: 24 },
  selected: { backgroundColor: "rgba(23, 111, 169, 0.08)" },
  pressed: { opacity: 0.75 },
  destination: { fontSize: 22, fontWeight: "700" },
  metric: {
    minHeight: 33,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  backLink: { alignSelf: "center", padding: 8 },
  backText: { color: "#176FA9", fontSize: 13, fontWeight: "600" },
});
