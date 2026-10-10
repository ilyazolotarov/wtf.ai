import Constants from "expo-constants";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import {
    ScreenCard,
    ScreenContent,
    ScreenRow,
    ScreenSection,
    SectionLabel,
    Segmented,
} from "@/components/screens/screen-ui";
import { VoiceVolumeSection } from "@/components/route/voice-volume-section";
import { appCode } from "@/components/update/app-code";
import { Icon } from "@/components/ui/icon";
import { installId } from "@/services/telemetry";
import { T } from "@/components/ui/text";
import { usePalette } from "@/constants/theme";
import { useT, type LanguagePreference } from "@/i18n/provider";
import {
    loadAppearance,
    setAppearance,
    type AppearancePreference,
} from "@/services/preferences";

export default function SettingsScreen() {
  const { t, preference, setPreference } = useT();
  const palette = usePalette();
  const [appearance, setAppearanceState] = useState(loadAppearance);

  return (
    <ScreenContent title={t("settings")}>
      <View style={styles.group}>
        <SectionLabel>{t("language")}</SectionLabel>
        <Segmented<LanguagePreference>
          value={preference}
          onChange={(value) => void setPreference(value)}
          options={[
            { value: "system", label: t("systemLanguage") },
            { value: "en", label: t("englishLanguage") },
            { value: "uk", label: t("ukrainianLanguage") },
          ]}
        />
      </View>
      <View style={styles.group}>
        <SectionLabel>{t("appearance")}</SectionLabel>
        <Segmented<AppearancePreference>
          value={appearance}
          onChange={(value) => {
            setAppearanceState(value);
            setAppearance(value);
          }}
          options={[
            { value: "system", label: t("systemLanguage") },
            { value: "light", label: t("lightAppearance") },
            { value: "dark", label: t("darkAppearance") },
          ]}
        />
      </View>
      <VoiceVolumeSection />
      <View style={styles.group}>
        <SectionLabel>{t("privacy")}</SectionLabel>
        <ScreenCard style={styles.privacy}>
          <Icon name="lock" size={20} color={palette.ok.c} />
          <T size={14} style={styles.privacyText}>
            {t("privacyMessage")}
          </T>
        </ScreenCard>
      </View>
      <ScreenSection title={t("about")}>
        <ScreenRow
          labelKey="appVersion"
          value={Constants.expoConfig?.version ?? t("unavailableValue")}
        />
        <ScreenRow labelKey="appCode" value={appCode(t)} />
        <ScreenRow labelKey="supportCode" value={installId()} />
        <ScreenRow labelKey="mapData" value="© OpenStreetMap contributors · © OpenMapTiles" />
      </ScreenSection>
    </ScreenContent>
  );
}

const styles = StyleSheet.create({
  group: { gap: 8 },
  privacy: { flexDirection: "row", gap: 12 },
  privacyText: { flex: 1, lineHeight: 20 },
});
