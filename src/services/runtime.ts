// App-lifetime services (vehicle link, sensors, trip recorder). Created once, independent of
// screens, so recording keeps running while the UI is backgrounded (TRIP-LOGGER-SPEC §4.3).

import * as Location from "expo-location";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { AppState, Platform } from "react-native";

import VehicleLinkModule from "../../modules/vehicle-link/src/VehicleLinkModule";
import { Sentry, sentryMetricSink } from "@/config/sentry";
import { TRIP_UPLOAD_URL } from "@/config/trip-upload";
import { createClock } from "@/obd/clock";
import { VehicleLinkCore } from "@/obd/vehicle-link-core";

import { kvStore } from "./kv-store";
import { CalibrationStore } from "./navigation/calibration-store";
import { NavigatorService } from "./navigation/navigator-service";
import { ROUTER_CACHE_TILES, RouteService } from "./navigation/route-service";
import { startUpdateCenter, waitingUpdateInfo } from "./app-update/update-center";
import { onMapDownloadFailed } from "./offline-map/map-packs";
import { activeRoadGraph, openActiveRoadGraph } from "./offline-map/road-graph-file";
import { SensorService } from "./sensor-capture/sensor-service";
import { createTripFiles } from "./trip-recorder/trip-files";
import { TripRecorder, tripsOverLimit } from "./trip-recorder/trip-recorder";
import { get, networkKind, onNetworkChange, putFile, uploadSecrets } from "./trip-upload/native";
import { TripUploader } from "./trip-upload/trip-uploader";
import { NativeDiscovery } from "./vehicle-link/discovery";
import { TelemetryReporter } from "./telemetry";
import { jsSourceInfo } from "./js-source";
import { setTripService } from "./trip-service";
import { loadDevSettings } from "./dev-settings-load";
import { CanAutoIds, idsAfterBufferFull, type CanAutoStatus } from "./vehicle-link/can-auto-ids";
import { CanSpeedFeed } from "./vehicle-link/can-speed-feed";
import { DrivingEmulator } from "./vehicle-link/driving-emulator";
import { NativeTransport } from "./vehicle-link/native-transport";

export interface DevSettings {
  showEmulators: boolean;
  /** Map matching's particles and hypotheses on the map. */
  showParticles: boolean;
  /** A "Cut GPS" button on the map that simulates a GNSS outage. */
  outageButton: boolean;
  /** Experimental navigation without an OBD adapter (NAVIGATOR-SPEC §9.6). */
  phoneOnly: boolean;
  /**
   * Settings → Car: the navigator's speed from the CAN wheel frames, negative in reverse, OBD polled only while the car
   * stands (VEHICLE-LINK-SPEC §16.3). Where the adapter or the car can't (not an STN, not CAN, no profile), OBD.
   */
  wheelSpeed: boolean;
  /**
   * Settings → Car, experimental: with `wheelSpeed`, the navigator's turning from the rear wheels, not the phone's gyro
   * (NAVIGATOR-SPEC §5.4), so the phone may be in a hand, a pocket or on a seat.
   */
  wheelYaw: boolean;
  /** RPM poll period while the engine runs, s. */
  rpmPeriodS: number;
}

const DEV_SETTINGS_KEY = "dev.settings";
/** Tiles the phone-only navigator's own graph reader keeps decoded (a few km around the car). */
const PHONE_GRAPH_CACHE_TILES = 64;

export interface Runtime {
  link: VehicleLinkCore;
  sensors: SensorService;
  recorder: TripRecorder;
  /** Opt-in trip log upload (TRIP-LOGGER-SPEC §7.1); null when this build has no upload URL. */
  uploader: TripUploader | null;
  /** The map's position: the navigator (NAVIGATOR-SPEC §9), or phone GNSS without an OBD adapter. */
  position: NavigatorService;
  /** Route planning and guidance (ROUTING-SPEC §8). */
  routes: RouteService;
  getDevSettings(): DevSettings;
  /** How the CAN ids are being picked for the car (VEHICLE-LINK-SPEC §16.4). */
  canAuto: { status(): CanAutoStatus; subscribe(listener: () => void): () => void };
  setDevSettings(patch: Partial<DevSettings>): void;
  subscribeDevSettings(listener: () => void): () => void;
}

let runtime: Runtime | null = null;

export function getRuntime(): Runtime {
  if (runtime) return runtime;

  const defaults: DevSettings = {
    showEmulators: __DEV__,
    showParticles: false,
    outageButton: false,
    phoneOnly: false,
    // On by default, so other cars' logs show how the wheels go (VEHICLE-LINK-SPEC §16.3).
    wheelSpeed: true,
    wheelYaw: false,
    rpmPeriodS: 5,
  };
  let dev: DevSettings = loadDevSettings(kvStore.getJson(DEV_SETTINGS_KEY), defaults);
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
  const files = createTripFiles();
  const recorder = new TripRecorder({
    link,
    sensors,
    files,
    store: kvStore,
    nowUs,
    appInfo: () => ({
      sys_name: "wtf.ai",
      // The commit CI built (EXPO_PUBLIC_BUILD_SHA, inlined by Metro): which build a log came from.
      ver_sw: `${Constants.expoConfig?.version ?? "?"} (${Constants.nativeBuildVersion ?? "dev"}${process.env.EXPO_PUBLIC_BUILD_SHA ? ` ${process.env.EXPO_PUBLIC_BUILD_SHA.slice(0, 7)}` : ""})`,
      // The OTA update the drive ran, when the JS is newer than the build.
      ...jsSourceInfo(),
      // An app build or JS update waiting to be installed: a drive on old code says so.
      ...waitingUpdateInfo(),
      sys_hw: sysHw,
      sys_os_ver: sysOsVer,
      // The navigator version this drive starts with (a change mid-drive is a note).
      nav_mapmatch_loop: "closed",
      nav_phone_only: dev.phoneOnly ? "on" : "off",
      can_shadow: dev.wheelSpeed ? "auto" : "off",
      can_primary: dev.wheelSpeed ? "on" : "off",
      nav_wheel_yaw: dev.wheelSpeed && dev.wheelYaw ? "on" : "off",
    }),
  });
  recorder.start();
  // The ids the shadow listens to now: picked for the car (§16.4), or fewer after BUFFER FULL.
  let canIds: number[] | null = null;
  const listenCan = (ids: number[] | null) => {
    canIds = ids;
    link.setCanShadow(ids);
  };
  const canSpeed = new CanSpeedFeed({
    onFrames: (listener) => link.onCanFrames(listener),
    onWindow: (listener) => link.onCanWindow(() => listener()),
    vin: () => link.getSnapshot().vehicle?.vin ?? null,
    listened: () => canIds,
    push: (s) => link.pushCanSpeed(s),
    note: (text) => recorder.note(text),
  });
  const canAutoListeners = new Set<() => void>();
  const canAuto = new CanAutoIds({
    vin: () => link.getSnapshot().vehicle?.vin ?? null,
    listen: listenCan,
    onFrames: (listener) => link.onCanFrames(listener),
    onWindow: (listener) => link.onCanWindow(listener),
    moving: () => {
      const s = link.getSnapshot().lastSpeed;
      return s !== null && Math.abs(s.raw) >= 1 && nowUs() - s.rxUs <= 2_000_000;
    },
    store: kvStore,
    note: (text) => recorder.note(text),
    onStatus: () => canAutoListeners.forEach((l) => l()),
  });
  // A new car (another VIN, or the VIN read late) gets its own ids.
  link.subscribe(() => canAuto.refresh());
  // More ids than the link carries without the polls' breaks (CAN primary, VEHICLE-LINK-SPEC §16.3): the ones
  // navigation needs only, for the rest of the session.
  link.onCanBufferFull(() => {
    const fewer = idsAfterBufferFull(canIds, canSpeed.profile);
    if (!fewer) return;
    recorder.note(`can: buffer full with ${canIds!.length} ids, listening to the ${fewer.length} navigation needs`);
    listenCan(fewer);
  });
  // The ids picked for the car (§16.4); the link's monitor listens while they are set.
  const syncWheelSpeed = () => {
    if (dev.wheelSpeed) {
      canAuto.start();
      canSpeed.start();
    } else {
      canAuto.stop();
      listenCan(null);
      canSpeed.stop();
    }
  };
  syncWheelSpeed();
  const syncPolling = () => {
    link.setRpmPeriods({ rpmPeriodRunningMs: dev.rpmPeriodS * 1000 });
  };
  syncPolling();

  const uploader = TRIP_UPLOAD_URL
    ? new TripUploader({
        baseUrl: TRIP_UPLOAD_URL,
        store: kvStore,
        secrets: uploadSecrets,
        network: networkKind,
        recorder: { getSnapshot: () => recorder.getSnapshot(), tripUri: (fileName) => files.uri(fileName) },
        removeTrip: (fileName) => {
          const trip = recorder.getSnapshot().trips.find((t) => t.fileName === fileName);
          if (trip) recorder.deleteTrip(trip.id);
        },
        putFile,
        get,
        now: () => Date.now(),
      })
    : null;
  if (uploader) {
    // A finished trip, the app back in front, a new network: each a chance to send what waits.
    const upload = () => void uploader.run().catch((e) => Sentry.captureException(e));
    let lastState = recorder.getSnapshot().state;
    recorder.subscribe(() => {
      const state = recorder.getSnapshot().state;
      if (state !== lastState && lastState === "recording") upload();
      lastState = state;
    });
    AppState.addEventListener("change", (s) => s === "active" && upload());
    onNetworkChange(upload);
    upload();
  }

  // The storage limit (TRIP-LOGGER-SPEC §7.2): checked a few seconds after a trip ends or the limit changes, so
  // dragging the slider past a low value deletes nothing. Logs still waiting for upload are kept.
  let pruneTimer: ReturnType<typeof setTimeout> | null = null;
  const prune = () => {
    pruneTimer = null;
    const snap = recorder.getSnapshot();
    const keep = new Set(uploader?.getSnapshot().name ? uploader.pending() : []);
    for (const id of tripsOverLimit(snap.trips, snap.current?.id ?? null, snap.settings.storageLimitGb * 1e9, keep)) {
      recorder.deleteTrip(id);
    }
  };
  const schedulePrune = () => {
    if (pruneTimer) clearTimeout(pruneTimer);
    pruneTimer = setTimeout(prune, 3000);
  };
  let prunedFor = { state: recorder.getSnapshot().state, limit: recorder.getSnapshot().settings.storageLimitGb };
  recorder.subscribe(() => {
    const { state, settings } = recorder.getSnapshot();
    if ((state !== prunedFor.state && prunedFor.state === "recording") || settings.storageLimitGb !== prunedFor.limit) schedulePrune();
    prunedFor = { state, limit: settings.storageLimitGb };
  });
  schedulePrune();

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
    // The wheels' samples for the navigator's turning (NAVIGATOR-SPEC §5.4, `setWheelYaw`).
    canSpeed: canSpeed,
    // Phone-only mode reads the graph in a frame of its own (NAVIGATOR-SPEC §9.6).
    openPhoneGraph: () => openActiveRoadGraph(PHONE_GRAPH_CACHE_TILES),
    permission: { get: Location.getForegroundPermissionsAsync, request: Location.requestForegroundPermissionsAsync },
  });
  position.setPhoneOnly(dev.phoneOnly);
  const syncWheelYaw = () => position.setWheelYaw(dev.wheelSpeed && dev.wheelYaw);
  syncWheelYaw();
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
    onRoute: (plan) => {
      position.setPhoneRoute(plan ? plan.coordinates : null);
      // The store video drives the car along the app's own route (scripts/store-screenshots.py reads it in logcat).
      if (dev.showEmulators && plan) {
        console.log(`wtf-demo-route ${JSON.stringify(plan.coordinates.map((c) => [+c.lat.toFixed(6), +c.lon.toFixed(6)]))}`);
      }
    },
    note: (text) => recorder.note(text),
    log: {
      route: (r) => recorder.navRoute(r),
      point: (r) => recorder.navRoutePoint(r),
      maneuver: (r) => recorder.navRouteManeuver(r),
      progress: (r) => recorder.navRouteProgress(r),
    },
  });
  routes.resume();
  // A route planned before the trip started (engine off) goes into the trip's log once it is open.
  // Likewise what the navigator has stored (parked pose, speed scale, compass, GNSS lag): a replay starts from it.
  recorder.tripStarted.on(() => {
    routes.logActiveRoute();
    position.logStorage();
  });
  let wasRecording = recorder.getSnapshot().state === "recording";
  recorder.subscribe(() => {
    const recording = recorder.getSnapshot().state === "recording";
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
  onMapDownloadFailed((e, { region, ...where }) =>
    Sentry.captureException(e, { tags: { feature: "map-download", map_region: region }, extra: where }),
  );

  // Update checks, prompts' data and the automatic map update (docs/UPDATES-SPEC.md §5). A map update replaces the
  // map in use only while no trip records and no route is on.
  startUpdateCenter({
    driving: () => recorder.getSnapshot().state === "recording" || routes.getSnapshot() != null,
    activity: () => ({
      recorder: recorder.getSnapshot().state,
      route: routes.getSnapshot() != null,
      link: link.getSnapshot().link,
      speedMps: position.getSnapshot()?.speedMps,
    }),
    subscribeActivity: (listener) => {
      const off = [recorder.subscribe(listener), routes.subscribe(listener), link.subscribe(listener)];
      return () => off.forEach((o) => o());
    },
    subscribeDriving: (listener) => {
      const offRecorder = recorder.subscribe(listener);
      const offRoutes = routes.subscribe(listener);
      return () => {
        offRecorder();
        offRoutes();
      };
    },
  });

  runtime = {
    link,
    sensors,
    recorder,
    uploader,
    position,
    routes,
    getDevSettings: () => dev,
    canAuto: {
      status: () => canAuto.status,
      subscribe: (listener) => {
        canAutoListeners.add(listener);
        return () => canAutoListeners.delete(listener);
      },
    },
    setDevSettings: (patch) => {
      dev = { ...dev, ...patch };
      kvStore.setJson(DEV_SETTINGS_KEY, dev);
      devListeners.forEach((listener) => listener());
      // Hiding the button ends a simulated outage, so it can't be left on unseen.
      if (patch.outageButton === false) position.setSimulatedOutage(false);
      if (patch.phoneOnly !== undefined) position.setPhoneOnly(patch.phoneOnly);
      // The log's info has the setting the drive started with; a change mid-drive is a note.
      if (patch.wheelSpeed !== undefined) {
        recorder.note(`can bus ${dev.wheelSpeed ? "primary" : "off"}`);
        // Turned on again: cars taken for OBD only get another try.
        if (dev.wheelSpeed) canAuto.forgetNone();
        syncWheelSpeed();
      }
      // The service notes the change (`nav wheel yaw on|off`): only with the wheels' speed does the setting turn it on.
      if (patch.wheelSpeed !== undefined || patch.wheelYaw !== undefined) syncWheelYaw();
      if (patch.rpmPeriodS !== undefined) syncPolling();
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
  // Never the emulated adapters: their scripted drive would start by itself whenever the app opens, and fake speed under
  // a real drive if a driver ever tapped one (2026-10-14: the emulator drove off before any destination was set).
  await link.autoConnect(["emulator"]);
}
