import { geoSearchText } from "@/nav/search/geo-uri";

const MAP_LINK = /^(?:geo|google\.navigation|waze|dgis):/i;

/**
 * Links from other apps (SEARCH-SPEC §4.6): a `geo:`, `google.navigation:`, `waze:` or `dgis:` link (Android's "open
 * with" a navigator; a taxi driver app's navigate button) opens the route screen with its place or words searched.
 * Anything else is the app's own (`wtfai://…`), as it came.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    if (!MAP_LINK.test(path)) return path;
    const text = geoSearchText(path);
    return text ? `/route?q=${encodeURIComponent(text)}` : "/route";
  } catch {
    return path;
  }
}
