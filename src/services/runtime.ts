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
import { CalibrationStore } from "./navigation/calibration-store";
import { NavigatorService, type MapMatchLoop } from "./navigation/navigator-service";
import { activeRoadGraph } from "./offline-map/road-graph-file";
import { SensorService } from "./sensor-capture/sensor-service";
import { createTripFiles } from "./trip-recorder/trip-files";
import { TripRecorder } from "./trip-recorder/trip-recorder";
import { NativeDiscovery } from "./vehicle-link/discovery";
import { DrivingEmulator } from "./vehicle-link/driving-emulator";
import { NativeTransport } from "./vehicle-link/native-transport";

export interface DevSettings {
  showEmulators: boolean;
  /** Map matching's particles and hypotheses on the map. */
  showParticles: boolean;
  /** A "Cut GPS" button on the map that simulates a GNSS outage. */
  outageButton: boolean;
  /** How map matching feeds back into the navigator (MAPMATCH-SPEC §9): open (today), heading, closed. */
  mapMatchLoop: MapMatchLoop;
}

const DEV_SETTINGS_KEY = "dev.settings";

export interface Runtime {
  link: VehicleLinkCore;
  sensors: SensorService;
  recorder: TripRecorder;
  /** The map's position: the navigator (NAVIGATOR-SPEC §9), or phone GNSS without an OBD adapter. */
  position: NavigatorService;
  getDevSettings(): DevSettings;
  setDevSettings(patch: Partial<DevSettings>): void;
  subscribeDevSettings(listener: () => void): () => void;
}

let runtime: Runtime | null = null;

export function getRuntime(): Runtime {
  if (runtime) return runtime;

  let dev: DevSettings = { showEmulators: __DEV__, showParticles: false, outageButton: false, mapMatchLoop: "open", ...(kvStore.getJson<Partial<DevSettings>>(DEV_SETTINGS_KEY) ?? {}) };
  const devListeners = new Set<() => void>();
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
  const sysHw = Device.modelId ?? Device.modelName ?? "unknown";
  const sysOsVer = `${Platform.OS} ${Device.osVersion ?? ""}`.trim();
  const recorder = new TripRecorder({
    link,
    sensors,
    files: createTripFiles(),
    store: kvStore,
    nowUs,
    appInfo: () => ({
      sys_name: "wtf.ai",
      ver_sw: `${Constants.expoConfig?.version ?? "?"} (${Constants.nativeBuildVersion ?? "dev"})`,
      sys_hw: sysHw,
      sys_os_ver: sysOsVer,
      // The navigator version this drive starts with (a change mid-drive is a note).
      nav_mapmatch_loop: dev.mapMatchLoop,
    }),
  });
  recorder.start();

  const position = new NavigatorService({
    sensors,
    link,
    // The GNSS lag is stored per phone model and iOS version (NAVIGATOR-SPEC §7.4).
    calibration: new CalibrationStore(kvStore, { model: sysHw, os: sysOsVer }),
    nowUs,
    note: (text) => recorder.note(text),
    log: (record) => recorder.navEstimate(record),
    logMapMatch: (record) => recorder.navMapMatch(record),
    // Map matching on the active offline region's road graph (MAPMATCH-SPEC §11).
    roadGraph: activeRoadGraph,
  });
  position.setMapMatchLoop(dev.mapMatchLoop);
  // During a trip the navigator keeps running with the map off screen, so dead reckoning
  // doesn't start over each time the app comes back.
  const syncKeepAlive = () => position.setKeepAlive(recorder.getSnapshot().state === "recording");
  recorder.subscribe(syncKeepAlive);
  syncKeepAlive();
  // Trust changes go into the trip log, so a stuck or flickering status shows up in replay.
  let lastTrust: string | null = null;
  position.subscribe(() => {
    const p = position.getSnapshot();
    if (!p || p.trust === lastTrust) return;
    lastTrust = p.trust;
    recorder.note(`gnss trust ${p.trust} (±${Math.round(p.accuracyM)} m)`);
  });

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
    position,
    getDevSettings: () => dev,
    setDevSettings: (patch) => {
      dev = { ...dev, ...patch };
      kvStore.setJson(DEV_SETTINGS_KEY, dev);
      devListeners.forEach((listener) => listener());
      // Hiding the button ends a simulated outage, so it can't be left on unseen.
      if (patch.outageButton === false) position.setSimulatedOutage(false);
      if (patch.mapMatchLoop) position.setMapMatchLoop(patch.mapMatchLoop);
    },
    subscribeDevSettings: (listener) => {
      devListeners.add(listener);
      return () => devListeners.delete(listener);
    },
  };
  return runtime;
}

/** Auto-connect to the remembered adapter without triggering a permission prompt (§7). */
export async function autoConnect(): Promise<void> {
  const { link } = getRuntime();
  const { activeDeviceId, link: state } = link.getSnapshot();
  if (activeDeviceId && state !== "error") return;
  if (Platform.OS !== "ios") return;
  if (VehicleLinkModule.getBluetoothState() === "notDetermined") return;
  await VehicleLinkModule.initialize(null);
  await link.autoConnect();
}
