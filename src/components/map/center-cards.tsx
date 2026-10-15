import { useEffect, useState, type PropsWithChildren } from "react";
import { Animated, Linking, Pressable, StyleSheet, View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { insideUkraine } from "@/nav/integrity/border";
import { usePositionPermission } from "@/providers/position-provider";
import { useSensorValue } from "@/providers/runtime-provider";

import { hud } from "./hud-card";

/** Location not allowed: why the app needs it, and the system's ask, or Settings once it may not ask again. */
export function PermissionCard() {
  const { t } = useT();
  const palette = usePalette();
  const { permission, requestPermission } = usePositionPermission();
  const [requesting, setRequesting] = useState(false);
  const toSettings = permission?.status === "denied" && !permission.canAskAgain;
  const enableLocation = async () => {
    setRequesting(true);
    try {
      await requestPermission();
    } finally {
      setRequesting(false);
    }
  };
  return (
    <CenterCard>
      <Icon name="location_off" size={34} color={palette.bad.c} />
      <T w="semibold" size={19} style={styles.title}>
        {t("locationOff")}
      </T>
      <T size={14} color={palette.text2} style={styles.body}>
        {t("locationNeeded")}
      </T>
      <Pressable
        onPress={toSettings ? () => void Linking.openURL("app-settings:") : enableLocation}
        disabled={requesting}
        style={({ pressed }) => [styles.button, { backgroundColor: palette.accent }, pressed && hud.pressed]}
        accessibilityRole="button"
      >
        <T w="semibold" size={15} color={palette.onAccent}>
          {toSettings ? t("openSettings") : t("enableLocation")}
        </T>
      </Pressable>
    </CenterCard>
  );
}

/**
 * "Waiting for GPS…" before the first position. When the phone's location is outside Ukraine, it is never used:
 * integrity refuses a satellite fix there as spoofed (SPEC §3.3), and the navigator drops a Wi-Fi/cell one (iOS gave
 * one on another continent under jamming, 2026-10-15). There never is a first position: say so, and offer placing the
 * car instead, not "looking for satellites".
 */
export function NoFixCard({ onPlace }: { onPlace: () => void }) {
  const { t } = useT();
  const palette = usePalette();
  const abroad = useSensorValue(({ lastFix }) => lastFix != null && !insideUkraine({ lat: lastFix.latDeg, lon: lastFix.lonDeg }));
  if (abroad) {
    return (
      <CenterCard>
        <Icon name="gpp_maybe" size={34} color={palette.warn.c} />
        <T w="semibold" size={19} style={styles.title}>
          {t("gpsAbroadTitle")}
        </T>
        <T size={14} color={palette.text2} style={styles.body}>
          {t("gpsAbroadBody")}
        </T>
        <Pressable
          onPress={onPlace}
          style={({ pressed }) => [styles.button, { backgroundColor: palette.accent }, pressed && hud.pressed]}
          accessibilityRole="button"
        >
          <T w="semibold" size={15} color={palette.onAccent}>
            {t("noAdapterRouteSetButton")}
          </T>
        </Pressable>
      </CenterCard>
    );
  }
  return (
    <CenterCard>
      <Pulse>
        <Icon name="satellite_alt" size={34} color={palette.accent} />
      </Pulse>
      <T w="semibold" size={19} style={styles.title}>
        {t("waitingForGps")}
      </T>
      <T size={14} color={palette.text2} style={styles.body}>
        {t("waitingBody")}
      </T>
    </CenterCard>
  );
}

function CenterCard({ children }: PropsWithChildren) {
  const palette = usePalette();
  return (
    <View style={[styles.card, { backgroundColor: palette.sheetBg, boxShadow: palette.cardShadow }]}>
      {children}
    </View>
  );
}

function Pulse({ children }: PropsWithChildren) {
  const [opacity] = useState(() => new Animated.Value(1));
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.3, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return <Animated.View style={{ opacity }}>{children}</Animated.View>;
}

const styles = StyleSheet.create({
  card: {
    alignSelf: "center",
    alignItems: "center",
    gap: 10,
    width: "88%",
    maxWidth: 350,
    paddingHorizontal: 22,
    paddingVertical: 24,
    borderRadius: Radius.rL,
    borderCurve: "continuous",
  },
  title: { textAlign: "center" },
  body: { textAlign: "center", lineHeight: 20 },
  button: {
    alignSelf: "stretch",
    height: 50,
    marginTop: 4,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: Radius.pill,
  },
});
