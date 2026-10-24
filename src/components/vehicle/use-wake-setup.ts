import * as Location from "expo-location";
import { useCallback, useEffect, useState } from "react";
import { Alert, AppState, Linking, PermissionsAndroid, Platform } from "react-native";

import SensorCaptureModule from "../../../modules/sensor-capture/src/SensorCaptureModule";
import VehicleLinkModule, { type NativeWakeDevice } from "../../../modules/vehicle-link/src/VehicleLinkModule";
import type { Strings } from "@/i18n/en";
import { useT } from "@/i18n/provider";
import { isLocationAlwaysAsked, isWakeOffered, markLocationAlwaysAsked, markWakeOffered } from "@/services/preferences";
import { autoConnect, getRuntime } from "@/services/runtime";
import { isClassicAdapter } from "@/services/vehicle-wake";

// The opt-in that keeps the driver's position when they forget to open the app (VEHICLE-LINK-SPEC §11), shared by the
// Vehicle screen and onboarding. Android 12+: the system's companion dialog (the car's Bluetooth, a BLE adapter), then
// location "all the time" so a trip the wake starts has GPS. iOS: location "Always", which lets iOS relaunch the app a
// few hundred metres into a drive. "All the time" / "Always" is asked for here only, never elsewhere.

export function wakeSupported(): boolean {
  if (Platform.OS === "ios") return SensorCaptureModule.setDriveWake !== undefined;
  return Platform.OS === "android" && (VehicleLinkModule.wakeSupported?.() ?? false);
}

/** Turned on already (iOS: the opt-in; Android: a device picked). */
function wakeOn(): boolean {
  if (Platform.OS === "ios") return SensorCaptureModule.driveWakeOn?.() ?? false;
  return (VehicleLinkModule.wakeDevices?.() ?? []).length > 0;
}

/** An install from before the onboarding step, not offered it yet and without it on: offered once by itself. */
export function wakeToOffer(): boolean {
  if (isWakeOffered() || !wakeSupported()) return false;
  if (wakeOn()) {
    markWakeOffered();
    return false;
  }
  return true;
}

/**
 * Says what to pick, then asks: Android opens its settings page, iOS shows its one-time "Change to Always Allow".
 * Asked before and refused, only the phone's settings can change it: they open instead, and the alert says where to
 * go there. True when granted.
 */
async function askLocationAlways(t: (key: keyof Strings) => string): Promise<boolean> {
  const ios = Platform.OS === "ios";
  const foreground = await Location.getForegroundPermissionsAsync();
  let settings = false;
  if (!foreground.granted) {
    if (!foreground.canAskAgain) settings = true;
    else if (!(await Location.requestForegroundPermissionsAsync()).granted) return false;
  }
  const now = await Location.getBackgroundPermissionsAsync();
  if (now.granted) return true;
  settings ||= !now.canAskAgain || (ios && isLocationAlwaysAsked());
  const body = settings
    ? ios
      ? "wakeLocationSettingsBodyIos"
      : "wakeLocationSettingsBody"
    : ios
      ? "wakeLocationBodyIos"
      : "wakeLocationBody";
  const go = await new Promise<boolean>((resolve) =>
    Alert.alert(
      t("wakeLocationTitle"),
      t(body),
      [
        { text: t("notNow"), style: "cancel", onPress: () => resolve(false) },
        { text: t("continue"), onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    ),
  );
  if (!go) return false;
  if (settings) {
    await Linking.openSettings();
    return false;
  }
  if (ios) markLocationAlwaysAsked();
  return (await Location.requestBackgroundPermissionsAsync()).granted;
}

/**
 * Android 13+: notifications, so the driver sees when the app has started by itself and is tracking the drive (the
 * trip's notification, with its Turn on GPS). Asked here, the opt-in that starts the app without the driver.
 */
async function askNotifications(): Promise<void> {
  if (Platform.OS !== "android" || Number(Platform.Version) < 33) return;
  await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => undefined);
}

export function useWakeSetup() {
  const { t } = useT();
  const supported = wakeSupported();
  const ios = Platform.OS === "ios";
  const readDevices = useCallback(
    (): NativeWakeDevice[] => (supported && !ios ? (VehicleLinkModule.wakeDevices?.() ?? []) : []),
    [supported, ios],
  );
  const [devices, setDevices] = useState<NativeWakeDevice[]>(readDevices);
  const [iosOn, setIosOn] = useState(() => ios && (SensorCaptureModule.driveWakeOn?.() ?? false));
  const [locationAlways, setLocationAlways] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const readLocation = useCallback(() => {
    if (!supported) return;
    Location.getBackgroundPermissionsAsync()
      .then((p) => setLocationAlways(p.granted))
      .catch(() => setLocationAlways(null));
  }, [supported]);

  const refresh = useCallback(() => {
    if (!supported) return;
    setDevices(readDevices());
    if (ios) setIosOn(SensorCaptureModule.driveWakeOn?.() ?? false);
    readLocation();
  }, [supported, ios, readDevices, readLocation]);

  // Back from the phone's settings (the driver may have changed the location setting there).
  useEffect(() => {
    readLocation();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => sub.remove();
  }, [refresh, readLocation]);

  /**
   * Android: the companion dialog, then "all the time"; true when a device was picked. iOS: "Always", then on (it
   * starts once "Always" is granted, also later in Settings). `adapterId`: the remembered adapter, offered in
   * Android's dialog when it is a BLE one.
   */
  const turnOn = async (adapterId: string | null): Promise<boolean> => {
    setBusy(true);
    try {
      if (ios) {
        await askLocationAlways(t).catch(() => false);
        await SensorCaptureModule.setDriveWake?.(true);
        return true;
      }
      // A connected BLE adapter doesn't advertise, and Android's dialog finds one only by its advertising: let go of it
      // while the dialog is open (never during a trip, whose speed it is), and connect again after.
      const { link, recorder } = getRuntime();
      const held = link.getSnapshot();
      const release =
        held.activeDeviceId !== null &&
        held.devices.find((d) => d.id === held.activeDeviceId)?.transport === "ble" &&
        recorder.getSnapshot().state !== "recording";
      if (release) await link.disconnect();
      let device: NativeWakeDevice | null;
      try {
        device = await (VehicleLinkModule.addWakeDevice?.(adapterId) ?? Promise.resolve(null)).catch(() => null);
      } finally {
        if (release) void autoConnect().catch(() => undefined);
      }
      if (!device) return false;
      // The OBD adapter itself, over Bluetooth Classic: it would never start the app.
      const snap = link.getSnapshot();
      const ids = [...snap.devices.map((d) => d.id), ...(snap.activeDeviceId ? [snap.activeDeviceId] : [])];
      if (isClassicAdapter(device.address, ids)) {
        VehicleLinkModule.forgetWakeDevice?.(device.address);
        Alert.alert(t("wakeAdapterPickedTitle"), t("wakeAdapterPickedBody"));
        return false;
      }
      await askNotifications();
      await askLocationAlways(t).catch(() => false);
      return true;
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const allowLocation = async () => {
    await askLocationAlways(t).catch(() => false);
    refresh();
  };

  const turnOff = async () => {
    if (ios) await SensorCaptureModule.setDriveWake?.(false);
    for (const d of devices) VehicleLinkModule.forgetWakeDevice?.(d.address);
    refresh();
  };

  const on = ios ? iosOn : devices.length > 0;
  return { supported, on, devices, locationAlways, busy, turnOn, turnOff, allowLocation };
}
