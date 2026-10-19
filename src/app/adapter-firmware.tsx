import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenCard } from "@/components/screens/screen-ui";
import { Icon } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import type { Strings } from "@/i18n/en";
import { useT } from "@/i18n/provider";
import type { FirmwareUpdater } from "@/obd/catalog";
import { useRuntime } from "@/providers/runtime-provider";
import { holdForUpdater, openUpdaterStore, releaseUpdaterHold } from "@/services/vehicle-link/firmware-notice";

const APP_NAMES: Record<FirmwareUpdater, string> = { obdlink: "OBDLink", vgate: "VgateFwUpdater" };

const STEPS: Record<FirmwareUpdater, readonly (keyof Strings)[]> = {
  obdlink: ["fwStepObdlinkOpen", "fwStepObdlinkCheck", "fwStepBack"],
  vgate: ["fwStepVgateOpen", "fwStepVgateFollow", "fwStepBack"],
};

/**
 * The firmware check (VEHICLE-LINK-SPEC §8.4): a full-screen page the first time an adapter answers on this phone,
 * over onboarding too. The maker's app updates the firmware; this one lets go of the adapter so that app can reach it,
 * and stays open ("released") with auto-connect paused until the driver taps Connect again or closes it.
 */
export default function AdapterFirmwareScreen() {
  const { t } = useT();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { link } = useRuntime();
  const params = useLocalSearchParams<{ updater?: string; adapter?: string; again?: string }>();
  const updater: FirmwareUpdater = params.updater === "vgate" ? "vgate" : "obdlink";
  const app = APP_NAMES[updater];
  const fill = (s: string) => s.replaceAll("{app}", app).replaceAll("{adapter}", params.adapter || t("fwThisAdapter"));

  // The adapter let go for the update: taken back (waiting while it reboots) when the page closes, however it closes.
  const released = useRef<string | null>(null);
  const [isReleased, setReleased] = useState(false);
  useEffect(
    () => () => {
      const id = released.current;
      if (id === null) return;
      releaseUpdaterHold();
      // Already back (the pause ran out, or the driver connected on the Car page): left as it is.
      const { activeDeviceId, link: state } = link.getSnapshot();
      if (activeDeviceId && state !== "error") return;
      void link.connect(id, { wait: true }).catch(() => undefined);
    },
    [link],
  );

  const close = () => (router.canGoBack() ? router.back() : router.replace("/"));
  // An adapter answers one app at a time: the maker's app can't reach it while this one holds it, and auto-connect
  // would take it back whenever this app comes to the front (the driver rereading the steps).
  const openApp = () => {
    if (released.current === null) {
      const id = link.getSnapshot().activeDeviceId;
      if (id !== null) {
        released.current = id;
        holdForUpdater();
        void link.disconnect();
      }
      setReleased(true);
    }
    void openUpdaterStore(updater).catch(() => undefined);
  };

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: palette.bg, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 10 },
      ]}
    >
      <ScrollView style={styles.scroll} contentContainerStyle={styles.body}>
        <View style={[styles.iconTile, { backgroundColor: palette.accentA }]}>
          <Icon name="system_update" size={30} color={palette.accent} />
        </View>
        <T w="semibold" size={30} style={styles.title}>
          {t("fwTitle")}
        </T>
        <T size={16} color={palette.text2} style={styles.lead}>
          {/* `again`: opened from the Car page, not for a new adapter. */}
          {fill(t(params.again === "1" ? "fwBodyAgain" : "fwBody"))}
        </T>
        <ScreenCard style={styles.steps}>
          {STEPS[updater].map((key, i) => (
            <View
              key={key}
              style={[styles.step, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line }]}
            >
              <View style={[styles.stepNumber, { backgroundColor: palette.accentA }]}>
                <T w="semibold" size={14} color={palette.accent}>
                  {String(i + 1)}
                </T>
              </View>
              <T size={15} style={styles.flex}>
                {fill(t(key))}
              </T>
            </View>
          ))}
        </ScreenCard>
        <T size={13} color={palette.text2} style={styles.hint}>
          {t("fwKeepPlugged")}
        </T>
      </ScrollView>

      {/* By the buttons, never scrolled away: why the adapter shows as not connected meanwhile. */}
      {isReleased && (
        <ScreenCard style={styles.released}>
          <Icon name="bluetooth" size={24} color={palette.warn.c} />
          <T size={14} style={[styles.flex, styles.hint]}>
            {fill(t("fwReleased"))}
          </T>
        </ScreenCard>
      )}

      <View style={styles.buttons}>
        <Pressable
          onPress={isReleased ? close : openApp}
          accessibilityRole="button"
          style={({ pressed }) => [styles.button, { backgroundColor: palette.accent }, pressed && styles.pressed]}
        >
          <T w="semibold" size={16} color={palette.onAccent} fit={2} style={styles.buttonLabel}>
            {isReleased ? t("fwReconnect") : fill(t("fwOpenApp"))}
          </T>
        </Pressable>
        <Pressable
          onPress={isReleased ? openApp : close}
          accessibilityRole="button"
          style={({ pressed }) => [styles.button, { backgroundColor: palette.secBg }, pressed && styles.pressed]}
        >
          <T w="semibold" size={16} fit={2} style={styles.buttonLabel}>
            {isReleased ? fill(t("fwOpenApp")) : t("fwSkip")}
          </T>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, gap: 20, paddingHorizontal: 24 },
  scroll: { flex: 1 },
  body: { flexGrow: 1, justifyContent: "flex-end", gap: 16 },
  iconTile: { width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center" },
  title: { lineHeight: 34, letterSpacing: -0.6 },
  lead: { lineHeight: 24 },
  steps: { paddingVertical: 4 },
  step: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 },
  stepNumber: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  flex: { flex: 1 },
  hint: { lineHeight: 18 },
  released: { flexDirection: "row", alignItems: "center", gap: 14 },
  buttons: { gap: 10 },
  // A long label at a large text size takes a second line before it shrinks.
  button: {
    minHeight: 54,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: Radius.pill,
  },
  buttonLabel: { textAlign: "center" },
  pressed: { opacity: 0.8 },
});
