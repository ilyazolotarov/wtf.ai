import { AppRegistry, Platform } from "react-native";

import SensorCaptureModule from "../../modules/sensor-capture/src/SensorCaptureModule";
import { stringsNow } from "@/i18n/strings-now";
import type { ShareNotice } from "./position-share/position-share-service";

// Android foreground service for a trip in progress (docs/ANDROID-SPEC.md §3 D): without it Android stops sensor
// delivery and Bluetooth I/O soon after the screen turns off. No-op on iOS (background modes) and web.

/**
 * The headless task the service holds while it runs (sensor-capture's JsKeepAlive): React Native fires JS timers with
 * the app behind another one only while such a task runs, and the OBD poller and the navigator's tick are timers. It
 * never finishes by itself; the service ends it.
 */
export const TRIP_KEEP_ALIVE_TASK = "WtfTripKeepAlive";
if (Platform.OS === "android") AppRegistry.registerHeadlessTask(TRIP_KEEP_ALIVE_TASK, () => () => new Promise<void>(() => undefined));

/**
 * The notification's words in the app language (same rule as I18nProvider; this runs outside React). With `notice`,
 * what sharing the car's position with other navigators does (§8).
 */
export function tripNotificationCopy(notice: ShareNotice | null = null): { title: string; text: string; channel: string; gps: string } {
  const strings = stringsNow();
  const trip = { channel: strings.tripNotificationChannel, gps: strings.tripNotificationGps };
  if (!notice) return { title: strings.tripNotificationTitle, text: strings.tripNotificationText, ...trip };
  const text = {
    gps: strings.shareNoticeGps,
    car: strings.shareNoticeCar,
    uncertain: strings.shareNoticeUncertain,
    waiting: strings.shareNoticeWaiting,
    failed: strings.shareNoticeFailed,
  }[notice];
  // Not sharing is told under the trip's own title: the notification is still the trip's.
  return { title: notice === "failed" ? strings.tripNotificationTitle : strings.shareNotificationTitle, text, ...trip };
}

/** The notice on the notification now: the service started again (the app back in front) keeps it. */
let shownNotice: ShareNotice | null = null;

/** New words on the running trip notification; false when it isn't showing (no service yet, or not Android). */
export function updateTripNotification(notice: ShareNotice | null): boolean {
  if (Platform.OS !== "android") return false;
  try {
    const copy = tripNotificationCopy(notice);
    const shown = SensorCaptureModule.updateTripService?.(copy.title, copy.text, copy.channel) ?? false;
    if (shown) shownNotice = notice;
    return shown;
  } catch {
    return false;
  }
}

/** Starts or stops the service; resolves true when it is running afterwards. Never throws. */
export async function setTripService(running: boolean): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  try {
    if (running) {
      const copy = tripNotificationCopy(shownNotice);
      return (await SensorCaptureModule.startTripService?.(copy.title, copy.text, copy.channel, copy.gps)) ?? false;
    }
    shownNotice = null;
    await SensorCaptureModule.stopTripService?.();
    return false;
  } catch {
    return false;
  }
}
