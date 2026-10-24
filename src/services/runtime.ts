// App-lifetime services (vehicle link, sensors, trip recorder). Created once, independent of
// screens, so recording keeps running while the UI is backgrounded (TRIP-LOGGER-SPEC §4.3).

import * as Location from "expo-location";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { AppState, Platform } from "react-native";

import PositionShareModule from "../../modules/position-share/src/PositionShareModule";
import VehicleLinkModule from "../../modules/vehicle-link/src/VehicleLinkModule";
import { RESTORE_IDENTIFIER } from "../../modules/vehicle-link/src/restore";
import SensorCaptureModule from "../../modules/sensor-capture/src/SensorCaptureModule";
import { Sentry, sentryMetricSink } from "@/config/sentry";
import { TRIP_UPLOAD_URL } from "@/config/trip-upload";
import type { Profile } from "@/nav/odometry/can/profile";
import { createClock } from "@/obd/clock";
import { RECONNECTING, VehicleLinkCore } from "@/obd/vehicle-link-core";

import { AppHealth } from "./app-health";
import { OnTheWay, poseAfterWake } from "./on-the-way";
import { LocationSession } from "./location-session";
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
import { adapterModel, TelemetryReporter } from "./telemetry";
import { jsCommit, jsSourceInfo } from "./js-source";
import { PositionShareService } from "./position-share/position-share-service";
import { setTripService, updateTripNotification } from "./trip-service";
import { DEV_SETTINGS_VERSION, loadDevSettings } from "./dev-settings-load";
import { CanAutoIds, idsAfterBufferFull, navigationIds, type CanAutoStatus } from "./vehicle-link/can-auto-ids";
import { CanDiscovery, discoveryReportAttributes, linkCapacity, type CanDiscoveryReport, type CanDiscoveryStatus } from "./vehicle-link/can-discovery";
import { CanProbation, probationReportAttributes, type CanProbationReport, type CanProbationStatus } from "./vehicle-link/can-probation";
import { CanSpeedFeed } from "./vehicle-link/can-speed-feed";
import { CanWheelOrder } from "./vehicle-link/can-wheel-order";
import { DrivingEmulator } from "./vehicle-link/driving-emulator";
import { isHeldForUpdater } from "./vehicle-link/firmware-notice";
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
  /**
   * Settings → Car: send the anonymous report of each car profile's probation (VEHICLE-LINK-SPEC §16.5; PRIVACY.md):
   * the make, the profile, its ids and how it compared with OBD speed. No VIN, no position.
   */
  carReports: boolean;
  /** RPM poll period while the engine runs, s. */
  rpmPeriodS: number;
  /** More → Waze and Google Maps: share the car's position with other navigators during a trip (ANDROID-SPEC §8). */
  positionShare: boolean;
}

const DEV_SETTINGS_KEY = "dev.settings";
/** Tiles the phone-only navigator's own graph reader keeps decoded (a few km around the car). */
const PHONE_GRAPH_CACHE_TILES = 64;
/** How long after a start the trip service has taken its types. */
const TRIP_SERVICE_TYPES_CHECK_MS = 2000;

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
  /** The app process in the trip log (TRIP-LOGGER-SPEC §4.4). */
  health: AppHealth;
  /** The app started after the car drove off: the map says why the parked pose isn't used (NAVIGATOR-SPEC §6.1). */
  onTheWay: OnTheWay;
  /** The car's position for Waze and Google Maps (Android; ANDROID-SPEC §8). */
  share: PositionShareService;
  getDevSettings(): DevSettings;
  /** How the CAN ids are being picked for the car (VEHICLE-LINK-SPEC §16.4). */
  canAuto: { status(): CanAutoStatus; subscribe(listener: () => void): () => void };
  /** The car's profile on probation, passed or failed (VEHICLE-LINK-SPEC §16.5). */
  canProbation: { status(): CanProbationStatus; subscribe(listener: () => void): () => void };
  /** The search for a speed on the bus of a car without a profile (VEHICLE-LINK-SPEC §16.6). */
  canDiscovery: { status(): CanDiscoveryStatus; subscribe(listener: () => void): () => void };
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
    wheelYaw: true,
    carReports: true,
    rpmPeriodS: 5,
    positionShare: false,
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
      // Waze and Google Maps got the map's dot (ANDROID-SPEC §8); notes say when it started, held and failed.
      ...(Platform.OS === "android" ? { position_share: dev.positionShare ? "on" : "off" } : {}),
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
    admit: (profile): boolean => canProbation.admit(profile),
    extraProfiles: (): Profile[] => (canDiscovery.profile ? [canDiscovery.profile] : []),
    active: (): boolean => !canDiscovery.searching,
  });
  // The car reports go once per outcome and adapter for each build of the app's JS (the commit CI built it from, a new
  // IPA or OTA update): the app.json version is the same for every build.
  const carReportScope = () => `${adapterModel(link.getSnapshot())}|${jsCommit() ?? "dev"}`;
  const canProbationListeners = new Set<() => void>();
  const canProbation = new CanProbation({
    vin: () => link.getSnapshot().vehicle?.vin ?? null,
    nowUs,
    onSpeed: (listener) => link.onSpeed(listener),
    onCanSpeed: (listener): (() => void) => canSpeed.onSpeed(listener),
    onFrames: (listener) => link.onCanFrames(listener),
    onWindow: (listener) => link.onCanWindow(listener),
    setTrusted: (on) => link.setCanTrusted(on),
    promote: () => canSpeed.promote(),
    stopListening: () => listenCan(null),
    reportScope: carReportScope,
    reportsOn: () => dev.carReports,
    report: (r) => reportCanProbation(r, link.getSnapshot().vehicle?.protocol ?? "", adapterModel(link.getSnapshot())),
    store: kvStore,
    note: (text) => recorder.note(text),
    onStatus: (status) => {
      // A layout the search found that the car's OBD speed refutes: the search goes on (§16.6).
      if (status.state === "failed" && status.profile.startsWith("found/")) canDiscovery.rejectFound();
      canProbationListeners.forEach((l) => l());
    },
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
    onStatus: () => {
      canAutoListeners.forEach((l) => l());
      canDiscovery.refresh();
    },
  });
  // A car whose make has no profile, or none heard (§16.6): its own speed searched for on its bus.
  const canDiscoveryListeners = new Set<() => void>();
  const canDiscovery: CanDiscovery = new CanDiscovery({
    vin: () => link.getSnapshot().vehicle?.vin ?? null,
    nowUs,
    canAuto: () => canAuto.status,
    canMonitor: () => {
      const s = link.getSnapshot();
      return s.link === "polling" && s.canOff === null;
    },
    // Not only the ECU awake: with the engine off some cars' ABS is quiet, and a survey then would miss the wheels for
    // good. Standing or moving it tells by its own last poll.
    engineRunning: () => link.getSnapshot().engine === "engine-running",
    survey: (slice, durationMs) => link.monitorCan({ ids: null, durationMs, slice }),
    capacity: () => linkCapacity(link.getSnapshot().adapter?.transport),
    listen: listenCan,
    onFrames: (listener) => link.onCanFrames(listener),
    onWindow: (listener) => link.onCanWindow(listener),
    onSpeed: (listener) => link.onSpeed(listener),
    setTrusted: (on) => link.setCanTrusted(on),
    found: (profile) => {
      if (!profile) return;
      // The feed matches the car's own profile from scratch, on its id alone.
      canSpeed.stop();
      canSpeed.start();
      listenCan(navigationIds(profile));
    },
    reportScope: carReportScope,
    reportsOn: () => dev.carReports,
    report: (r) => reportCanDiscovery(r, link.getSnapshot().vehicle?.protocol ?? "", adapterModel(link.getSnapshot())),
    store: kvStore,
    note: (text) => recorder.note(text),
    onStatus: () => {
      canWheelOrder.refresh();
      canDiscoveryListeners.forEach((l) => l());
    },
  });
  // A find of four wheels: which is which, from the phone's gyro (§16.6), for turning from them from the next drive.
  // Another car or another find changes the discovery's status: that refreshes it.
  const canWheelOrder: CanWheelOrder = new CanWheelOrder({
    vin: () => link.getSnapshot().vehicle?.vin ?? null,
    find: () => canDiscovery.find,
    onFrames: (listener) => link.onCanFrames(listener),
    onWindow: (listener) => link.onCanWindow(() => listener()),
    onImu: (listener) =>
      sensors.imu.on((batch) => listener(batch.motion.map((m) => ({ tUs: m.timestampUs, gyro: m.gyro, gravity: m.gravity, userAccel: m.userAccel })))),
    decided: (find, verdict, learnedS) => canDiscovery.setOrder(find, verdict, learnedS),
    store: kvStore,
    note: (text) => recorder.note(text),
  });
  // A new car (another VIN, or the VIN read late) gets its own ids. Before discovery's: whether a search is due is the
  // picking's answer for the new car, not the old one's.
  link.subscribe(() => canAuto.refresh());
  link.subscribe(() => canDiscovery.refresh());
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
      canProbation.start();
      canSpeed.start();
      canDiscovery.start();
      canWheelOrder.start();
    } else {
      canAuto.stop();
      canWheelOrder.stop();
      canDiscovery.stop();
      listenCan(null);
      canSpeed.stop();
      canProbation.stop();
      link.setCanTrusted(true);
    }
  };
  syncWheelSpeed();
  // A probation the link couldn't carry turned the monitor off for the drive (§16.5): the car switched off, the next
  // drive picks the ids again and tries once more.
  link.onEngineState((state) => {
    if (state !== "ignition-off" || !dev.wheelSpeed) return;
    // A find's wheels' order learned on the drive that ended: its wheels from the next.
    canDiscovery.nextDrive();
    if (canDiscovery.status.state === "aborted") {
      canDiscovery.stop();
      canDiscovery.start();
    }
    if (canProbation.status.state !== "aborted") return;
    canProbation.stop();
    canProbation.start();
    // The feed chooses the profile again, so the next drive's probation starts with it.
    canSpeed.stop();
    canSpeed.start();
    canAuto.stop();
    canAuto.start();
  });
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

  const onTheWay = new OnTheWay();
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
    // iOS relaunches the app for location "Always" a few hundred metres into a drive (VEHICLE-LINK-SPEC §11).
    onTheWay: {
      poseAfterWake: (pose) =>
        Platform.OS === "ios"
          ? poseAfterWake(SensorCaptureModule.launchInfo(), nowUs(), SensorCaptureModule.driveWakeFix?.() ?? null, pose)
          : "not woken",
      poseBehind: () => onTheWay.behind(),
    },
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
    // Found: by a trusted fix, or the driver put the car on the map.
    if (p && (p.trust === "TRUSTED" || p.source === "manual")) onTheWay.clear();
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
  // The app process (TRIP-LOGGER-SPEC §4.4): its memory and CPU while a trip records, and at a trip's start how it was
  // launched and how the run before it ended.
  const health = new AppHealth({
    launchInfo: () => SensorCaptureModule.launchInfo(),
    processStats: (appState, context) => SensorCaptureModule.processStats(appState, context),
    takeReports: () => SensorCaptureModule.takeHealthReports(),
    onMemoryWarning: (listener) => {
      const sub = SensorCaptureModule.addListener("onMemoryWarning", (e) => listener(e.level));
      return () => sub.remove();
    },
    appState: () => AppState.currentState ?? "unknown",
    context: () => {
      const snap = recorder.getSnapshot();
      return snap.current ? `${snap.state} ${snap.current.id}` : snap.state;
    },
    nowUs,
    record: (r) => recorder.appStats(r),
    note: (text) => recorder.note(text),
    report: (message, extra) => Sentry.captureMessage(message, { level: "warning", extra }),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  });
  health.start();

  // iOS's background location session (TRIP-LOGGER-SPEC §4.3): held whenever the app is in front, so a trip that starts
  // after the driver switched away gets GNSS and iOS can relaunch the app it ended; let go 30 min after leaving it idle.
  const busyStates = new Set(["recording", "lingering"]);
  const locationSession = new LocationSession({
    set: (on) => SensorCaptureModule.setLocationSession(on),
    always: async () => (await Location.getBackgroundPermissionsAsync()).granted,
    appState: () => AppState.currentState ?? "unknown",
    onAppState: (listener) => {
      const sub = AppState.addEventListener("change", listener);
      return () => sub.remove();
    },
    busy: () => {
      const state = recorder.getSnapshot().state;
      const engine = link.getSnapshot().engine;
      return busyStates.has(state) || (state === "armed" && (engine === "engine-off" || engine === "engine-running"));
    },
    onBusy: (listener) => {
      const off = [recorder.subscribe(listener), link.subscribe(listener)];
      return () => off.forEach((o) => o());
    },
    note: (text) => recorder.note(text),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
  if (Platform.OS === "ios") locationSession.start();

  recorder.tripStarted.on(() => {
    routes.logActiveRoute();
    position.logStorage();
    health.tripStarted();
  });
  let wasRecording = recorder.getSnapshot().state === "recording";
  recorder.subscribe(() => {
    onTheWay.setRecording(recorder.getSnapshot().state === "recording");
    const recording = recorder.getSnapshot().state === "recording";
    // Android keeps sensors and the adapter alive with the screen off only while a foreground service runs.
    if (recording !== wasRecording) {
      void setTripService(recording).then((running) => {
        if (recording) recorder.note(`android trip service ${running ? "running" : "not started"}`);
        // The service takes its types a moment later: without location, GNSS waits for the app or the notification's
        // button (VEHICLE-LINK-SPEC §11).
        if (recording && running) {
          setTimeout(() => {
            if (recorder.getSnapshot().state === "recording" && SensorCaptureModule.tripServiceHasLocation?.() === false) {
              recorder.note("android trip service without location: started in the background");
            }
          }, TRIP_SERVICE_TYPES_CHECK_MS);
        }
      });
    }
    wasRecording = recording;
  });
  // A trip the companion wake started records without the service's location type (Android allows it only with the app
  // on screen, VEHICLE-LINK-SPEC §11): opening the app starts the service again, with it.
  if (Platform.OS === "android") {
    AppState.addEventListener("change", (state) => {
      if (state === "active" && recorder.getSnapshot().state === "recording") void setTripService(true);
    });
  }

  // The car's position for Waze and Google Maps (ANDROID-SPEC §8): during a trip with the car, while the setting is on.
  const share = new PositionShareService({
    native: Platform.OS === "android" ? PositionShareModule : null,
    position,
    trip: {
      active: () => {
        const { state, current } = recorder.getSnapshot();
        return state === "recording" && (current?.startReason !== "manual" || link.getSnapshot().adapter !== null);
      },
      subscribe: (listener) => {
        const off = [recorder.subscribe(listener), link.subscribe(listener)];
        return () => off.forEach((o) => o());
      },
    },
    enabled: {
      get: () => dev.positionShare,
      subscribe: (listener) => {
        devListeners.add(listener);
        return () => devListeners.delete(listener);
      },
    },
    notify: updateTripNotification,
    note: (text) => recorder.note(text),
    nowMs: () => Date.now(),
  });
  // Back from Android's settings: Developer options or the mock location app may have changed.
  AppState.addEventListener("change", (s) => s === "active" && share.recheck());

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
    // A car that never gave its VIN, as an anonymous log: a breadcrumb only arrives with a later error, and the drive
    // may have none. The detail holds what 0902 answered, never a VIN (replyShape).
    if (e.type === "vin" && e.detail?.startsWith("not read after")) {
      const snap = link.getSnapshot();
      try {
        Sentry.logger.warn(`vin ${e.detail}`, { adapter: snap.adapter?.name ?? "", model: adapterModel(snap), elm: snap.adapter?.elmVersion ?? "", protocol: snap.vehicle?.protocol ?? "" });
      } catch {
        // reporting is best effort
      }
    }
    // Bluetooth switched off is mostly the driver's choice: once per launch (one iPhone sent 20 in a night). A probe
    // under a reconnect is retried: only one that ends the connect is a fault.
    const bluetoothOff = e.type === "error" && link.getSnapshot().error?.code === "bluetooth-off";
    if (bluetoothOff && bluetoothOffReported) return;
    if (bluetoothOff) bluetoothOffReported = true;
    const reconnectProbe = e.type === "probe-failed" && !!e.detail?.endsWith(RECONNECTING);
    if (e.type === "error" || (e.type === "probe-failed" && !reconnectProbe)) Sentry.captureMessage(`vehicle-link ${e.type}: ${e.detail ?? ""}`, "warning");
  });
  // Bluetooth back on: a link that failed for it connects again by itself (autoConnect leaves a working link alone).
  VehicleLinkModule.addListener("onBluetoothState", ({ state }) => {
    Sentry.addBreadcrumb({ category: "bluetooth", message: state });
    if (state === "poweredOn") void autoConnect().catch((error) => console.warn("auto-connect failed", error));
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
    health,
    onTheWay,
    share,
    getDevSettings: () => dev,
    canAuto: {
      status: () => canAuto.status,
      subscribe: (listener) => {
        canAutoListeners.add(listener);
        return () => canAutoListeners.delete(listener);
      },
    },
    canDiscovery: {
      status: () => canDiscovery.status,
      subscribe: (listener) => {
        canDiscoveryListeners.add(listener);
        return () => canDiscoveryListeners.delete(listener);
      },
    },
    canProbation: {
      status: () => canProbation.status,
      subscribe: (listener) => {
        canProbationListeners.add(listener);
        return () => canProbationListeners.delete(listener);
      },
    },
    setDevSettings: (patch) => {
      dev = { ...dev, ...patch };
      kvStore.setJson(DEV_SETTINGS_KEY, { ...dev, version: DEV_SETTINGS_VERSION });
      devListeners.forEach((listener) => listener());
      // Hiding the button ends a simulated outage, so it can't be left on unseen.
      if (patch.outageButton === false) position.setSimulatedOutage(false);
      if (patch.phoneOnly !== undefined) position.setPhoneOnly(patch.phoneOnly);
      // The log's info has the setting the drive started with; a change mid-drive is a note.
      if (patch.wheelSpeed !== undefined) {
        recorder.note(`can bus ${dev.wheelSpeed ? "primary" : "off"}`);
        // Turned on again: cars taken for OBD only, and profiles that failed probation, get another try.
        if (dev.wheelSpeed) {
          canAuto.forgetNone();
          canProbation.forgetFailed();
          canDiscovery.forgetNone();
          canWheelOrder.forgetNotWheels();
        }
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
  // Last, once everything that listens to the recorder does: the resumed log gets the launch notes, and Android's trip
  // service starts for it.
  recorder.resumeManual();
  return runtime;
}

let autoConnecting: Promise<void> | null = null;
/** A Bluetooth-off error went to Sentry in this launch. */
let bluetoothOffReported = false;

/**
 * Auto-connect to the remembered adapter without triggering a permission prompt (§7). One at a time: the screen and a
 * wake (VEHICLE-LINK-SPEC §11) can both ask at launch, and two connects at once would each open the adapter.
 */
export function autoConnect(): Promise<void> {
  autoConnecting ??= autoConnectOnce().finally(() => {
    autoConnecting = null;
  });
  return autoConnecting;
}

async function autoConnectOnce(): Promise<void> {
  const { link } = getRuntime();
  const { activeDeviceId, link: state } = link.getSnapshot();
  if (activeDeviceId && state !== "error") return;
  if (Platform.OS === "web") return;
  // The maker's app has the adapter for a firmware update (VEHICLE-LINK-SPEC §8.4).
  if (isHeldForUpdater()) return;
  if (VehicleLinkModule.getBluetoothState() === "notDetermined") return;
  await VehicleLinkModule.initialize(RESTORE_IDENTIFIER);
  // Never the emulated adapters: their scripted drive would start by itself whenever the app opens, and fake speed under
  // a real drive if a driver ever tapped one (2026-10-14: the emulator drove off before any destination was set).
  await link.autoConnect(["emulator"]);
}

/**
 * A car profile's probation as an anonymous Sentry log (VEHICLE-LINK-SPEC §16.5, PRIVACY.md): what the car's make and
 * the adapter make of CAN at the OBD port, never the VIN or a position. Sentry's own device tags come with it.
 */
function reportCanProbation(r: CanProbationReport, protocol: string, adapter: string): void {
  try {
    Sentry.logger.info(`can probation: ${r.outcome} ${r.profile}`, probationReportAttributes(r, protocol, adapter));
  } catch {
    // reporting is best effort
  }
}

/** A search for a car's speed on its bus as an anonymous Sentry log (VEHICLE-LINK-SPEC §16.6, PRIVACY.md). */
function reportCanDiscovery(r: CanDiscoveryReport, protocol: string, adapter: string): void {
  try {
    Sentry.logger.info(`can discovery: ${r.outcome} ${r.make}`, discoveryReportAttributes(r, protocol, adapter));
  } catch {
    // reporting is best effort
  }
}
