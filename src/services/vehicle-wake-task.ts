// What runs when the system starts the app for a drive (VEHICLE-LINK-SPEC §11), with no screen: Android's headless task
// when a companion device appears (index.ts registers it), and iOS's relaunch for location "Always" a few hundred
// metres into a drive. The runtime and Sentry start here.

import { AppState } from "react-native";

import VehicleLinkModule from "../../modules/vehicle-link/src/VehicleLinkModule";
import { initSentry } from "@/config/sentry";
import { autoConnect, getRuntime } from "@/services/runtime";
import { runWake, type WakeState } from "@/services/vehicle-wake";
import { isHeldForUpdater } from "@/services/vehicle-link/firmware-notice";

export async function vehicleWakeTask(data: { how?: string } | undefined): Promise<void> {
  initSentry();
  const { link, recorder, health } = getRuntime();
  await runWake(data?.how ?? "device appeared", {
    // Into Sentry's logs too: a wake that records no trip leaves no trip log (ANDROID-SPEC §4.1).
    note: (text) => {
      recorder.note(text);
      console.info(text);
    },
    woken: (how) => health.woken(how),
    connect: autoConnect,
    state: (): WakeState => {
      if (recorder.getSnapshot().state === "recording") return "recording";
      const snap = link.getSnapshot();
      if (snap.link === "error") return { gone: `link error (${snap.error?.code ?? "unknown"})` };
      if (snap.activeDeviceId) return "waiting";
      // Why autoConnect left it: the same checks, in its order.
      if (isHeldForUpdater()) return { gone: "the adapter is held for a firmware update" };
      if (VehicleLinkModule.getBluetoothState() === "notDetermined") return { gone: "no Bluetooth permission" };
      return { gone: "no adapter remembered" };
    },
    subscribe: (listener) => {
      const offRecorder = recorder.subscribe(listener);
      const offLink = link.subscribe(listener);
      return () => {
        offRecorder();
        offLink();
      };
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
}

/**
 * iOS relaunched the app on the way: GNSS keeps it running in the background while the adapter connects and a trip
 * starts (the trip then keeps it). If none starts in the wait, GNSS stops again, unless the driver has the app open.
 */
export async function iosDriveWake(): Promise<void> {
  initSentry();
  const { position } = getRuntime();
  void position.start();
  try {
    await vehicleWakeTask({ how: "location" });
  } finally {
    if (AppState.currentState !== "active") position.stop();
  }
}
