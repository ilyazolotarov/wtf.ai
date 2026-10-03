import { useKeepAwake } from "expo-keep-awake";
import { Link } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useState } from "react";
import {
    Alert,
    Linking,
    Pressable,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { MapSurface } from "@/components/map/map-surface";
import { Colors } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import type { TrustState } from "@/nav/position/types";
import {
    usePosition,
    usePositionPermission,
} from "@/providers/position-provider";
import { useRoute } from "@/providers/route-provider";
import { useRecorderSnapshot, useVehicleLinkValue } from "@/providers/runtime-provider";

type CameraMode = "follow" | "follow-heading" | "free";

const trustColorKey: Record<
  TrustState,
  "trustOk" | "untrusted" | "reacquiring" | "noFix"
> = {
  TRUSTED: "trustOk",
  UNTRUSTED: "untrusted",
  REACQUIRING: "reacquiring",
  NO_FIX: "noFix",
};

const trustTextKey: Record<
  TrustState,
  "gpsOk" | "untrusted" | "reacquiring" | "noFix"
> = {
  TRUSTED: "gpsOk",
  UNTRUSTED: "untrusted",
  REACQUIRING: "reacquiring",
  NO_FIX: "noFix",
};

export default function HomeScreen() {
  useKeepAwake();
  const insets = useSafeAreaInsets();
  const { t, language } = useT();
  const position = usePosition();
  const { permission, requestPermission } = usePositionPermission();
  const { activeRoute } = useRoute();
  const colorScheme = useColorScheme();
  const palette = Colors[colorScheme === "dark" ? "dark" : "light"];
  const [cameraMode, setCameraMode] = useState<CameraMode>("follow");
  const [menuVisible, setMenuVisible] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const trust = position?.trust ?? "NO_FIX";
  const adapterLabel = useVehicleLinkValue((s) =>
    s.link === "polling"
      ? `${t("adapterOnline")} ${s.stats ? Math.round(s.stats.speedHz) : "…"} Hz`
      : s.link === "standby"
        ? t("adapterStandby")
        : s.link === "connecting" || s.link === "probing" || s.link === "initializing" || s.link === "reconnecting"
          ? t("adapterConnecting")
          : t("adapterDisconnected"),
  );
  const recording = useRecorderSnapshot().state === "recording";
  const isDenied = permission?.status === "denied";

  const cycleCameraMode = useCallback(() => {
    setCameraMode((mode) =>
      mode === "follow"
        ? "follow-heading"
        : mode === "follow-heading"
          ? "free"
          : "follow",
    );
  }, []);

  const enableLocation = async () => {
    setRequesting(true);
    try {
      await requestPermission();
    } finally {
      setRequesting(false);
    }
  };

  return (
    <View style={styles.root}>
      <MapSurface
        mode={cameraMode}
        onUserInteraction={() => setCameraMode("free")}
        onLongPress={() => Alert.alert(t("manualFixTitle"), t("manualFixBody"))}
      />
      <View
        pointerEvents="box-none"
        style={[
          styles.overlay,
          { paddingTop: insets.top + 10, paddingBottom: insets.bottom + 12 },
        ]}
      >
        <View style={styles.topStack}>
          <View style={styles.topRow}>
            <View
              style={[
                styles.trustBadge,
                { backgroundColor: palette[trustColorKey[trust]] },
              ]}
            >
              <View style={styles.statusDot} />
              <Text style={styles.badgeText}>{t(trustTextKey[trust])}</Text>
            </View>
            <View style={styles.sinceStrip}>
              <Text style={styles.sinceLabel}>{t("sinceTrusted")}</Text>
              <Text style={styles.sinceValue}>
                {position ? formatFixAge(position.timestamp) : "—"}
              </Text>
            </View>
            <Link href="/vehicle" asChild>
              <Pressable style={styles.adapterChip} accessibilityRole="button">
                <SymbolView
                  name={{
                    ios: "car.side",
                    android: "directions_car",
                    web: "directions_car",
                  }}
                  size={17}
                  tintColor="#E9F0EF"
                />
                <Text style={styles.adapterText}>
                  {recording ? `● ${t("recordingBadge")} · ` : ""}
                  {adapterLabel}
                </Text>
              </Pressable>
            </Link>
          </View>
          <Link href="/calibration" asChild>
            <Pressable style={styles.accuracyBadge} accessibilityRole="button">
              <SymbolView
                name={{
                  ios: "scope",
                  android: "my_location",
                  web: "my_location",
                }}
                size={16}
                tintColor="#FFE09A"
              />
              <Text style={styles.accuracyText}>{t("lowAccuracy")}</Text>
            </Pressable>
          </Link>
        </View>

        {activeRoute && (
          <View style={styles.maneuverBanner}>
            <SymbolView
              name={{
                ios: "arrow.up.right",
                android: "north_east",
                web: "north_east",
              }}
              size={19}
              tintColor="#FFFFFF"
            />
            <View style={styles.maneuverCopy}>
              <Text style={styles.maneuverTitle}>
                {t("headToward")} {activeRoute.name[language]}
              </Text>
              <Text style={styles.maneuverDistance}>
                {formatDistance(activeRoute.distanceM)}
              </Text>
            </View>
          </View>
        )}

        {!position && (
          <View style={styles.centerCard}>
            <SymbolView
              name={{
                ios: "location.slash.fill",
                android: "location_disabled",
                web: "location_disabled",
              }}
              size={25}
              tintColor="#1676D2"
            />
            <Text style={styles.centerTitle}>
              {isDenied ? t("locationNeeded") : t("waitingForGps")}
            </Text>
            {permission?.status !== "granted" && (
              <Pressable
                onPress={
                  isDenied
                    ? () => void Linking.openURL("app-settings:")
                    : enableLocation
                }
                disabled={requesting}
                style={styles.locationButton}
                accessibilityRole="button"
              >
                <Text style={styles.locationButtonText}>
                  {isDenied ? t("openSettings") : t("enableLocation")}
                </Text>
              </Pressable>
            )}
          </View>
        )}

        <View style={styles.bottomStack}>
          <View style={styles.bottomControls}>
            <View style={styles.speedReadout}>
              <Text style={styles.speedNumber}>
                {position?.speedMps == null
                  ? "—"
                  : Math.round(position.speedMps * 3.6).toString()}
              </Text>
              <Text style={styles.speedUnit}>{t("speed")}</Text>
            </View>
            <Pressable
              style={styles.recenterButton}
              onPress={cycleCameraMode}
              accessibilityRole="button"
              accessibilityLabel={t(
                cameraMode === "follow-heading" ? "followHeading" : cameraMode,
              )}
            >
              <SymbolView
                name={{
                  ios: "location.north.fill",
                  android: "navigation",
                  web: "navigation",
                }}
                size={21}
                tintColor="#F4F8F7"
              />
              <Text style={styles.recenterText}>
                {t(
                  cameraMode === "follow-heading"
                    ? "followHeading"
                    : cameraMode,
                )}
              </Text>
            </Pressable>
          </View>
          <View style={styles.toolbar}>
            <Link href="/route" asChild>
              <Pressable
                style={styles.toolbarButton}
                accessibilityRole="button"
              >
                <SymbolView
                  name={{
                    ios: "arrow.triangle.turn.up.right.diamond.fill",
                    android: "alt_route",
                    web: "alt_route",
                  }}
                  size={19}
                  tintColor="#EAF2F0"
                />
                <Text style={styles.toolbarText}>{t("route")}</Text>
              </Pressable>
            </Link>
            <Link href="/vehicle" asChild>
              <Pressable
                style={styles.toolbarButton}
                accessibilityRole="button"
              >
                <SymbolView
                  name={{
                    ios: "car.side.fill",
                    android: "directions_car",
                    web: "directions_car",
                  }}
                  size={19}
                  tintColor="#EAF2F0"
                />
                <Text style={styles.toolbarText}>{t("vehicle")}</Text>
              </Pressable>
            </Link>
            <View>
              <Pressable
                style={styles.toolbarButton}
                onPress={() => setMenuVisible((visible) => !visible)}
                accessibilityRole="button"
                accessibilityLabel={t("menu")}
              >
                <SymbolView
                  name={{
                    ios: "ellipsis",
                    android: "more_horiz",
                    web: "more_horiz",
                  }}
                  size={21}
                  tintColor="#EAF2F0"
                />
                <Text style={styles.toolbarText}>{t("menu")}</Text>
              </Pressable>
              {menuVisible && (
                <View style={styles.menuPanel}>
                  <MenuLink href="/downloads" label={t("downloads")} />
                  <MenuLink href="/calibration" label={t("calibration")} />
                  <MenuLink href="/debug" label={t("debug")} />
                  <MenuLink href="/settings" label={t("settings")} />
                </View>
              )}
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

function MenuLink({
  href,
  label,
}: {
  href: "/downloads" | "/calibration" | "/debug" | "/settings";
  label: string;
}) {
  return (
    <Link href={href} asChild>
      <Pressable style={styles.menuItem} accessibilityRole="button">
        <Text style={styles.menuText}>{label}</Text>
      </Pressable>
    </Link>
  );
}

function formatFixAge(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}

function formatDistance(distanceM: number): string {
  return distanceM >= 1000
    ? `${(distanceM / 1000).toFixed(1)} km`
    : `${Math.round(distanceM)} m`;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#D9E1DD" },
  overlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: "space-between",
    paddingHorizontal: 14,
  },
  topStack: { gap: 9 },
  topRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  trustBadge: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 12,
    borderRadius: 22,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: "#FFFFFF",
  },
  badgeText: { color: "#FFFFFF", fontSize: 11, fontWeight: "800" },
  sinceStrip: {
    flex: 1,
    minHeight: 42,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: "rgba(16, 28, 30, 0.88)",
  },
  sinceLabel: { color: "#AEBFBB", fontSize: 9, fontWeight: "700" },
  sinceValue: {
    color: "#F5FAF8",
    fontSize: 14,
    fontVariant: ["tabular-nums"],
    fontWeight: "700",
  },
  adapterChip: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: "#1C3031",
  },
  adapterText: { color: "#E9F0EF", fontSize: 10, fontWeight: "700" },
  accuracyBadge: {
    alignSelf: "flex-start",
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 12,
    borderRadius: 20,
    backgroundColor: "#46371D",
  },
  accuracyText: { color: "#FFE09A", fontSize: 10, fontWeight: "800" },
  maneuverBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 14,
    backgroundColor: "#176FA9",
  },
  maneuverCopy: { flex: 1, gap: 3 },
  maneuverTitle: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
  maneuverDistance: {
    color: "#D6E9F4",
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
  centerCard: {
    alignSelf: "center",
    alignItems: "center",
    gap: 12,
    width: "88%",
    maxWidth: 340,
    padding: 20,
    borderRadius: 18,
    backgroundColor: "rgba(250, 252, 250, 0.96)",
    boxShadow: "0 8px 26px rgba(23, 39, 38, 0.18)",
  },
  centerTitle: {
    color: "#263537",
    fontSize: 15,
    fontWeight: "700",
    textAlign: "center",
  },
  locationButton: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "stretch",
    borderRadius: 12,
    backgroundColor: "#176FA9",
  },
  locationButtonText: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
  bottomStack: { gap: 12 },
  bottomControls: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
  },
  speedReadout: {
    minWidth: 106,
    minHeight: 82,
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
    paddingHorizontal: 15,
    paddingTop: 15,
    borderRadius: 16,
    backgroundColor: "#15282B",
  },
  speedNumber: {
    color: "#F8FCFA",
    fontSize: 34,
    fontVariant: ["tabular-nums"],
    fontWeight: "700",
  },
  speedUnit: { color: "#AFC2BD", fontSize: 11, fontWeight: "700" },
  recenterButton: {
    minWidth: 128,
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
    paddingHorizontal: 14,
    borderRadius: 15,
    backgroundColor: "#176FA9",
  },
  recenterText: { color: "#F4F8F7", fontSize: 13, fontWeight: "700" },
  toolbar: {
    minHeight: 70,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    borderRadius: 19,
    backgroundColor: "#15282B",
    boxShadow: "0 5px 18px rgba(12, 26, 27, 0.28)",
  },
  toolbarButton: {
    minWidth: 80,
    minHeight: 62,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  toolbarText: { color: "#DCE8E4", fontSize: 10, fontWeight: "700" },
  menuPanel: {
    position: "absolute",
    right: 0,
    bottom: 70,
    width: 180,
    paddingVertical: 5,
    borderRadius: 14,
    backgroundColor: "#15282B",
    boxShadow: "0 6px 20px rgba(12, 26, 27, 0.3)",
  },
  menuItem: { minHeight: 48, justifyContent: "center", paddingHorizontal: 16 },
  menuText: { color: "#EDF4F1", fontSize: 14, fontWeight: "600" },
});
