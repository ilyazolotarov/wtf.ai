import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Linking, Platform, Share, StyleSheet, View } from "react-native";

import {
  ScreenAction,
  ScreenCard,
  ScreenContent,
  ScreenNote,
  ScreenRow,
  ScreenSection,
} from "@/components/screens/screen-ui";
import { useNavStatus } from "@/components/status/use-nav-status";
import { Icon } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { DeviceList } from "@/components/vehicle/device-list";
import { dash, fmt } from "@/components/vehicle/format";
import { usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import type { DiscoveredDevice } from "@/obd/types";
import {
  useDevSettings,
  useRuntime,
  useVehicleLinkSnapshot,
} from "@/providers/runtime-provider";

export default function VehicleScreen() {
  const { t } = useT();
  const params = useLocalSearchParams<{ emulators?: string }>();
  const { setDevSettings: setDev } = useRuntime();
  // `wtfai://vehicle?emulators=1` lists the simulated adapters: the emulator smoke test (scripts/android-smoke.sh)
  // has no Bluetooth and drives the real app against them. Same switch as Developer → Show emulated adapters.
  useEffect(() => {
    if (params.emulators === "1") setDev({ showEmulators: true });
  }, [params.emulators, setDev]);

  return (
    <ScreenContent title={t("vehicle")}>
      <CarDetails />
    </ScreenContent>
  );
}

function CarDetails() {
  const { t } = useT();
  const palette = usePalette();
  const { link } = useRuntime();
  const nav = useNavStatus();
  const snap = useVehicleLinkSnapshot();
  const { adapter, vehicle, stats } = snap;

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
  const active = snap.devices.find((d) => d.id === snap.activeDeviceId);
  const adapterName = adapter?.name ?? active?.name ?? remembered?.name ?? t("obdAdapter");
  const gattDump = snap.error?.code === "other" && snap.error.message?.startsWith("[") ? snap.error.message : null;
  const errorText = snap.error ? `${snap.error.code}${snap.error.message && !gattDump ? `: ${snap.error.message}` : ""}` : null;
  const caps = adapter?.capabilities;
  const capText = caps
    ? [caps.responseCount && "count", caps.adaptiveTiming2 && "AT2", caps.physicalAddressing && "ATSH"].filter(Boolean).join(", ") || dash
    : dash;

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
                onPress={() => void link.autoConnect()}
              />
            </View>
          ) : null}
        </View>
        {snap.activeDeviceId && (
          <>
            <ScreenRow labelKey="linkState" value={snap.link} />
            <ScreenRow labelKey="transport" value={adapter?.transport ?? dash} />
            <ScreenRow labelKey="elmVersion" value={adapter?.elmVersion ?? dash} />
            <ScreenRow labelKey="chip" value={adapter?.chip ?? adapter?.description ?? dash} />
            <ScreenRow labelKey="suspectedClone" value={adapter ? (adapter.suspectedClone ? t("yes") : t("no")) : dash} />
            <ScreenRow labelKey="batteryVoltage" value={fmt(adapter?.batteryV, 1, "V")} />
            <ScreenRow labelKey="obdProtocol" value={vehicle?.protocol ?? dash} />
            <ScreenRow labelKey="capabilities" value={capText} />
            <ScreenRow labelKey="gattProfile" value={adapter?.connected?.gatt?.profileId ?? adapter?.connected?.protocol ?? dash} />
          </>
        )}
        {errorText && <ScreenRow labelKey="lastError" value={errorText} valueColor={palette.bad.c} />}
      </ScreenCard>
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

      <ScreenSection title={t("odometry")}>
        <ScreenRow labelKey="vin" value={vehicle?.vin ?? dash} />
        <ScreenRow labelKey="odometryStage" value={t("odometryStageOne")} />
        <ScreenRow labelKey="yawSource" value={t("phoneGyro")} />
      </ScreenSection>

      <ScreenSection title={t("liveSignals")}>
        <ScreenRow labelKey="obdSpeed" value={snap.lastSpeed ? `${snap.lastSpeed.raw} km/h` : dash} />
        <ScreenRow labelKey="rpm" value={snap.lastRpm ? fmt(snap.lastRpm.rpm, 0) : dash} />
        <ScreenRow labelKey="engineState" value={snap.engine} />
        <ScreenRow labelKey="pollRate" value={fmt(stats?.speedHz, 1, "Hz")} />
        <ScreenRow labelKey="latency" value={stats ? `${fmt(stats.latencyP50Ms, 0)} / ${fmt(stats.latencyP95Ms, 0)} ms` : dash} />
        <ScreenRow labelKey="errorsPerMinute" value={stats ? String(stats.errorsLastMinute) : dash} />
        <ScreenRow labelKey="speedCap" value={stats ? fmt(stats.speedCapHz, 0, "Hz") : dash} />
      </ScreenSection>
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
