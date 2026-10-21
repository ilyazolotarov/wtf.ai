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

// The onboarding step that keeps the position without opening the app (VEHICLE-LINK-SPEC §11), shown once: in the
// onboarding of a new install, and by itself to an install from before the step.
const WAKE_OFFERED_KEY = "wake-offered";

export function isWakeOffered(): boolean {
  try {
    return Storage.getItemSync(WAKE_OFFERED_KEY) === "1";
  } catch {
    return true;
  }
}

export function markWakeOffered(): void {
  Storage.setItemSync(WAKE_OFFERED_KEY, "1");
}

// iOS shows its "Change to Always Allow" once per install; asked again, it shows nothing and the answer is a refusal.
// Location never says it was asked (a new process reports "While Using" as not asked yet), so it is kept here.
const ALWAYS_ASKED_KEY = "location-always-asked";

export function isLocationAlwaysAsked(): boolean {
  try {
    return Storage.getItemSync(ALWAYS_ASKED_KEY) === "1";
  } catch {
    return false;
  }
}

export function markLocationAlwaysAsked(): void {
  Storage.setItemSync(ALWAYS_ASKED_KEY, "1");
}

// Store builds hide the Developer screen until seven taps on the version in Settings (docs/STORE-REVIEW.md §3):
// reviewers and drivers never meet test switches, a tester still can.
const DEVELOPER_KEY = "developer-unlocked";
const developerListeners = new Set<() => void>();

export function isDeveloperUnlocked(): boolean {
  try {
    return Storage.getItemSync(DEVELOPER_KEY) === "1";
  } catch {
    return false;
  }
}

export function unlockDeveloper(): void {
  Storage.setItemSync(DEVELOPER_KEY, "1");
  for (const listener of developerListeners) listener();
}

export function subscribeDeveloperUnlocked(listener: () => void): () => void {
  developerListeners.add(listener);
  return () => developerListeners.delete(listener);
}
