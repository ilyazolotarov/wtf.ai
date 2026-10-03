import { Host, Switch } from "@expo/ui";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import {
  ScreenAction,
  ScreenContent,
  ScreenRow,
  ScreenSection,
} from "@/components/screens/screen-ui";
import { useNavStatus } from "@/components/status/use-nav-status";
import { T } from "@/components/ui/text";
import { dash, fmt, fmtBytes, fmtDuration } from "@/components/vehicle/format";
import { usePalette } from "@/constants/theme";
import type { Strings } from "@/i18n/en";
import { useT } from "@/i18n/provider";
import { ekfMock } from "@/mocks";
import {
  useRecorderSnapshot,
  useRuntime,
  useSensorSnapshot,
  useVehicleLinkValue,
} from "@/providers/runtime-provider";

function CycleRow<T extends number | null>({
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

const EKF_ROWS = [
  ["E", "eastM"],
  ["N", "northM"],
  ["ψ", "headingRad"],
  ["v", "speedMps"],
  ["kₛ", "speedScale"],
  ["bω", "yawBias"],
  ["kω", "yawScale"],
] as const;

export default function DebugScreen() {
  const { t } = useT();
  const palette = usePalette();
  const nav = useNavStatus();
  const { position } = nav;
  const { link, recorder, sensors, getDevSettings, setDevSettings } = useRuntime();
  const rec = useRecorderSnapshot();
  const sensor = useSensorSnapshot();
  const speedHz = useVehicleLinkValue((s) => s.stats?.speedHz ?? null);
  const [clock, setClock] = useState(0);
  const [dev, setDev] = useState(getDevSettings());
  const [speedCap, setSpeedCap] = useState<number | null>(null);
  const [rpmPeriod, setRpmPeriod] = useState<number>(5);

  useEffect(() => {
    const interval = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const fixAge =
    position && clock ? `${Math.max(0, Math.floor((clock - position.timestamp) / 1000))} s` : dash;
  const heading =
    position?.headingRad == null ? dash : `${Math.round((position.headingRad * 180) / Math.PI)}°`;
  const recording = rec.state === "recording";

  return (
    <ScreenContent title={t("debug")}>
      <ScreenSection title={t("liveGnss")}>
        <ScreenRow labelKey="latitude" value={position?.lat.toFixed(6) ?? dash} />
        <ScreenRow labelKey="longitude" value={position?.lon.toFixed(6) ?? dash} />
        <ScreenRow labelKey="accuracy" value={position ? `${position.accuracyM.toFixed(1)} m` : dash} />
        <ScreenRow
          labelKey="speed"
          value={position?.speedMps == null ? dash : `${(position.speedMps * 3.6).toFixed(1)} km/h`}
        />
        <ScreenRow labelKey="heading" value={heading} />
        <ScreenRow labelKey="fixAge" value={fixAge} />
        <ScreenRow labelKey="gnssRate" value={sensor.gnssRunning ? fmt(sensor.gnssHz, 1, "Hz") : dash} />
      </ScreenSection>

      <ScreenSection title={t("integrity")}>
        <ScreenRow labelKey="recorderState" value={nav.trust} valueColor={nav.color.c} />
        <ScreenRow labelKey="positionSource" value={nav.source} />
      </ScreenSection>

      <ScreenSection title={t("tripRecorder")}>
        <ScreenRow labelKey="recorderState" value={rec.state} valueColor={recording ? palette.bad.c : undefined} />
        <ScreenRow labelKey="tripId" value={rec.current?.id ?? dash} />
        <ScreenRow labelKey="startReason" value={rec.current?.startReason ?? dash} />
        <ScreenRow labelKey="tripDuration" value={rec.current ? fmtDuration(rec.current.durationS) : dash} />
        <ScreenRow labelKey="fileSize" value={rec.current ? fmtBytes(rec.current.bytes) : dash} />
        <ScreenRow labelKey="distance" value={rec.current ? fmt(rec.current.distanceM / 1000, 2, "km") : dash} />
        <ScreenRow labelKey="obdPollRate" value={fmt(speedHz, 1, "Hz")} />
        {rec.lastError && <ScreenRow labelKey="lastError" value={rec.lastError} valueColor={palette.bad.c} />}
      </ScreenSection>
      <View style={styles.actions}>
        {recording ? (
          <>
            <ScreenAction labelKey="stopTrip" onPress={() => recorder.manualStop()} />
            <ScreenAction labelKey="addMarker" secondary onPress={() => recorder.marker()} />
          </>
        ) : (
          <ScreenAction labelKey="startManualTrip" onPress={() => recorder.manualStart()} />
        )}
        <View style={styles.row}>
          <View style={styles.flex}>
            <ScreenAction labelKey="trips" secondary compact onPress={() => router.push("/trips")} />
          </View>
          <View style={styles.flex}>
            <ScreenAction labelKey="elmTerminal" secondary compact onPress={() => router.push("/debug-terminal")} />
          </View>
        </View>
      </View>

      <ScreenSection title={t("sensors")}>
        <ScreenRow labelKey="accuracy" value={fmt(sensor.lastFix?.hAccM, 1, "m")} />
        <ScreenRow labelKey="speedAccuracy" value={fmt(sensor.lastFix?.speedAccMps, 2, "m/s")} />
        <ScreenRow labelKey="imuRate" value={sensor.imuRunning ? fmt(sensor.imuHz, 0, "Hz") : dash} />
        {sensor.lastError && <ScreenRow labelKey="lastError" value={sensor.lastError} valueColor={palette.bad.c} />}
      </ScreenSection>
      {sensor.permission !== "whenInUse" && sensor.permission !== "always" && (
        <ScreenAction labelKey="allowLocation" secondary onPress={() => void sensors.requestPermission()} />
      )}

      <ScreenSection title={t("ekfState")}>
        {EKF_ROWS.map(([label, key]) => (
          <ScreenRow key={key} label={label} value={ekfMock[key] ?? dash} />
        ))}
      </ScreenSection>

      <ScreenSection title={t("developerSettings")} plain>
        <Host matchContents>
          <Switch
            value={rec.settings.rawImu}
            onValueChange={(v) => recorder.updateSettings({ rawImu: v })}
            label={t("rawImu")}
          />
        </Host>
        <Host matchContents>
          <Switch
            value={rec.settings.imuRateHz === 100}
            onValueChange={(v) => recorder.updateSettings({ imuRateHz: v ? 100 : 50 })}
            label={t("imuRate100")}
          />
        </Host>
        <Host matchContents>
          <Switch
            value={dev.showEmulators}
            onValueChange={(v) => {
              setDevSettings({ showEmulators: v });
              setDev(getDevSettings());
            }}
            label={t("showEmulators")}
          />
        </Host>
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
    </ScreenContent>
  );
}

const styles = StyleSheet.create({
  cycle: { minHeight: 36, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  flex: { flex: 1 },
  actions: { gap: 10, marginTop: -6 },
  row: { flexDirection: "row", gap: 10 },
});
