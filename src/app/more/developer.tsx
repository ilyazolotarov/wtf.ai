import { router } from "expo-router";
import { useState, useSyncExternalStore } from "react";
import { StyleSheet, TextInput, useColorScheme } from "react-native";

import { ScreenAction, ScreenContent, ScreenNote, ScreenSection } from "@/components/screens/screen-ui";
import { CycleRow, SwitchRow } from "@/components/screens/setting-rows";
import { INPUT_MAX_FONT_SCALE } from "@/components/ui/text";
import { Colors } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import type { MapMatchLoop } from "@/services/navigation/navigator-service";
import type { CanMode } from "@/services/runtime";
import type { CanAutoStatus } from "@/services/vehicle-link/can-auto-ids";
import type { Strings } from "@/i18n/en";
import { useDevSettings, useRuntime, useVehicleLinkSnapshot } from "@/providers/runtime-provider";

/** Test switches and knobs; the trip recording ones live in the Trip recorder sheet. */
export default function DeveloperScreen() {
  const { t } = useT();
  const runtime = useRuntime();
  const { setDevSettings } = runtime;
  const snapshot = useVehicleLinkSnapshot();
  const activeDeviceId = snapshot.activeDeviceId;
  const canShadow = snapshot.canShadow ?? null;
  const dev = useDevSettings();
  const canAuto = useSyncExternalStore(runtime.canAuto.subscribe, runtime.canAuto.status);
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
        <CycleRow
          labelKey="canMode"
          value={dev.can}
          options={["off", "log", "primary"] satisfies CanMode[]}
          format={(v) => t(v === "off" ? "canModeOff" : v === "log" ? "canModeLog" : "canModePrimary")}
          onChange={(v) => setDevSettings({ can: v })}
        />
        {dev.can === "primary" && (
          <SwitchRow value={dev.wheelYaw} onValueChange={(v) => setDevSettings({ wheelYaw: v })} label={t("wheelYawSetting")} />
        )}
        {dev.can !== "off" && (
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
        {dev.can !== "off" && !dev.canShadowIds.trim() && canAutoText(canAuto, t) && <ScreenNote>{canAutoText(canAuto, t)}</ScreenNote>}
        {dev.can !== "off" && canShadow && (
          <ScreenNote>
            {canShadow.state === "failed"
              ? `${t("canShadowFailed")}: ${canShadow.failure ?? ""}`
              : `${t(canShadow.state === "listening" ? "canShadowListening" : "canShadowWaiting")} · ${t("canShadowFrames")}: ${canShadow.frames}`}
          </ScreenNote>
        )}
        <CycleRow
          labelKey="speedCap"
          value={dev.speedCapHz}
          options={[null, 5, 10, 20, 30]}
          format={(v) => (v === null ? "auto" : `${v} Hz`)}
          onChange={(v) => setDevSettings({ speedCapHz: v })}
        />
        <CycleRow labelKey="rpmPeriod" value={dev.rpmPeriodS} options={[2, 5, 10]} format={(v) => `${v} s`} onChange={(v) => setDevSettings({ rpmPeriodS: v })} />
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

const hex = (ids: number[]) => ids.map((id) => id.toString(16).toUpperCase()).join(" ");

function canAutoText(s: CanAutoStatus, t: (key: keyof Strings) => string): string | null {
  switch (s.state) {
    case "off":
      return null;
    case "no-vin":
      return t("canAutoNoVin");
    case "unknown-make":
      return t("canAutoUnknown");
    case "probing":
      return `${t("canAutoProbing")} ${hex(s.ids)}`;
    case "chosen":
      return `${t("canAutoChosen")} ${hex(s.ids)} (${s.profile})`;
    case "none":
      return t("canAutoNone");
  }
}

const styles = StyleSheet.create({
  input: { minHeight: 48, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, fontSize: 16, fontFamily: "Menlo" },
});
