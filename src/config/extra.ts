import Constants from "expo-constants";

/**
 * A string from app.config.js's `extra`, or null. Only a non-empty string counts: Android release builds embed the
 * config with `null` turned into `{}` (seen 2026-10-14: the map catalog fetched `[object Object]/maps/latest.json`),
 * and an object would switch a feature on.
 */
export function extraString(key: string): string | null {
  const value = (Constants.expoConfig?.extra as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" && value !== "" ? value : null;
}
