import Storage from "expo-sqlite/kv-store";
import { Appearance } from "react-native";

export type AppearancePreference = "system" | "light" | "dark";

const APPEARANCE_KEY = "appearance-preference";
const ONBOARDING_KEY = "onboarding-done";

export function loadAppearance(): AppearancePreference {
  try {
    const stored = Storage.getItemSync(APPEARANCE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

/**
 * The OS scheme at launch, read before `applyAppearance` overrides it (after that,
 * `Appearance` reports the override). The native splash is drawn in this scheme.
 */
export const launchSystemScheme: "light" | "dark" =
  Appearance.getColorScheme() === "dark" ? "dark" : "light";

/** Overrides `useColorScheme()` app-wide, native sheets included. */
export function applyAppearance(preference: AppearancePreference): void {
  Appearance.setColorScheme(preference === "system" ? "unspecified" : preference);
}

export function setAppearance(preference: AppearancePreference): void {
  applyAppearance(preference);
  Storage.setItemSync(APPEARANCE_KEY, preference);
}

export function isOnboardingDone(): boolean {
  try {
    return Storage.getItemSync(ONBOARDING_KEY) === "1";
  } catch {
    return true;
  }
}

export function markOnboardingDone(): void {
  Storage.setItemSync(ONBOARDING_KEY, "1");
}
