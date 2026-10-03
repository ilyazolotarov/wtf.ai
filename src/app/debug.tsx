import { Host, Switch } from "@expo/ui";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, useColorScheme, View } from "react-native";

import {
  ScreenAction,
  ScreenContent,
  ScreenRow,
  ScreenSection,
  ScreenTitle,
} from "@/components/screens/screen-ui";
import { dash, fmt, fmtBytes, fmtDuration } from "@/components/vehicle/format";
import { Colors } from "@/constants/theme";
import type { Strings } from "@/i18n/en";
import { useT } from "@/i18n/provider";
import { ekfMock } from "@/mocks";
import { usePosition } from "@/providers/position-provider";
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
  const palette = Colors[useColorScheme() === "dark" ? "dark" : "light"];
  const next = () => onChange(options[(options.indexOf(value) + 1) % options.length]);
  return (
    <Pressable onPress={next} accessibilityRole="button" style={styles.cycle}>
      <Text style={[styles.cycleLabel, { color: palette.textSecondary }]}>{t(labelKey)}</Text>
      <Text style={styles.cycleValue}>{format(value)} ›</Text>
    </Pressable>
  );
}

export default function DebugScreen() {
  const { t } = useT();
  const position = usePosition();
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
    position && clock ? `${Math.max(0, Math.floor((clock - position.timestamp) / 1000))} s` : t("unavailableValue");
  const heading =
    position?.headingRad == null ? t("unavailableValue") : `${Math.round((position.headingRad * 180) / Math.PI)}°`;

  return (
    <ScreenContent>
      <ScreenTitle>{t("debug")}</ScreenTitle>

      <ScreenSection title={t("tripRecorder")}>
        <ScreenRow labelKey="recorderState" value={rec.state} valueColor={rec.state === "recording" ? "#C0392B" : undefined} />
        <ScreenRow labelKey="tripId" value={rec.current?.id ?? dash} />
        <ScreenRow labelKey="startReason" value={rec.current?.startReason ?? dash} />
        <ScreenRow labelKey="tripDuration" value={rec.current ? fmtDuration(rec.current.durationS) : dash} />
        <ScreenRow labelKey="fileSize" value={rec.current ? fmtBytes(rec.current.bytes) : dash} />
        <ScreenRow labelKey="distance" value={rec.current ? fmt(rec.current.distanceM / 1000, 2, "km") : dash} />
        <ScreenRow labelKey="obdPollRate" value={fmt(speedHz, 1, "Hz")} />
        {rec.lastError && <ScreenRow labelKey="lastError" value={rec.lastError} valueColor="#C0392B" />}
        {rec.state === "recording" ? (
          <>
            <ScreenAction labelKey="addMarker" secondary onPress={() => recorder.marker()} />
            <ScreenAction labelKey="stopTrip" onPress={() => recorder.manualStop()} />
          </>
        ) : (
          <ScreenAction labelKey="startManualTrip" onPress={() => recorder.manualStart()} />
        )}
        <ScreenAction labelKey="trips" secondary onPress={() => router.push("/trips")} />
        <ScreenAction labelKey="elmTerminal" secondary onPress={() => router.push("/debug-terminal")} />
      </ScreenSection>

      <ScreenSection title={t("sensors")}>
        <ScreenRow labelKey="gnssRate" value={sensor.gnssRunning ? fmt(sensor.gnssHz, 1, "Hz") : dash} />
        <ScreenRow labelKey="accuracy" value={fmt(sensor.lastFix?.hAccM, 1, "m")} />
        <ScreenRow labelKey="speedAccuracy" value={fmt(sensor.lastFix?.speedAccMps, 2, "m/s")} />
        <ScreenRow labelKey="imuRate" value={sensor.imuRunning ? fmt(sensor.imuHz, 0, "Hz") : dash} />
        {sensor.lastError && <ScreenRow labelKey="lastError" value={sensor.lastError} valueColor="#C0392B" />}
        {sensor.permission !== "whenInUse" && sensor.permission !== "always" && (
          <ScreenAction labelKey="allowLocation" secondary onPress={() => void sensors.requestPermission()} />
        )}
      </ScreenSection>

      <ScreenSection title={t("developerSettings")}>
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

      <ScreenSection title={t("liveGnss")}>
        <ScreenRow labelKey="latitude" value={position?.lat.toFixed(6) ?? t("unavailableValue")} />
        <ScreenRow labelKey="longitude" value={position?.lon.toFixed(6) ?? t("unavailableValue")} />
        <ScreenRow labelKey="accuracy" value={position ? `${position.accuracyM.toFixed(1)} m` : t("unavailableValue")} />
        <ScreenRow
          labelKey="speed"
          value={position?.speedMps == null ? t("unavailableValue") : `${(position.speedMps * 3.6).toFixed(1)} km/h`}
        />
        <ScreenRow labelKey="heading" value={heading} />
        <ScreenRow labelKey="fixAge" value={fixAge} />
      </ScreenSection>

      <ScreenSection title={t("integrity")}>
        <ScreenRow labelKey="integrity" value={position?.trust ?? t("unavailableValue")} />
      </ScreenSection>

      <ScreenSection title={t("ekfState")}>
        <View style={styles.ekf}>
          {(["eastM", "northM", "headingRad", "speedMps", "speedScale", "yawBias", "yawScale"] as const).map((k) => (
            <Text key={k} style={styles.ekfItem}>
              {k}: {ekfMock[k] ?? t("unavailableValue")}
            </Text>
          ))}
        </View>
      </ScreenSection>
    </ScreenContent>
  );
}

const styles = StyleSheet.create({
  cycle: { minHeight: 36, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  cycleLabel: { flex: 1, fontSize: 14 },
  cycleValue: { color: "#176FA9", fontSize: 14, fontWeight: "600" },
  ekf: { gap: 4 },
  ekfItem: { fontSize: 13, color: "#888" },
});
