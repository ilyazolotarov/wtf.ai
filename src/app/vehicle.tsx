import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Alert, Linking, Platform, Share, StyleSheet, View } from "react-native";

import {
  ScreenAction,
  ScreenCard,
  ScreenContent,
  ScreenNote,
  ScreenRow,
  ScreenSection,
} from "@/components/screens/screen-ui";
import { useLinkBadge, useNavStatus } from "@/components/status/use-nav-status";
import { Icon } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { DeviceList } from "@/components/vehicle/device-list";
import { WakeWithCar } from "@/components/vehicle/wake-with-car";
import { carStateText, speedFromText } from "@/components/vehicle/car-status";
import { usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { firmwareUpdaterFor } from "@/obd/catalog";
import type { DiscoveredDevice } from "@/obd/types";
import { driveProfileNext, parseSpeedProfile } from "@/services/vehicle-link/driving-emulator";
import { releaseUpdaterHold } from "@/services/vehicle-link/firmware-notice";
import { isOnboardingDone } from "@/services/preferences";
import {
  useDevSettings,
  useRuntime,
  useVehicleLinkSnapshot,
} from "@/providers/runtime-provider";

export default function VehicleScreen() {
  const { t } = useT();
  const params = useLocalSearchParams<{ emulators?: string; cycle?: string }>();
  const { setDevSettings: setDev } = useRuntime();
  // `wtfai://vehicle?emulators=1` lists the simulated adapters: the emulator smoke test (scripts/android-smoke.sh)
  // has no Bluetooth and drives the real app against them. Same switch as Developer → Show emulated adapters.
  // `&cycle=0:0,10:0,22:50,…` (seconds:km/h): the emulator connected next drives that speed profile (the store video).
  useEffect(() => {
    if (params.emulators === "1") setDev({ showEmulators: true });
    if (params.cycle) driveProfileNext(parseSpeedProfile(params.cycle));
  }, [params.emulators, params.cycle, setDev]);

  return (
    <ScreenContent title={t("vehicle")}>
      <CarDetails />
    </ScreenContent>
  );
}

function CarDetails() {
  const { t } = useT();
  const palette = usePalette();
  const runtime = useRuntime();
  const { link } = runtime;
  const nav = useNavStatus();
  const snap = useVehicleLinkSnapshot();
  const { adapter } = snap;
  const canAuto = useSyncExternalStore(runtime.canAuto.subscribe, runtime.canAuto.status);
  const canProbation = useSyncExternalStore(runtime.canProbation.subscribe, runtime.canProbation.status);
  const canDiscovery = useSyncExternalStore(runtime.canDiscovery.subscribe, runtime.canDiscovery.status);

  // With an adapter connected the list stays hidden until the driver asks to switch.
  const [switching, setSwitching] = useState(false);
  const showList = !snap.activeDeviceId || switching;
  const devSettings = useDevSettings();

  useEffect(() => {
    if (!showList) return;
    link.startDiscovery();
    return () => link.stopDiscovery();
  }, [link, showList, devSettings.showEmulators]);

  const select = (device: DiscoveredDevice) => {
    if (device.id === snap.activeDeviceId) return;
    const go = () => {
      setSwitching(false);
      releaseUpdaterHold();
      void link.connect(device.id);
    };
    if (device.rank === "unknown" || device.rank === "non-elm") {
      Alert.alert(device.name ?? device.id, t("tryAnyway"), [
        { text: t("no"), style: "cancel" },
        { text: t("yes"), onPress: go },
      ]);
    } else {
      go();
    }
  };

  // Android has no MFi picker: new adapters are paired in the system Bluetooth settings and then show up bonded.
  const pairMfi = () =>
    (Platform.OS === "android" ? Linking.sendIntent("android.settings.BLUETOOTH_SETTINGS") : link.pairMfi()).catch((e: { code?: string; message?: string }) =>
      Alert.alert(t("pairMfi"), e.code === "mfi-not-found" ? t("mfiNotFound") : (e.message ?? String(e))),
    );

  const remembered = snap.devices.find((d) => d.rank === "remembered");
  // An MFi adapter that dropped off iOS (it froze, or lost power) only comes back when it connects to iOS again: the
  // app can only wait. When the wait is long, say where the driver can make it connect (2026-10-11).
  const badge = useLinkBadge();
  const mfi = snap.devices.find((d) => d.transport === "mfi" && d.rank === "remembered");
  const mfiHint =
    Platform.OS === "ios" && mfi && badge === "bad" && (snap.link === "connecting" || snap.link === "reconnecting")
      ? t("mfiReconnectHint").replace("{name}", mfi.name ?? t("obdAdapter"))
      : null;
  const active = snap.devices.find((d) => d.id === snap.activeDeviceId);
  const adapterName = adapter?.name ?? active?.name ?? remembered?.name ?? t("obdAdapter");
  const gattDump = snap.error?.code === "other" && snap.error.message?.startsWith("[") ? snap.error.message : null;
  const errorText = !snap.error
    ? null
    : snap.error.code === "adapter-silent"
      ? t("adapterSilent")
      : `${snap.error.code}${snap.error.message && !gattDump ? `: ${snap.error.message}` : ""}`;
  // Does the car answer, and what it reads (UI-SPEC §7.2): the rest (chip, protocol, timing) is in the trip log.
  const answering = snap.link === "polling" || snap.link === "standby";
  const car = answering ? carStateText(snap.engine, palette, t) : null;
  const speed = snap.lastSpeed;
  const speedValue = speed
    ? `${Math.round(Math.abs(speed.raw))} ${t("speed")}${speed.raw < 0 ? ` · ${t("reverseGear")}` : ""}`
    : t("unavailableValue");
  // The firmware check again, after the one-time page (VEHICLE-LINK-SPEC §8.4).
  const updater = adapter ? firmwareUpdaterFor({ id: adapter.deviceId, name: adapter.name }) : null;
  const speedFrom = speedFromText({ wheelSpeed: devSettings.wheelSpeed, speed, canOff: snap.canOff ?? null, canShadow: snap.canShadow ?? null, canAuto, canProbation, canDiscovery }, t);

  return (
    <>
      <ScreenCard>
        <View style={styles.adapterCard}>
          <View style={[styles.adapterTile, { backgroundColor: nav.adapterTint }]}>
            <Icon name="bluetooth" size={24} color={nav.adapterColor} />
          </View>
          <View style={styles.adapterCopy}>
            <T w="semibold" size={16} fit>
              {adapterName}
            </T>
            <T size={13} color={nav.adapterColor} fit>
              {nav.adapterLabel}
            </T>
          </View>
          {snap.activeDeviceId ? (
            <View style={styles.adapterAction}>
              <ScreenAction
                // Still waiting for the adapter to show up (auto-connect, a reconnect): stopping that isn't a disconnect.
                labelKey={snap.link === "connecting" || snap.link === "reconnecting" ? "stopSearching" : "disconnect"}
                secondary
                compact
                onPress={() => void link.disconnect()}
              />
            </View>
          ) : remembered ? (
            <View style={styles.adapterAction}>
              <ScreenAction
                labelKey="connect"
                compact
                disabled={nav.adapter === "searching"}
                onPress={() => {
                  // The driver's own Connect ends a pause for the firmware update (VEHICLE-LINK-SPEC §8.4).
                  releaseUpdaterHold();
                  void link.autoConnect();
                }}
              />
            </View>
          ) : null}
        </View>
        {car && (
          <>
            <ScreenRow labelKey="carState" value={car.text} valueColor={car.color} />
            {snap.engine !== "ignition-off" && (
              <>
                <ScreenRow labelKey="carSpeed" value={speedValue} />
                <ScreenRow labelKey="speedFrom" value={speedFrom} />
              </>
            )}
          </>
        )}
        {errorText && <ScreenRow labelKey="lastError" value={errorText} valueColor={palette.bad.c} />}
      </ScreenCard>
      {mfiHint && <ScreenNote>{mfiHint}</ScreenNote>}
      {gattDump && (
        <ScreenAction labelKey="copyGattDump" secondary onPress={() => void Share.share({ message: gattDump })} />
      )}
      {snap.activeDeviceId && (
        <View style={styles.actions}>
          <View style={styles.flex}>
            <ScreenAction labelKey="changeAdapter" secondary compact onPress={() => setSwitching((v) => !v)} />
          </View>
          <View style={styles.flex}>
            <ScreenAction labelKey="forget" secondary compact onPress={() => link.forget(snap.activeDeviceId!)} />
          </View>
        </View>
      )}
      {snap.activeDeviceId && updater && (
        <ScreenAction
          labelKey="fwCheck"
          secondary
          onPress={() => router.push({ pathname: "/adapter-firmware", params: { updater, adapter: adapter?.name ?? "", again: "1" } })}
        />
      )}

      {showList && (
        <>
          <ScreenSection title={t("adapters")} plain>
            <DeviceList
              devices={devSettings.showEmulators ? snap.devices : snap.devices.filter((d) => d.transport !== "emulator")}
              activeId={snap.activeDeviceId}
              onSelect={select}
            />
          </ScreenSection>
          <View style={styles.actions}>
            <View style={styles.flex}>
              <ScreenAction
                labelKey={snap.discovering ? "stopScan" : "scan"}
                secondary
                compact
                onPress={() => (snap.discovering ? link.stopDiscovery() : link.startDiscovery())}
              />
            </View>
            <View style={styles.flex}>
              <ScreenAction labelKey="pairMfi" secondary compact onPress={pairMfi} />
            </View>
          </View>
          <ScreenNote>{t(Platform.OS === "android" ? "pairHintAndroid" : "pairHint")}</ScreenNote>
        </>
      )}

      {/* Not while onboarding brought the driver here: its next step is the same offer. */}
      {(snap.activeDeviceId || remembered) && isOnboardingDone() && (
        <WakeWithCar adapterId={snap.activeDeviceId ?? remembered?.id ?? null} />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  // The button goes under the adapter's name when both don't fit on one line (a large text size, a long label).
  adapterCard: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 14, marginBottom: 4 },
  adapterTile: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  adapterCopy: { flex: 1, minWidth: 150, gap: 2 },
  adapterAction: { marginLeft: "auto" },
  // Side by side, equal, while both labels fit; otherwise stacked (a large text size, a long label).
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: -6 },
  flex: { flexGrow: 1, minWidth: "40%" },
});
