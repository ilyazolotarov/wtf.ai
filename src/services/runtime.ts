// App-lifetime services (vehicle link, sensors, trip recorder). Created once, independent of
// screens, so recording keeps running while the UI is backgrounded (TRIP-LOGGER-SPEC §4.3).

import Constants from "expo-constants";
import * as Device from "expo-device";
import { Platform } from "react-native";

import VehicleLinkModule from "../../modules/vehicle-link/src/VehicleLinkModule";
import { Sentry } from "@/config/sentry";
import { createClock } from "@/obd/clock";
import { VehicleLinkCore } from "@/obd/vehicle-link-core";

import { kvStore } from "./kv-store";
import { SensorService } from "./sensor-capture/sensor-service";
import { createTripFiles } from "./trip-recorder/trip-files";
import { TripRecorder } from "./trip-recorder/trip-recorder";
import { NativeDiscovery } from "./vehicle-link/discovery";
import { DrivingEmulator } from "./vehicle-link/driving-emulator";
import { NativeTransport } from "./vehicle-link/native-transport";

export interface DevSettings {
  showEmulators: boolean;
}

const DEV_SETTINGS_KEY = "dev.settings";

export interface Runtime {
  link: VehicleLinkCore;
  sensors: SensorService;
  recorder: TripRecorder;
  getDevSettings(): DevSettings;
  setDevSettings(patch: Partial<DevSettings>): void;
}

let runtime: Runtime | null = null;

export function getRuntime(): Runtime {
  if (runtime) return runtime;

  let dev: DevSettings = { showEmulators: __DEV__, ...(kvStore.getJson<Partial<DevSettings>>(DEV_SETTINGS_KEY) ?? {}) };
  const nowUs = () => VehicleLinkModule.nowUs();
  const clock = createClock(nowUs);

  const link = new VehicleLinkCore({
    clock,
    store: kvStore,
    discovery: new NativeDiscovery(() => dev.showEmulators),
    createTransport: (device, remembered) =>
      device.transport === "emulator"
        ? new DrivingEmulator(device.id, clock)
        : new NativeTransport(device.id, device.transport, remembered),
  });
  const sensors = new SensorService();
  const recorder = new TripRecorder({
    link,
    sensors,
    files: createTripFiles(),
    store: kvStore,
    nowUs,
    appInfo: () => ({
      sys_name: "wtf.ai",
      ver_sw: `${Constants.expoConfig?.version ?? "?"} (${Constants.nativeBuildVersion ?? "dev"})`,
      sys_hw: Device.modelId ?? Device.modelName ?? "unknown",
      sys_os_ver: `${Platform.OS} ${Device.osVersion ?? ""}`.trim(),
    }),
  });
  recorder.start();

  // Breadcrumbs give crash reports context; scrubbing removes VINs/coordinates (src/config/sentry-scrub.ts).
  link.onLinkEvent((e) => {
    Sentry.addBreadcrumb({ category: "vehicle-link", message: e.detail ? `${e.type}: ${e.detail}` : e.type, level: e.type === "error" ? "error" : "info" });
    if (e.type === "error" || e.type === "probe-failed") Sentry.captureMessage(`vehicle-link ${e.type}: ${e.detail ?? ""}`, "warning");
  });
  recorder.events.on((message) => {
    Sentry.addBreadcrumb({ category: "trip-recorder", message });
    if (message.startsWith("recorder error")) Sentry.captureMessage(message, "error");
  });

  runtime = {
    link,
    sensors,
    recorder,
    getDevSettings: () => dev,
    setDevSettings: (patch) => {
      dev = { ...dev, ...patch };
      kvStore.setJson(DEV_SETTINGS_KEY, dev);
    },
  };
  return runtime;
}

/** Auto-connect to the remembered adapter without triggering a permission prompt (§7). */
export async function autoConnect(): Promise<void> {
  const { link } = getRuntime();
  if (link.getSnapshot().activeDeviceId) return;
  if (Platform.OS !== "ios") return;
  if (VehicleLinkModule.getBluetoothState() === "notDetermined") return;
  await VehicleLinkModule.initialize(null);
  await link.autoConnect();
}
