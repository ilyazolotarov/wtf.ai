import { Host, Switch } from "@expo/ui";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Linking, Platform, Pressable, Share, StyleSheet, View } from "react-native";

import {
  ScreenAction,
  ScreenCard,
  ScreenContent,
  ScreenNote,
  ScreenRow,
  ScreenSection,
  Segmented,
} from "@/components/screens/screen-ui";
import { useNavStatus } from "@/components/status/use-nav-status";
import { Icon } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { DeviceList } from "@/components/vehicle/device-list";
import { dash, fmt, fmtBytes, fmtDuration } from "@/components/vehicle/format";
import { usePalette } from "@/constants/theme";
import type { Strings } from "@/i18n/en";
import { useT } from "@/i18n/provider";
import type { MapMatchLoop } from "@/services/navigation/navigator-service";
import type { DiscoveredDevice } from "@/obd/types";
import {
  useDevSettings,
  useRecorderSnapshot,
  useRuntime,
  useSensorSnapshot,
  useVehicleLinkSnapshot,
} from "@/providers/runtime-provider";

type Tab = "car" | "position" | "recorder" | "developer";
const TABS: Tab[] = ["car", "position", "recorder", "developer"];

export default function VehicleScreen() {
  const { t } = useT();
  const params = useLocalSearchParams<{ tab?: string; emulators?: string }>();
  const { setDevSettings: setDev } = useRuntime();
  // `wtfai://vehicle?emulators=1` lists the simulated adapters: the emulator smoke test (scripts/android-smoke.sh)
  // has no Bluetooth and drives the real app against them. Same switch as Developer → Show emulated adapters.
  useEffect(() => {
    if (params.emulators === "1") setDev({ showEmulators: true });
  }, [params.emulators, setDev]);
  const [tab, setTab] = useState<Tab>(TABS.find((x) => x === params.tab) ?? "car");

  return (
    <ScreenContent
      title={t("vehicle")}
      scrollKey={tab}
      tabs={
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: "car", label: t("tabCar") },
            { value: "position", label: t("tabPosition") },
            { value: "recorder", label: t("tabRecorder") },
            { value: "developer", label: t("tabDeveloper") },
          ]}
        />
      }
    >
      {tab === "car" && <CarTab />}
      {tab === "position" && <PositionTab />}
      {tab === "recorder" && <RecorderTab />}
      {tab === "developer" && <DeveloperTab />}
    </ScreenContent>
  );
}

function CarTab() {
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
            <T w="semibold" size={16} numberOfLines={1}>
              {adapterName}
            </T>
            <T size={13} color={nav.adapterColor}>
              {nav.adapterLabel}
            </T>
          </View>
          {snap.activeDeviceId ? (
            <ScreenAction
              // Still waiting for the adapter to show up (auto-connect, a reconnect): stopping that isn't a disconnect.
              labelKey={snap.link === "connecting" || snap.link === "reconnecting" ? "stopSearching" : "disconnect"}
              secondary
              compact
              onPress={() => void link.disconnect()}
            />
          ) : remembered ? (
            <ScreenAction
              labelKey="connect"
              compact
              disabled={nav.adapter === "searching"}
              onPress={() => void link.autoConnect()}
            />
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

function PositionTab() {
  const { t } = useT();
  const palette = usePalette();
  const nav = useNavStatus();
  const { position } = nav;
  const { sensors, position: navigator, routes } = useRuntime();
  const sensor = useSensorSnapshot();
  // Ticks every second while this tab is up; also re-reads the EKF below.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const fixAge = position ? `${Math.max(0, Math.floor((clock - position.timestamp) / 1000))} s` : dash;
  const heading =
    position?.headingRad == null ? dash : `${Math.round((position.headingRad * 180) / Math.PI)}°`;
  const ekf = navigator.getDebug();
  const routing = routes.getDebug();
  const route = routes.getSnapshot();
  const num = (v: number | null, digits: number, unit = "") => (v === null ? dash : `${v.toFixed(digits)}${unit}`);

  return (
    <>
      <ScreenSection title={t("integrity")}>
        <ScreenRow labelKey="recorderState" value={nav.trust} valueColor={nav.color.c} />
        <ScreenRow labelKey="positionSource" value={nav.source} />
      </ScreenSection>

      <ScreenSection title={t("liveGnss")}>
        <ScreenRow labelKey="latitude" value={position?.lat.toFixed(6) ?? dash} />
        <ScreenRow labelKey="longitude" value={position?.lon.toFixed(6) ?? dash} />
        <ScreenRow labelKey="accuracy" value={position ? `${position.accuracyM.toFixed(1)} m` : dash} />
        <ScreenRow labelKey="speedAccuracy" value={fmt(sensor.lastFix?.speedAccMps, 2, "m/s")} />
        <ScreenRow
          labelKey="speed"
          value={position?.speedMps == null ? dash : `${(position.speedMps * 3.6).toFixed(1)} km/h`}
        />
        <ScreenRow labelKey="heading" value={heading} />
        <ScreenRow labelKey="fixAge" value={fixAge} />
        <ScreenRow labelKey="gnssRate" value={sensor.gnssRunning ? fmt(sensor.gnssHz, 1, "Hz") : dash} />
        <ScreenRow labelKey="imuRate" value={sensor.imuRunning ? fmt(sensor.imuHz, 0, "Hz") : dash} />
        {sensor.lastError && <ScreenRow labelKey="lastError" value={sensor.lastError} valueColor={palette.bad.c} />}
      </ScreenSection>
      {sensor.permission !== "whenInUse" && sensor.permission !== "always" && (
        <ScreenAction labelKey="allowLocation" secondary onPress={() => void sensors.requestPermission()} />
      )}

      <ScreenSection title={t("ekfState")}>
        <ScreenRow label="mode" value={`${ekf.mode}${ekf.source ? ` · ${ekf.source}` : ""}`} />
        <ScreenRow label="ψ σ" value={num(ekf.headingSigmaDeg, 1, "°")} />
        <ScreenRow label="kₛ" value={ekf.speedScale === null ? dash : `${ekf.speedScale.toFixed(4)} ±${ekf.speedScaleSigma!.toFixed(4)}`} />
        <ScreenRow label="bω" value={num(ekf.gyroBiasDegS, 4, " °/s")} />
        <ScreenRow label="kω" value={num(ekf.gyroScale, 4)} />
        <ScreenRow label="GNSS lag" value={`${num(ekf.gnssLagS, 2, " s")}${ekf.gnssLagWindows ? ` (${ekf.gnssLagWindows} turns)` : ""}`} />
        <ScreenRow label="parked pose" value={ekf.parkedPose} />
        <ScreenRow
          label="compass (shadow)"
          value={`${ekf.compassTrust}${ekf.compassOffDeg === null ? "" : ` · ${ekf.compassOffDeg.toFixed(0)}° off`}`}
        />
      </ScreenSection>

      <ScreenSection title={t("mapMatching")}>
        <ScreenRow label="road graph" value={ekf.mapMatchRegion ?? dash} />
        <ScreenRow label="feeds back" value={t(ekf.mapMatchLoop === "open" ? "loopOpen" : ekf.mapMatchLoop === "heading" ? "loopHeading" : "loopClosed")} />
        {ekf.mapMatchLoop !== "open" && (
          <ScreenRow
            label="road corrections"
            value={ekf.roadHeading && ekf.roadPosition
              ? `heading ${ekf.roadHeading.accepted} · position ${ekf.roadPosition.accepted}` +
                (ekf.roadHeading.rejected + ekf.roadPosition.rejected ? ` · ${ekf.roadHeading.rejected + ekf.roadPosition.rejected} refused` : "")
              : dash}
          />
        )}
        <ScreenRow
          label="state"
          value={ekf.mapMatch ? `${ekf.mapMatch.state} · ${ekf.mapMatch.particles} particles` : ekf.mapMatchRegion ? "off" : dash}
        />
        <ScreenRow
          label="hypotheses"
          value={ekf.mapMatch?.clusters.length ? ekf.mapMatch.clusters.map((c) => `${Math.round(c.weight * 100)}%`).join(" · ") : dash}
        />
        <ScreenRow label="update (last)" value={ekf.mapMatch && ekf.mapMatchTiming ? `${ekf.mapMatch.updateMs.toFixed(2)} ms` : dash} />
        {/* Every update this drive; the target is under 5 ms at p99 (MAPMATCH-SPEC §14), judged from 100 updates on
            (fewer make p99 the slowest one). */}
        <ScreenRow
          label="update p50 / p99"
          value={ekf.mapMatchTiming ? `${ekf.mapMatchTiming.p50Ms.toFixed(2)} / ${ekf.mapMatchTiming.p99Ms.toFixed(2)} ms` : dash}
        />
        <ScreenRow
          label="slowest · over 5 ms"
          value={ekf.mapMatchTiming ? `${ekf.mapMatchTiming.maxMs.toFixed(1)} ms · ${ekf.mapMatchTiming.overBudget} of ${ekf.mapMatchTiming.count}` : dash}
          valueColor={ekf.mapMatchTiming && ekf.mapMatchTiming.count >= 100 && ekf.mapMatchTiming.p99Ms > 5 ? palette.bad.c : undefined}
        />
        {/* Starts apart: the first reads the roads around the car from storage, once a drive. */}
        <ScreenRow
          label="starts · slowest"
          value={ekf.mapMatchStarts ? `${ekf.mapMatchStarts.count} · ${ekf.mapMatchStarts.maxMs.toFixed(1)} ms` : dash}
        />
        <ScreenRow
          label="share of time"
          value={ekf.mapMatchTiming ? `${(ekf.mapMatchTiming.share * 100).toFixed(2)} %` : dash}
        />
      </ScreenSection>

      {/* Routing on this phone (ROUTING-SPEC §8.2): the last plan's cost, and guidance now. */}
      <ScreenSection title={t("routing")}>
        <ScreenRow label="plans" value={routing.plans ? String(routing.plans) : dash} />
        <ScreenRow
          label="last plan"
          value={routing.last ? `#${routing.last.id} ${routing.last.reason} · ${routing.last.outcome === "done" ? `${((routing.last.lengthM ?? 0) / 1000).toFixed(1)} km` : routing.last.outcome}` : dash}
          valueColor={routing.last && routing.last.outcome !== "done" ? palette.bad.c : undefined}
        />
        <ScreenRow
          label="planning · wall"
          value={routing.last ? `${Math.round(routing.last.planMs)} ms · ${Math.round(routing.last.wallMs)} ms` : dash}
        />
        <ScreenRow
          label="states · tiles · slices"
          value={routing.last ? `${routing.last.states} · ${routing.last.tiles} · ${routing.last.slices}` : dash}
        />
        <ScreenRow label="slice size" value={`${routing.sliceStates} states`} />
        <ScreenRow
          label="guidance"
          value={route?.guidance ? `${route.guidance.state} · ${Number.isFinite(route.guidance.offM) ? `${Math.round(route.guidance.offM)} m off` : "no match"}` : route ? route.status : dash}
        />
      </ScreenSection>
    </>
  );
}

function RecorderTab() {
  const { t } = useT();
  const palette = usePalette();
  const { recorder } = useRuntime();
  const rec = useRecorderSnapshot();
  const recording = rec.state === "recording";

  return (
    <>
      <ScreenSection title={t("tripRecorder")}>
        <ScreenRow labelKey="recorderState" value={rec.state} valueColor={recording ? palette.bad.c : undefined} />
        <ScreenRow labelKey="tripId" value={rec.current?.id ?? dash} />
        <ScreenRow labelKey="startReason" value={rec.current?.startReason ?? dash} />
        <ScreenRow labelKey="tripDuration" value={rec.current ? fmtDuration(rec.current.durationS) : dash} />
        <ScreenRow labelKey="fileSize" value={rec.current ? fmtBytes(rec.current.bytes) : dash} />
        <ScreenRow labelKey="distance" value={rec.current ? fmt(rec.current.distanceM / 1000, 2, "km") : dash} />
        {rec.lastError && <ScreenRow labelKey="lastError" value={rec.lastError} valueColor={palette.bad.c} />}
      </ScreenSection>
      <View style={styles.stack}>
        {recording ? (
          <>
            <ScreenAction labelKey="stopTrip" onPress={() => recorder.manualStop()} />
            <ScreenAction labelKey="addMarker" secondary onPress={() => recorder.marker()} />
          </>
        ) : (
          <ScreenAction labelKey="startManualTrip" onPress={() => recorder.manualStart()} />
        )}
        <ScreenAction labelKey="trips" secondary onPress={() => router.push("/trips")} />
      </View>
      <ScreenNote>{t("tripsHint")}</ScreenNote>
    </>
  );
}

function CycleRow<T extends number | string | null>({
  labelKey,
  value,
  options,
  format,
  onChange,
}: {
  labelKey: keyof Strings;
  value: T;
  options: T[];
  format: (v: T) => string;
  onChange: (v: T) => void;
}) {
  const { t } = useT();
  const palette = usePalette();
  const next = () => onChange(options[(options.indexOf(value) + 1) % options.length]);
  return (
    <Pressable onPress={next} accessibilityRole="button" style={styles.cycle}>
      <T size={14} color={palette.text2} style={styles.flex}>
        {t(labelKey)}
      </T>
      <T w="semibold" size={14} color={palette.accent}>
        {format(value)} ›
      </T>
    </Pressable>
  );
}

/** Label wraps beside the switch; a label inside the native switch overflows the card. */
function SwitchRow({ value, onValueChange, label }: { value: boolean; onValueChange: (v: boolean) => void; label: string }) {
  const palette = usePalette();
  return (
    <View style={styles.switchRow}>
      <T size={14} color={palette.text} style={styles.flex}>
        {label}
      </T>
      <Host matchContents>
        <Switch value={value} onValueChange={onValueChange} />
      </Host>
    </View>
  );
}

function DeveloperTab() {
  const { t } = useT();
  const { link, recorder, setDevSettings } = useRuntime();
  const rec = useRecorderSnapshot();
  const activeDeviceId = useVehicleLinkSnapshot().activeDeviceId;
  const dev = useDevSettings();
  const [speedCap, setSpeedCap] = useState<number | null>(null);
  const [rpmPeriod, setRpmPeriod] = useState<number>(5);

  return (
    <>
      <ScreenSection title={t("developerSettings")} plain>
        <SwitchRow
          value={rec.settings.rawImu}
          onValueChange={(v) => recorder.updateSettings({ rawImu: v })}
          label={t("rawImu")}
        />
        <SwitchRow
          value={rec.settings.imuRateHz === 100}
          onValueChange={(v) => recorder.updateSettings({ imuRateHz: v ? 100 : 50 })}
          label={t("imuRate100")}
        />
        <SwitchRow
          value={dev.showEmulators}
          onValueChange={(v) => setDevSettings({ showEmulators: v })}
          label={t("showEmulators")}
        />
        <SwitchRow
          value={dev.showParticles}
          onValueChange={(v) => setDevSettings({ showParticles: v })}
          label={t("showParticles")}
        />
        <SwitchRow
          value={dev.outageButton}
          onValueChange={(v) => setDevSettings({ outageButton: v })}
          label={t("outageButton")}
        />
        <SwitchRow
          value={dev.routeHint}
          onValueChange={(v) => setDevSettings({ routeHint: v })}
          label={t("routeHintSetting")}
        />
        <CycleRow
          labelKey="speedCap"
          value={speedCap}
          options={[null, 5, 10, 20, 30]}
          format={(v) => (v === null ? "auto" : `${v} Hz`)}
          onChange={(v) => {
            setSpeedCap(v);
            link.setSpeedCapOverride(v);
          }}
        />
        <CycleRow
          labelKey="rpmPeriod"
          value={rpmPeriod}
          options={[2, 5, 10]}
          format={(v) => `${v} s`}
          onChange={(v) => {
            setRpmPeriod(v);
            link.setRpmPeriods({ rpmPeriodRunningMs: v * 1000 });
          }}
        />
        <CycleRow
          labelKey="mapMatchLoop"
          value={dev.mapMatchLoop}
          options={["open", "heading", "closed"] satisfies MapMatchLoop[]}
          format={(v) => t(v === "open" ? "loopOpen" : v === "heading" ? "loopHeading" : "loopClosed")}
          onChange={(v) => setDevSettings({ mapMatchLoop: v })}
        />
        <CycleRow
          labelKey="parkedTimeout"
          value={rec.settings.parkedTimeoutMin}
          options={[1, 3, 5, 10]}
          format={(v) => `${v} min`}
          onChange={(v) => recorder.updateSettings({ parkedTimeoutMin: v })}
        />
        <CycleRow
          labelKey="lingerTime"
          value={rec.settings.lingerMin}
          options={[5, 15, 30]}
          format={(v) => `${v} min`}
          onChange={(v) => recorder.updateSettings({ lingerMin: v })}
        />
      </ScreenSection>
      <ScreenAction
        labelKey="elmTerminal"
        secondary
        disabled={!activeDeviceId}
        onPress={() => router.push("/debug-terminal")}
      />
    </>
  );
}

const styles = StyleSheet.create({
  adapterCard: { flexDirection: "row", alignItems: "center", gap: 14, marginBottom: 4 },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  adapterTile: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  adapterCopy: { flex: 1, gap: 2 },
  actions: { flexDirection: "row", gap: 10, marginTop: -6 },
  stack: { gap: 10, marginTop: -6 },
  flex: { flex: 1 },
  cycle: { minHeight: 36, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
});
