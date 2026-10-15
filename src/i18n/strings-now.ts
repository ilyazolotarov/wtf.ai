import { getLocales } from "expo-localization";
import Storage from "expo-sqlite/kv-store";

import { en, type Strings } from "@/i18n/en";
import { systemLanguage } from "@/i18n/system-language";
import { uk } from "@/i18n/uk";

const LANGUAGE_KEY = "language-preference";

/** The app's strings outside React (notifications): the same rule as I18nProvider. */
export function stringsNow(): Strings {
  const preference = Storage.getItemSync(LANGUAGE_KEY); // stored as a plain string by I18nProvider
  const language = preference === "uk" || preference === "en" ? preference : systemLanguage(getLocales());
  return language === "uk" ? uk : en;
}
