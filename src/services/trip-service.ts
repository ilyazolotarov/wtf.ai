import { Platform } from "react-native";

import SensorCaptureModule from "../../modules/sensor-capture/src/SensorCaptureModule";
import { stringsNow } from "@/i18n/strings-now";

// Android foreground service for a trip in progress (docs/ANDROID-SPEC.md §3 D): without it Android stops sensor
// delivery and Bluetooth I/O soon after the screen turns off. No-op on iOS (background modes) and web.

/** The notification's words in the app language (same rule as I18nProvider; this runs outside React). */
export function tripNotificationCopy(): { title: string; text: string; channel: string } {
  const strings = stringsNow();
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
