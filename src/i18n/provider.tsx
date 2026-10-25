import { getLocales, useLocales } from "expo-localization";
import Storage from "expo-sqlite/kv-store";
import * as React from "react";
import { useEffect, useState } from "react";

import { en, type Strings } from "@/i18n/en";
import { systemLanguage } from "@/i18n/system-language";
import { uk } from "@/i18n/uk";

export type LanguagePreference = "system" | "en" | "uk";

interface I18nContextValue {
  language: "en" | "uk";
  preference: LanguagePreference;
  setPreference(preference: LanguagePreference): Promise<void>;
  t(key: keyof Strings): string;
}

const I18nContext = React.createContext<I18nContextValue | null>(null);
const LANGUAGE_STORAGE_KEY = "language-preference";

export function I18nProvider({ children }: React.PropsWithChildren) {
  const locales = useLocales();
  const [preference, setPreferenceState] =
    useState<LanguagePreference>("system");

  const language = preference === "system" ? systemLanguage(locales) : preference;

  useEffect(() => {
    let active = true;
    void Storage.getItem(LANGUAGE_STORAGE_KEY).then((stored) => {
      if (
        active &&
        (stored === "system" || stored === "en" || stored === "uk")
      ) {
        setPreferenceState(stored);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const strings: Strings = language === "uk" ? uk : en;

  const setPreference = async (nextPreference: LanguagePreference) => {
    setPreferenceState(nextPreference);
    await Storage.setItem(LANGUAGE_STORAGE_KEY, nextPreference);
  };

  const value = React.useMemo(
    () => ({
      language,
      preference,
      setPreference,
      t: (key: keyof Strings) => strings[key],
    }),
    [language, preference, strings],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * The app's language and words outside React (the car screen's headless task): the stored preference, else the
 * system's, as `I18nProvider` picks them.
 */
export function appStrings(): { language: "en" | "uk"; t(key: keyof Strings): string } {
  const stored = Storage.getItemSync(LANGUAGE_STORAGE_KEY);
  const language = stored === "en" || stored === "uk" ? stored : systemLanguage(getLocales());
  const strings: Strings = language === "uk" ? uk : en;
  return { language, t: (key) => strings[key] };
}

export function useT(): I18nContextValue {
  const context = React.use(I18nContext);
  if (!context) throw new Error("useT must be used within I18nProvider");
  return context;
}
