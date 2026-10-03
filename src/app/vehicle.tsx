import { router } from "expo-router";
import { useEffect } from "react";
import { Alert, Share, StyleSheet, View } from "react-native";

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
import { useRuntime, useVehicleLinkSnapshot } from "@/providers/runtime-provider";

export default function VehicleScreen() {
  const { t } = useT();
  const palette = usePalette();
  const { link } = useRuntime();
  const nav = useNavStatus();
  const snap = useVehicleLinkSnapshot();
  const { adapter, vehicle, stats } = snap;

  useEffect(() => {
    link.startDiscovery();
    return () => link.stopDiscovery();
  }, [link]);

  const select = (device: DiscoveredDevice) => {
    if (device.id === snap.activeDeviceId) return;
    const go = () => void link.connect(device.id);
    if (device.rank === "unknown" || device.rank === "non-elm") {
      Alert.alert(device.name ?? device.id, t("tryAnyway"), [
        { text: t("no"), style: "cancel" },
        { text: t("yes"), onPress: go },
      ]);
    } else {
      go();
    }
  };

  const pairMfi = () =>
    link.pairMfi().catch((e: { code?: string; message?: string }) =>
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
    <ScreenContent title={t("vehicle")}>
      <ScreenCard style={styles.adapterCard}>
        <View style={[styles.adapterTile, { backgroundColor: nav.adapterTint }]}>
          <Icon name="bluetooth" size={24} color={nav.adapterColor} />
        </View>
        <View style={styles.adapterCopy}>
          <T w="semibold" size={16} numberOfLines={1}>
            {adapterName}
          </T>
          <T size={13} color={nav.adapterColor}>
            {nav.adapterLabel}
          </T>
        </View>
        {snap.activeDeviceId ? (
          <ScreenAction labelKey="disconnect" secondary compact onPress={() => void link.disconnect()} />
        ) : remembered ? (
          <ScreenAction
            labelKey="connect"
            compact
            disabled={nav.adapter === "searching"}
            onPress={() => void link.autoConnect()}
          />
        ) : null}
      </ScreenCard>

      <ScreenSection title={t("adapters")} plain>
        <DeviceList devices={snap.devices} activeId={snap.activeDeviceId} onSelect={select} />
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

      {snap.activeDeviceId && (
        <ScreenSection title={t("connectedAdapter")}>
          <ScreenRow labelKey="linkState" value={snap.link} />
          <ScreenRow labelKey="transport" value={adapter?.transport ?? dash} />
          <ScreenRow labelKey="elmVersion" value={adapter?.elmVersion ?? dash} />
          <ScreenRow labelKey="chip" value={adapter?.chip ?? adapter?.description ?? dash} />
          <ScreenRow labelKey="suspectedClone" value={adapter ? (adapter.suspectedClone ? t("yes") : t("no")) : dash} />
          <ScreenRow labelKey="batteryVoltage" value={fmt(adapter?.batteryV, 1, "V")} />
          <ScreenRow labelKey="obdProtocol" value={vehicle?.protocol ?? dash} />
          <ScreenRow labelKey="capabilities" value={capText} />
          <ScreenRow labelKey="gattProfile" value={adapter?.connected?.gatt?.profileId ?? adapter?.connected?.protocol ?? dash} />
          {errorText && <ScreenRow labelKey="lastError" value={errorText} valueColor={palette.bad.c} />}
        </ScreenSection>
      )}
      {!snap.activeDeviceId && errorText && (
        <ScreenSection>
          <ScreenRow labelKey="lastError" value={errorText} valueColor={palette.bad.c} />
        </ScreenSection>
      )}
      {gattDump && (
        <ScreenAction labelKey="copyGattDump" secondary onPress={() => void Share.share({ message: gattDump })} />
      )}
      {snap.activeDeviceId && (
        <ScreenAction labelKey="forget" secondary onPress={() => link.forget(snap.activeDeviceId!)} />
      )}

      <ScreenSection title={t("odometry")}>
        <ScreenRow labelKey="vin" value={vehicle?.vin ?? dash} />
        <ScreenRow labelKey="odometryStage" value={t("odometryStageOne")} />
      </ScreenSection>

      <ScreenSection title={t("liveSignals")}>
        <ScreenRow labelKey="obdSpeed" value={snap.lastSpeed ? `${snap.lastSpeed.raw} km/h` : dash} />
        <ScreenRow labelKey="rpm" value={snap.lastRpm ? fmt(snap.lastRpm.rpm, 0) : dash} />
        <ScreenRow labelKey="engineState" value={snap.engine} />
        <ScreenRow labelKey="pollRate" value={fmt(stats?.speedHz, 1, "Hz")} />
        <ScreenRow labelKey="latency" value={stats ? `${fmt(stats.latencyP50Ms, 0)} / ${fmt(stats.latencyP95Ms, 0)} ms` : dash} />
        <ScreenRow labelKey="errorsPerMinute" value={stats ? String(stats.errorsLastMinute) : dash} />
        <ScreenRow labelKey="speedCap" value={stats ? fmt(stats.speedCapHz, 0, "Hz") : dash} />
        <ScreenRow labelKey="yawSource" value={t("phoneGyro")} />
      </ScreenSection>
      <ScreenAction
        labelKey="elmTerminal"
        secondary
        disabled={!snap.activeDeviceId}
        onPress={() => router.push("/debug-terminal")}
      />
      <ScreenNote>{t("tripsHint")}</ScreenNote>
    </ScreenContent>
  );
}

const styles = StyleSheet.create({
  adapterCard: { flexDirection: "row", alignItems: "center", gap: 14 },
  adapterTile: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  adapterCopy: { flex: 1, gap: 2 },
  actions: { flexDirection: "row", gap: 10, marginTop: -6 },
  flex: { flex: 1 },
});
