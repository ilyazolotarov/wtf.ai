import Constants from "expo-constants";
import { useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";

import {
    ScreenAction,
    ScreenCard,
    ScreenContent,
    ScreenNote,
    ScreenRow,
    ScreenSection,
    SectionLabel,
    Segmented,
} from "@/components/screens/screen-ui";
import { VoiceVolumeSection } from "@/components/route/voice-volume-section";
import { SwitchRow } from "@/components/screens/setting-rows";
import { privacyPolicyUrl, STORE_BUILD, SUPPORT_EMAIL } from "@/config/distribution";
import { appCode } from "@/components/update/app-code";
import { Icon } from "@/components/ui/icon";
import { installId } from "@/services/telemetry";
import { T } from "@/components/ui/text";
import { usePalette } from "@/constants/theme";
import { useT, type LanguagePreference } from "@/i18n/provider";
import { useDevSettings, useRuntime } from "@/providers/runtime-provider";
import {
    isDeveloperUnlocked,
    loadAppearance,
    setAppearance,
    unlockDeveloper,
    type AppearancePreference,
} from "@/services/preferences";

/** Taps on the version that show the Developer screen in a store build. */
const DEVELOPER_TAPS = 7;

export default function SettingsScreen() {
  const { t, language, preference, setPreference } = useT();
  const palette = usePalette();
  const { setDevSettings } = useRuntime();
  const settings = useDevSettings();
  const [appearance, setAppearanceState] = useState(loadAppearance);
  const policyUrl = privacyPolicyUrl(language);
  const versionTaps = useRef(0);
  const [developerShown, setDeveloperShown] = useState(false);
  const tapVersion = () => {
    if (!STORE_BUILD || isDeveloperUnlocked() || ++versionTaps.current < DEVELOPER_TAPS) return;
    unlockDeveloper();
    setDeveloperShown(true);
  };

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
      {/* The car's own sensors through the adapter (VEHICLE-LINK-SPEC §16.3, NAVIGATOR-SPEC §5.4). */}
      <View style={styles.group}>
        <SectionLabel>{t("vehicle")}</SectionLabel>
        <ScreenCard style={styles.car}>
          <SwitchRow
            value={settings.wheelSpeed}
            onValueChange={(v) => setDevSettings({ wheelSpeed: v })}
            label={t("wheelSpeedSetting")}
          />
          <ScreenNote>{t("wheelSpeedNote")}</ScreenNote>
          {settings.wheelSpeed && (
            <>
              <SwitchRow
                value={settings.wheelYaw}
                onValueChange={(v) => setDevSettings({ wheelYaw: v })}
                label={t("wheelYawSetting")}
              />
              <ScreenNote>{t("wheelYawNote")}</ScreenNote>
              <SwitchRow
                value={settings.carReports}
                onValueChange={(v) => setDevSettings({ carReports: v })}
                label={t("carReportsSetting")}
              />
              <ScreenNote>{t("carReportsNote")}</ScreenNote>
            </>
          )}
        </ScreenCard>
      </View>
      <View style={styles.group}>
        <SectionLabel>{t("privacy")}</SectionLabel>
        <ScreenCard style={styles.privacy}>
          <Icon name="lock" size={20} color={palette.ok.c} />
          <T size={14} style={styles.privacyText}>
            {t(STORE_BUILD ? "privacyMessageStore" : "privacyMessage")}
          </T>
        </ScreenCard>
        {policyUrl && (
          <ScreenAction
            labelKey="privacyPolicy"
            icon="open_in_new"
            secondary
            compact
            onPress={() => void Linking.openURL(policyUrl)}
          />
        )}
      </View>
      <ScreenSection title={t("about")}>
        {/* The build number beside the version: what App update and AltStore name a build by. */}
        <Pressable onPress={tapVersion} accessible={false}>
          <ScreenRow
            labelKey="appVersion"
            value={
              (Constants.expoConfig?.version ?? t("unavailableValue")) +
              (Constants.nativeBuildVersion ? ` (${Constants.nativeBuildVersion})` : "")
            }
          />
        </Pressable>
        {developerShown && <ScreenNote>{t("developerUnlocked")}</ScreenNote>}
        <ScreenRow labelKey="appCode" value={appCode(t)} />
        <ScreenRow labelKey="supportCode" value={installId()} />
        <ScreenRow labelKey="mapData" value="© OpenStreetMap contributors · © OpenMapTiles" />
      </ScreenSection>
      {SUPPORT_EMAIL && (
        <ScreenAction
          labelKey="contactSupport"
          icon="open_in_new"
          secondary
          compact
          // The support code and version in the subject: they find the reports and the build behind the question.
          onPress={() =>
            void Linking.openURL(
              `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
                `wtf.ai ${Constants.expoConfig?.version ?? ""} (${Constants.nativeBuildVersion ?? "dev"}) · ${installId()}`,
              )}`,
            )
          }
        />
      )}
    </ScreenContent>
  );
}

const styles = StyleSheet.create({
  group: { gap: 8 },
  car: { gap: 8 },
  privacy: { flexDirection: "row", gap: 12 },
  privacyText: { flex: 1, lineHeight: 20 },
});
