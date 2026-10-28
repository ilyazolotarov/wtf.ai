import { StyleSheet, View } from "react-native";

import { ScreenCard, ScreenNote, SectionLabel, Segmented } from "@/components/screens/screen-ui";
import { SwitchRow } from "@/components/screens/setting-rows";
import { T } from "@/components/ui/text";
import { useT } from "@/i18n/provider";
import { SPEED_MARGINS_KPH, type SpeedMarginKph } from "@/nav/speed/speed-warning";
import { saveSpeedPreferences, useSpeedPreferences } from "@/services/speed-preferences";

/**
 * Settings → Speed (UI-SPEC §7.6): the limit's sign on the map, the speed camera warnings, and how far over a limit
 * the speed and a camera's card turn red.
 */
export function SpeedSettingsSection() {
  const { t } = useT();
  const { showLimit, cameras, marginKph } = useSpeedPreferences();
  return (
    <View style={styles.group}>
      <SectionLabel>{t("speedSection")}</SectionLabel>
      <ScreenCard style={styles.card}>
        <SwitchRow value={showLimit} onValueChange={(v) => saveSpeedPreferences({ showLimit: v })} label={t("speedLimitSetting")} />
        <ScreenNote>{t("speedLimitNote")}</ScreenNote>
        <SwitchRow value={cameras} onValueChange={(v) => saveSpeedPreferences({ cameras: v })} label={t("cameraSetting")} />
        <ScreenNote>{t("cameraNote")}</ScreenNote>
        {(showLimit || cameras) && (
          <>
            <T size={14}>{t("speedMarginSetting")}</T>
            <Segmented<string>
              value={String(marginKph)}
              onChange={(v) => saveSpeedPreferences({ marginKph: Number(v) as SpeedMarginKph })}
              options={SPEED_MARGINS_KPH.map((m) => ({ value: String(m), label: t("speedMarginOption").replace("{n}", String(m)) }))}
            />
            <ScreenNote>{t("speedMarginNote")}</ScreenNote>
          </>
        )}
      </ScreenCard>
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: 8 },
  card: { gap: 8 },
});
