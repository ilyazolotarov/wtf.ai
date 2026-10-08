/**
 * The app language for the "system" preference: the first of the user's languages (in their order, iOS and Android
 * alike) that the app speaks. Russian counts as Ukrainian: a Russian-speaking driver here reads Ukrainian, not
 * English. Neither: English.
 */
export function systemLanguage(locales: readonly { languageCode: string | null }[]): "en" | "uk" {
  for (const { languageCode } of locales) {
    if (languageCode === "uk" || languageCode === "ru") return "uk";
    if (languageCode === "en") return "en";
  }
  return "en";
}
