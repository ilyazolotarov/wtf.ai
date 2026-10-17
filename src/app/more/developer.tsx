import { router } from "expo-router";

import { ScreenAction, ScreenContent, ScreenSection } from "@/components/screens/screen-ui";
import { CycleRow, SwitchRow } from "@/components/screens/setting-rows";
import { useT } from "@/i18n/provider";
import { useDevSettings, useRuntime, useVehicleLinkSnapshot } from "@/providers/runtime-provider";

/** Test switches and knobs; the trip recording ones live in the Trip recorder sheet. */
export default function DeveloperScreen() {
  const { t } = useT();
  const { setDevSettings } = useRuntime();
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
    </ScreenContent>
  );
}
