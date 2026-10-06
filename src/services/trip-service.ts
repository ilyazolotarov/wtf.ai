import { Platform } from "react-native";

import SensorCaptureModule from "../../modules/sensor-capture/src/SensorCaptureModule";
import { en } from "@/i18n/en";
import { uk } from "@/i18n/uk";
import { getLocales } from "expo-localization";
import Storage from "expo-sqlite/kv-store";

// Android foreground service for a trip in progress (docs/ANDROID-SPEC.md §3 D): without it Android stops sensor
// delivery and Bluetooth I/O soon after the screen turns off. No-op on iOS (background modes) and web.

const LANGUAGE_KEY = "language-preference";

/** The notification's words in the app language (same rule as I18nProvider; this runs outside React). */
export function tripNotificationCopy(): { title: string; text: string; channel: string } {
  const preference = Storage.getItemSync(LANGUAGE_KEY); // stored as a plain string by I18nProvider
  const language = preference === "uk" || preference === "en" ? preference : getLocales()[0]?.languageCode === "uk" ? "uk" : "en";
  const strings = language === "uk" ? uk : en;
  return { title: strings.tripNotificationTitle, text: strings.tripNotificationText, channel: strings.tripNotificationChannel };
}

/** Starts or stops the service; resolves true when it is running afterwards. Never throws. */
export async function setTripService(running: boolean): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  try {
    if (running) {
      const copy = tripNotificationCopy();
      return (await SensorCaptureModule.startTripService?.(copy.title, copy.text, copy.channel)) ?? false;
    }
    await SensorCaptureModule.stopTripService?.();
    return false;
  } catch {
    return false;
  }
}
