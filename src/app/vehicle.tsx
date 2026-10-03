import { Link } from "expo-router";
import { useEffect } from "react";
import { Alert, Share } from "react-native";

import {
  ScreenAction,
  ScreenContent,
  ScreenNote,
  ScreenRow,
  ScreenSection,
  ScreenTitle,
} from "@/components/screens/screen-ui";
import { DeviceList } from "@/components/vehicle/device-list";
import { dash, fmt } from "@/components/vehicle/format";
import { useT } from "@/i18n/provider";
import type { DiscoveredDevice } from "@/obd/types";
import { useRuntime, useVehicleLinkSnapshot } from "@/providers/runtime-provider";

export default function VehicleScreen() {
  const { t } = useT();
  const { link } = useRuntime();
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

  const gattDump = snap.error?.code === "other" && snap.error.message?.startsWith("[") ? snap.error.message : null;
  const caps = adapter?.capabilities;
  const capText = caps
    ? [caps.responseCount && "count", caps.adaptiveTiming2 && "AT2", caps.physicalAddressing && "ATSH"].filter(Boolean).join(", ") || dash
    : dash;

  return (
    <ScreenContent>
      <ScreenTitle>{t("vehicle")}</ScreenTitle>

      <ScreenSection title={t("adapters")}>
        <DeviceList devices={snap.devices} activeId={snap.activeDeviceId} onSelect={select} />
        <ScreenAction
          labelKey={snap.discovering ? "stopScan" : "scan"}
          secondary
          onPress={() => (snap.discovering ? link.stopDiscovery() : link.startDiscovery())}
        />
        <ScreenAction labelKey="pairMfi" secondary onPress={() => void link.pairMfi()} />
      </ScreenSection>

      {snap.activeDeviceId && (
        <ScreenSection title={t("connectedAdapter")}>
          <ScreenRow labelKey="linkState" value={snap.link} />
          <ScreenRow labelKey="adapterModel" value={adapter?.name ?? dash} />
          <ScreenRow labelKey="transport" value={adapter?.transport ?? dash} />
          <ScreenRow labelKey="elmVersion" value={adapter?.elmVersion ?? dash} />
          <ScreenRow labelKey="chip" value={adapter?.chip ?? adapter?.description ?? dash} />
          <ScreenRow labelKey="suspectedClone" value={adapter ? (adapter.suspectedClone ? t("yes") : t("no")) : dash} />
          <ScreenRow labelKey="batteryVoltage" value={fmt(adapter?.batteryV, 1, "V")} />
          <ScreenRow labelKey="obdProtocol" value={vehicle?.protocol ?? dash} />
          <ScreenRow labelKey="vin" value={vehicle?.vin ?? dash} />
          <ScreenRow labelKey="capabilities" value={capText} />
          <ScreenRow labelKey="gattProfile" value={adapter?.connected?.gatt?.profileId ?? adapter?.connected?.protocol ?? dash} />
          {snap.error && <ScreenRow labelKey="lastError" value={`${snap.error.code}${snap.error.message && !gattDump ? `: ${snap.error.message}` : ""}`} valueColor="#C0392B" />}
          {gattDump && <ScreenAction labelKey="copyGattDump" secondary onPress={() => void Share.share({ message: gattDump })} />}
          <ScreenAction labelKey="disconnect" secondary onPress={() => void link.disconnect()} />
          <ScreenAction labelKey="forget" secondary onPress={() => link.forget(snap.activeDeviceId!)} />
        </ScreenSection>
      )}

      {!snap.activeDeviceId && snap.error && (
        <ScreenSection>
          <ScreenRow labelKey="lastError" value={`${snap.error.code}${snap.error.message && !gattDump ? `: ${snap.error.message}` : ""}`} valueColor="#C0392B" />
          {gattDump && <ScreenAction labelKey="copyGattDump" secondary onPress={() => void Share.share({ message: gattDump })} />}
        </ScreenSection>
      )}

      <ScreenSection title={t("liveSignals")}>
        <ScreenRow labelKey="obdSpeed" value={snap.lastSpeed ? `${snap.lastSpeed.raw} km/h` : dash} />
        <ScreenRow labelKey="rpm" value={snap.lastRpm ? fmt(snap.lastRpm.rpm, 0) : dash} />
        <ScreenRow labelKey="engineState" value={snap.engine} />
        <ScreenRow labelKey="pollRate" value={fmt(stats?.speedHz, 1, "Hz")} />
        <ScreenRow labelKey="latency" value={stats ? `${fmt(stats.latencyP50Ms, 0)} / ${fmt(stats.latencyP95Ms, 0)} ms` : dash} />
        <ScreenRow labelKey="errorsPerMinute" value={stats ? String(stats.errorsLastMinute) : dash} />
        <ScreenRow labelKey="speedCap" value={stats ? fmt(stats.speedCapHz, 0, "Hz") : dash} />
        <Link href="/debug-terminal" asChild>
          <ScreenAction labelKey="elmTerminal" secondary disabled={!snap.activeDeviceId} />
        </Link>
      </ScreenSection>

      <ScreenSection title={t("odometry")}>
        <ScreenRow labelKey="odometryStage" value={t("odometryStageOne")} />
        <ScreenRow labelKey="yawSource" value={t("phoneGyro")} />
      </ScreenSection>
      <ScreenNote>{t("tripsHint")}</ScreenNote>
    </ScreenContent>
  );
}
