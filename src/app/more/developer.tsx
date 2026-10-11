import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, TextInput, useColorScheme } from "react-native";

import { ScreenAction, ScreenContent, ScreenNote, ScreenSection } from "@/components/screens/screen-ui";
import { CycleRow, SwitchRow } from "@/components/screens/setting-rows";
import { INPUT_MAX_FONT_SCALE } from "@/components/ui/text";
import { Colors } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import type { MapMatchLoop } from "@/services/navigation/navigator-service";
import { useDevSettings, useRuntime, useVehicleLinkSnapshot } from "@/providers/runtime-provider";

/** Test switches and knobs; the trip recording ones live in the Trip recorder sheet. */
export default function DeveloperScreen() {
  const { t } = useT();
  const { link, setDevSettings } = useRuntime();
  const snapshot = useVehicleLinkSnapshot();
  const activeDeviceId = snapshot.activeDeviceId;
  const canShadow = snapshot.canShadow ?? null;
  const dev = useDevSettings();
  const [speedCap, setSpeedCap] = useState<number | null>(null);
  const [rpmPeriod, setRpmPeriod] = useState<number>(5);
  const [canIds, setCanIds] = useState(dev.canShadowIds);
  const palette = Colors[useColorScheme() === "dark" ? "dark" : "light"];

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
        <SwitchRow value={dev.canShadow} onValueChange={(v) => setDevSettings({ canShadow: v })} label={t("canShadowSetting")} />
        {dev.canShadow && (
          <TextInput
            value={canIds}
            onChangeText={setCanIds}
            onEndEditing={() => setDevSettings({ canShadowIds: canIds })}
            placeholder={t("canShadowIds")}
            placeholderTextColor={palette.textSecondary}
            autoCapitalize="characters"
            autoCorrect={false}
            maxFontSizeMultiplier={INPUT_MAX_FONT_SCALE}
            style={[styles.input, { color: palette.text, borderColor: palette.textSecondary }]}
          />
        )}
        {dev.canShadow && canShadow && (
          <ScreenNote>
            {canShadow.state === "failed"
              ? `${t("canShadowFailed")}: ${canShadow.failure ?? ""}`
              : `${t(canShadow.state === "listening" ? "canShadowListening" : "canShadowWaiting")} · ${canShadow.frames} ${t("canShadowFrames")}`}
          </ScreenNote>
        )}
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

const styles = StyleSheet.create({
  input: { minHeight: 48, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, fontSize: 16, fontFamily: "Menlo" },
});
