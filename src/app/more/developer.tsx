import { router } from "expo-router";
import { useState } from "react";

import { ScreenAction, ScreenContent, ScreenSection } from "@/components/screens/screen-ui";
import { CycleRow, SwitchRow } from "@/components/screens/setting-rows";
import { useT } from "@/i18n/provider";
import type { MapMatchLoop } from "@/services/navigation/navigator-service";
import { useDevSettings, useRuntime, useVehicleLinkSnapshot } from "@/providers/runtime-provider";

/** Test switches and knobs; the trip recording ones live in the Trip recorder sheet. */
export default function DeveloperScreen() {
  const { t } = useT();
  const { link, setDevSettings } = useRuntime();
  const activeDeviceId = useVehicleLinkSnapshot().activeDeviceId;
  const dev = useDevSettings();
  const [speedCap, setSpeedCap] = useState<number | null>(null);
  const [rpmPeriod, setRpmPeriod] = useState<number>(5);

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
          value={dev.routeHint}
          onValueChange={(v) => setDevSettings({ routeHint: v })}
          label={t("routeHintSetting")}
        />
        <SwitchRow
          value={dev.phoneOnly}
          onValueChange={(v) => setDevSettings({ phoneOnly: v })}
          label={t("phoneOnlySetting")}
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
