import { router } from "expo-router";
import { Alert } from "react-native";

import { ScreenAction, ScreenContent, ScreenSection } from "@/components/screens/screen-ui";
import { CycleRow, SwitchRow } from "@/components/screens/setting-rows";
import { useT } from "@/i18n/provider";
import { useDevSettings, useRuntime, useVehicleLinkSnapshot } from "@/providers/runtime-provider";
import { resetFirmwareAsked } from "@/services/vehicle-link/firmware-notice";
import SensorCaptureModule from "../../../modules/sensor-capture/src/SensorCaptureModule";

/** The trip log is flushed every second: the marker reaches the file before the process ends. */
const KILL_AFTER_MARKER_MS = 1500;

/** Test switches and knobs; the trip recording ones live in the Trip recorder sheet. */
export default function DeveloperScreen() {
  const { t } = useT();
  const { setDevSettings, recorder } = useRuntime();
  const activeDeviceId = useVehicleLinkSnapshot().activeDeviceId;
  const dev = useDevSettings();

  return (
    <ScreenContent title={t("developer")}>
      <ScreenSection title={t("developerSettings")} plain>
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
          value={dev.phoneOnly}
          onValueChange={(v) => setDevSettings({ phoneOnly: v })}
          label={t("phoneOnlySetting")}
        />
        <CycleRow labelKey="rpmPeriod" value={dev.rpmPeriodS} options={[2, 5, 10]} format={(v) => `${v} s`} onChange={(v) => setDevSettings({ rpmPeriodS: v })} />
      </ScreenSection>
      <ScreenAction
        labelKey="elmTerminal"
        secondary
        disabled={!activeDeviceId}
        onPress={() => router.push("/debug-terminal")}
      />
      <ScreenAction labelKey="uiGallery" secondary onPress={() => router.push("/more/ui-gallery")} />
      {/* Ends the process as the OS would (TRIP-LOGGER-SPEC §4.3): the relaunch paths, tried on a drive. */}
      <ScreenAction
        labelKey="simulateKill"
        secondary
        onPress={() =>
          Alert.alert(t("simulateKill"), t("simulateKillBody"), [
            { text: t("cancel"), style: "cancel" },
            {
              text: t("simulateKillGo"),
              style: "destructive",
              onPress: () => {
                recorder.marker("developer: the app ended as the system would");
                setTimeout(() => SensorCaptureModule.simulateSystemKill(), KILL_AFTER_MARKER_MS);
              },
            },
          ])
        }
      />
      {/* Every adapter new again: the firmware check opens at the next connect (VEHICLE-LINK-SPEC §8.4). */}
      <ScreenAction
        labelKey="fwResetAsked"
        secondary
        onPress={() => {
          resetFirmwareAsked();
          Alert.alert(t("fwResetAsked"), t("fwResetAskedDone"));
        }}
      />
    </ScreenContent>
  );
}
