// App-lifetime services (vehicle link, sensors, trip recorder). Created once, independent of
// screens, so recording keeps running while the UI is backgrounded (TRIP-LOGGER-SPEC §4.3).

import * as Location from "expo-location";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { Platform } from "react-native";

import VehicleLinkModule from "../../modules/vehicle-link/src/VehicleLinkModule";
import { Sentry, sentryMetricSink } from "@/config/sentry";
import { createClock } from "@/obd/clock";
import { VehicleLinkCore } from "@/obd/vehicle-link-core";

import { kvStore } from "./kv-store";
import { CalibrationStore } from "./navigation/calibration-store";
import { NavigatorService, type MapMatchLoop } from "./navigation/navigator-service";
import { ROUTER_CACHE_TILES, RouteService } from "./navigation/route-service";
import { activeRoadGraph, openActiveRoadGraph } from "./offline-map/road-graph-file";
import { SensorService } from "./sensor-capture/sensor-service";
import { APP_NAV_DEFAULTS, APP_ROUTE_HINT } from "@/nav/app-defaults";
import { createTripFiles } from "./trip-recorder/trip-files";
import { TripRecorder } from "./trip-recorder/trip-recorder";
import { NativeDiscovery } from "./vehicle-link/discovery";
import { TelemetryReporter } from "./telemetry";
import { setTripService } from "./trip-service";
import { DrivingEmulator } from "./vehicle-link/driving-emulator";
import { NativeTransport } from "./vehicle-link/native-transport";

export interface DevSettings {
  showEmulators: boolean;
  /** Map matching's particles and hypotheses on the map. */
  showParticles: boolean;
  /** A "Cut GPS" button on the map that simulates a GNSS outage. */
  outageButton: boolean;
  /** How map matching feeds back into the navigator (MAPMATCH-SPEC §9): open, heading, closed. */
  mapMatchLoop: MapMatchLoop;
  /** Map matching told the route (ROUTING-SPEC §8.6): at junctions it favours the route's exit. */
  routeHint: boolean;
}

const DEV_SETTINGS_KEY = "dev.settings";

export interface Runtime {
  link: VehicleLinkCore;
  sensors: SensorService;
  recorder: TripRecorder;
  /** The map's position: the navigator (NAVIGATOR-SPEC §9), or phone GNSS without an OBD adapter. */
  position: NavigatorService;
  /** Route planning and guidance (ROUTING-SPEC §8). */
  routes: RouteService;
  getDevSettings(): DevSettings;
  setDevSettings(patch: Partial<DevSettings>): void;
  subscribeDevSettings(listener: () => void): () => void;
}

let runtime: Runtime | null = null;

export function getRuntime(): Runtime {
  if (runtime) return runtime;

  // Full correction by default (MAPMATCH-SPEC §9): replay and simulation beat the open loop everywhere; the open loop
  // stays one tap away in the developer settings for comparing on the road. The navigator's share of these lives in
  // `nav/app-defaults.ts`, which the replay tools start from, so a replay runs the system the phone does.
  let dev: DevSettings = {
    showEmulators: __DEV__,
    showParticles: false,
    outageButton: false,
    mapMatchLoop: APP_NAV_DEFAULTS.mapMatchLoop!,
    routeHint: APP_ROUTE_HINT,
    ...(kvStore.getJson<Partial<DevSettings>>(DEV_SETTINGS_KEY) ?? {}),
  };
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
      // The commit CI built (EXPO_PUBLIC_BUILD_SHA, inlined by Metro): which build a log came from.
      ver_sw: `${Constants.expoConfig?.version ?? "?"} (${Constants.nativeBuildVersion ?? "dev"}${process.env.EXPO_PUBLIC_BUILD_SHA ? ` ${process.env.EXPO_PUBLIC_BUILD_SHA.slice(0, 7)}` : ""})`,
      sys_hw: sysHw,
      sys_os_ver: sysOsVer,
      // The navigator version this drive starts with (a change mid-drive is a note).
      nav_mapmatch_loop: dev.mapMatchLoop,
      nav_route_hint: dev.routeHint ? "on" : "off",
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
    permission: { get: Location.getForegroundPermissionsAsync, request: Location.requestForegroundPermissionsAsync },
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

  // Routing on the active region's road graph, from the published position (ROUTING-SPEC §8).
  const routes = new RouteService({
    position,
    openGraph: () => openActiveRoadGraph(ROUTER_CACHE_TILES),
    nowUs,
    store: kvStore,
    onRoute: (legs) => position.setRouteHint(dev.routeHint && legs ? legs.map((l) => l.edge) : null),
    note: (text) => recorder.note(text),
    log: {
      route: (r) => recorder.navRoute(r),
      point: (r) => recorder.navRoutePoint(r),
      maneuver: (r) => recorder.navRouteManeuver(r),
      progress: (r) => recorder.navRouteProgress(r),
    },
  });
  routes.resume();
  // A route planned before the trip started (engine off) goes into the trip's log when it starts.
  let wasRecording = recorder.getSnapshot().state === "recording";
  recorder.subscribe(() => {
    const recording = recorder.getSnapshot().state === "recording";
    if (recording && !wasRecording) routes.logActiveRoute();
    // Android keeps sensors and the adapter alive with the screen off only while a foreground service runs.
    if (recording !== wasRecording) {
      void setTripService(recording).then((running) => {
        if (recording) recorder.note(`android trip service ${running ? "running" : "not started"}`);
      });
    }
    wasRecording = recording;
  });

  // Health metrics for field testers (docs/ANDROID-SPEC.md §4.1).
  const telemetry = new TelemetryReporter(sentryMetricSink, () => Date.now());
  const isRecording = () => recorder.getSnapshot().state === "recording";
  link.subscribe(() => telemetry.onLink(link.getSnapshot()));
  sensors.gnss.on((rec) => telemetry.onGnssFix(Number.isFinite(rec.speedMps)));
  sensors.imu.on(() => telemetry.onImuBatch(isRecording()));
  sensors.subscribe(() => telemetry.onSensors(sensors.getSnapshot(), isRecording()));

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
    routes,
    getDevSettings: () => dev,
    setDevSettings: (patch) => {
      dev = { ...dev, ...patch };
      kvStore.setJson(DEV_SETTINGS_KEY, dev);
      devListeners.forEach((listener) => listener());
      // Hiding the button ends a simulated outage, so it can't be left on unseen.
      if (patch.outageButton === false) position.setSimulatedOutage(false);
      if (patch.mapMatchLoop) position.setMapMatchLoop(patch.mapMatchLoop);
      if (patch.routeHint !== undefined) {
        const plan = routes.getSnapshot()?.plan;
        position.setRouteHint(patch.routeHint && plan ? plan.legs.map((l) => l.edge) : null);
      }
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
  if (Platform.OS === "web") return;
  if (VehicleLinkModule.getBluetoothState() === "notDetermined") return;
  await VehicleLinkModule.initialize(null);
  await link.autoConnect();
}
