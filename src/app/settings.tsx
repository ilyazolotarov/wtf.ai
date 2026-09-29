import { Host, List, ListItem, Picker } from "@expo/ui";
import Constants from "expo-constants";

import {
    ScreenContent,
    ScreenNote,
    ScreenRow,
    ScreenSection,
    ScreenTitle,
} from "@/components/screens/screen-ui";
import { useT } from "@/i18n/provider";

export default function SettingsScreen() {
  const { t, preference, setPreference } = useT();
  return (
    <ScreenContent>
      <ScreenTitle>{t("settings")}</ScreenTitle>
      <ScreenSection>
        <Host>
          <List>
            <ListItem
              leading={t("language")}
              trailing={
                <Picker
                  selectedValue={preference}
                  onValueChange={(value) =>
                    void setPreference(value as "system" | "en" | "uk")
                  }
                >
                  <Picker.Item label={t("systemLanguage")} value="system" />
                  <Picker.Item label={t("englishLanguage")} value="en" />
                  <Picker.Item label={t("ukrainianLanguage")} value="uk" />
                </Picker>
              }
            />
          </List>
        </Host>
      </ScreenSection>
      <ScreenSection title={t("appearance")}>
        <ScreenRow labelKey="appearance" value={t("followsSystem")} />
      </ScreenSection>
      <ScreenSection title={t("privacy")}>
        <ScreenNote>{t("privacyMessage")}</ScreenNote>
      </ScreenSection>
      <ScreenSection title={t("about")}>
        <ScreenRow
          labelKey="appVersion"
          value={Constants.expoConfig?.version ?? t("unavailableValue")}
        />
      </ScreenSection>
    </ScreenContent>
  );
}
