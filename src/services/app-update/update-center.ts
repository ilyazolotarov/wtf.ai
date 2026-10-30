// The app's update checks (docs/UPDATES-SPEC.md §5): what is new for the app and the active region's map, the
// automatic map updates, and what the prompts and dots need. The prompts themselves are `UpdatePrompts` (map screen).
import * as Updates from "expo-updates";
import { AppState, PermissionsAndroid, Platform } from "react-native";
import { useSyncExternalStore } from "react";

import AppNotice from "../../../modules/app-notice/src/AppNoticeModule";
import { Sentry } from "@/config/sentry";
import { stringsNow } from "@/i18n/strings-now";
import { kvStore } from "@/services/kv-store";
import { nativeBuildReady } from "@/services/native-build-number";
import {
  downloadRegion,
  getMapPacks,
  installedRelease,
  loadCatalog,
  plannedBytes,
  regionNeedsUpdate,
  releaseFingerprint,
  setDownloadNetwork,
  setInstallGate,
  subscribeMapPacks,
} from "@/services/offline-map/map-packs";

import {
  badges,
  mapAction,
  MOVING_MPS,
  nativeUpdate,
  RELOAD_BACKGROUND_MS,
  reloadBlocker,
  SNOOZE_MS,
  updateNotice,
  type AppBuildInfo,
  type Found,
  type MapUpdate,
  type ReloadContext,
} from "./decide";
import {
  clearDownloads,
  downloadBuild,
  downloadedFile,
  fetchLatestBuild,
  installApk,
  ownBuild,
  shareIpa,
} from "./native-build";
import { currentDownloadNetwork, isUnmetered, onDownloadNetwork, onNetworkChange } from "./network";

/** Back in front on an unmetered network: checks at most this often. */
const RESUME_CHECK_MS = 30 * 60 * 1000;
/** The map catalog changes weekly: fetched at most this often (a manual check always). */
const CATALOG_CHECK_MS = 6 * 3600 * 1000;
/** At launch, after the map is up. */
const LAUNCH_DELAY_MS = 5000;
const FETCH_TIMEOUT_MS = 15000;
const STORE_KEY = "app-update";
/** The background restart's timer firing this much later than asked: the app was frozen, and wakes as it opens. */
const RELOAD_LATE_MS = 5000;
/** A tap on the update notification opens the App update page. */
const UPDATE_PAGE_URL = "wtfai://more/update";

interface Saved {
  /** promptKey → until when "Later" holds it back. */
  snoozed: Record<string, number>;
  /** The map release (`releaseFingerprint`) the driver skipped; an OSM date in older saves, which matches none. */
  skippedMap: string | null;
  lastCatalogCheck: number;
  /** The active region's update at the last catalog check: the dots stay across restarts without a new fetch. */
  map: MapUpdate | null;
  /** The native build the notification announced (Android). */
  noticedBuild: number | null;
  /** Android 13+ asked once whether the app may notify. */
  askedNotifications: boolean;
  /** The native update the last check found ("build date"), or null: a trip that starts before this launch's check. */
  waitingBuild: string | null;
}

/** The IPA/APK download for the App update page. */
export interface BuildDownload {
  build: number;
  phase: "downloading" | "ready" | "failed";
  bytes: number;
  total: number;
  error?: string;
}

export interface UpdateCenterState {
  found: Found;
  /** The newest published build, even when it is not an update for this app. */
  latest: AppBuildInfo | null;
  /** The title of the commit the downloaded JS update was built from. */
  jsMessage: string | null;
  checking: boolean;
  lastCheck: number | null;
  checkError: string | null;
  download: BuildDownload | null;
  unmetered: boolean;
}

/**
 * What the update center needs from the rest of the app: is a trip or a route on (the map install gate), and what
 * a restart into a downloaded JS update would cut short.
 */
export interface UpdateCenterDeps {
  driving(): boolean;
  subscribeDriving(listener: () => void): () => void;
  activity(): Pick<ReloadContext, "recorder" | "route" | "link" | "speedMps" | "carScreen">;
  /** Any of `activity` changed: the trip, the route, the vehicle link. */
  subscribeActivity(listener: () => void): () => void;
}

let saved: Saved = {
  snoozed: {},
  skippedMap: null,
  lastCatalogCheck: 0,
  map: null,
  noticedBuild: null,
  askedNotifications: false,
  waitingBuild: null,
  ...(kvStore.getJson<Partial<Saved>>(STORE_KEY) ?? {}),
};
let state: UpdateCenterState = {
  found: { native: null, js: null, map: null, mapAction: "none" },
  latest: null,
  jsMessage: null,
  checking: false,
  lastCheck: null,
  checkError: null,
  download: null,
  unmetered: false,
};
const listeners = new Set<() => void>();
let started = false;
let downloadAbort: AbortController | null = null;
let deps: UpdateCenterDeps | null = null;
/** In the background since (ms), or null in front. */
let backgroundSince: number | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | undefined;
let reloading = false;
/** A system dialog of ours is up: Android calls that the background too, but the driver is looking. */
let asking = false;

function setState(patch: Partial<UpdateCenterState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function save(patch: Partial<Saved>) {
  saved = { ...saved, ...patch };
  kvStore.setJson(STORE_KEY, saved);
}

export const getUpdateCenter = () => state;
export const getSnoozed = () => saved.snoozed;

export function subscribeUpdateCenter(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUpdateCenter(): UpdateCenterState {
  return useSyncExternalStore(subscribeUpdateCenter, getUpdateCenter, getUpdateCenter);
}

const getBadges = () => badges(state.found);
let lastBadges = getBadges();
/** The dots on More and its rows (§5.4); a stable object between changes. */
export function useUpdateBadges(): ReturnType<typeof badges> {
  return useSyncExternalStore(subscribeUpdateCenter, () => {
    const next = getBadges();
    if (next.app !== lastBadges.app || next.maps !== lastBadges.maps) lastBadges = next;
    return lastBadges;
  });
}

/**
 * For the trip log (TRIP-LOGGER-SPEC §6.2): an app build the driver hasn't installed, and a downloaded JS update
 * waiting for a restart. Empty: none known.
 */
export function waitingUpdateInfo(): { upd_build: string; upd_js: string } {
  return { upd_build: saved.waitingBuild ?? "", upd_js: state.found.js ?? "" };
}

/** "Later": no prompt for this version for 3 days; the dots stay. */
export function snooze(key: string): void {
  const now = Date.now();
  const snoozed = Object.fromEntries(Object.entries(saved.snoozed).filter(([, until]) => until > now));
  save({ snoozed: { ...snoozed, [key]: now + SNOOZE_MS } });
}

/** "Skip" on a map prompt: no prompt and no dot for this release (its files, not its OSM date). */
export function skipMap(release: string): void {
  save({ skippedMap: release });
  refreshMap();
}

/** The JS update `useUpdates()` reports downloaded (UpdatePrompts), with its commit title. */
export function setJsReady(updateId: string | null, message: string | null): void {
  if (state.found.js === updateId && state.jsMessage === message) return;
  setState({ found: { ...state.found, js: updateId }, jsMessage: message });
}

/**
 * The active region's update, from the catalog already loaded: what it would cost and what to do. `start`: after a
 * check, an automatic update starts here (not on every change of the map's state: a cancelled one stays cancelled).
 */
function refreshMap({ start = false }: { start?: boolean } = {}) {
  const { installed, catalog, download } = getMapPacks();
  const region = installed.active;
  let map: MapUpdate | null = null;
  if (catalog) {
    if (region && regionNeedsUpdate(installed, catalog, region)) {
      const entry = catalog.regions.find((r) => r.region === region)!;
      const release = releaseFingerprint(catalog, region)!;
      map = { region, name: entry.name, osmDate: catalog.osm_date, release, bytes: plannedBytes(catalog, region) };
    }
    if (JSON.stringify(map) !== JSON.stringify(saved.map)) save({ map });
  } else if (saved.map?.release && saved.map.region === region && installedRelease(installed, region) !== saved.map.release) {
    // No catalog fetched since the app started: the last check's answer, while that region's files are other ones.
    map = saved.map;
  }
  // While that region downloads, there is nothing to ask.
  const busy = !!download && download.region === region;
  const action = busy ? "none" : mapAction(map, state.unmetered, saved.skippedMap);
  setState({ found: { ...state.found, map: busy ? null : map, mapAction: action } });
  if (start && action === "auto" && map && !download) void downloadMapUpdate(map.region);
}

/** Downloads the active region's update as an automatic one (installed never mid-drive), the catalog first if needed. */
export async function downloadMapUpdate(region: string): Promise<void> {
  if (!getMapPacks().catalog && !(await loadCatalog())) return;
  await downloadRegion(region, { auto: true });
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks for a newer build, JS update and map (§5.1). `launch`: any network, expo-updates checks the JS itself;
 * `resume`: only on an unmetered network and at most every 30 minutes; `manual` (Check now): always, everything.
 */
export async function checkForUpdates(reason: "launch" | "resume" | "manual"): Promise<void> {
  if (state.checking) return;
  // Taken before the first await: a foreground return and a network change fire together on resume.
  setState({ checking: true });
  const unmetered = await isUnmetered().catch(() => false);
  setState({ unmetered });
  if (reason === "resume" && (!unmetered || (state.lastCheck != null && Date.now() - state.lastCheck < RESUME_CHECK_MS))) {
    setState({ checking: false });
    return;
  }
  setState({ checkError: null });
  let error: string | null = null;
  try {
    const latest = await withTimeout(fetchLatestBuild);
    // Read from native at launch, in a few ms: unknown, no native update is offered.
    await nativeBuildReady;
    const native = nativeUpdate(latest, ownBuild());
    setState({ latest, found: { ...state.found, native } });
    save({ waitingBuild: native ? `${native.build} ${native.date.slice(0, 10)}` : null });
    void notifyNativeUpdate();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  if (reason !== "launch" && Updates.isEnabled) {
    try {
      // A new update is downloaded here; useUpdates() then reports it pending (UpdatePrompts tells setJsReady).
      const result = await Updates.checkForUpdateAsync();
      if (result.isAvailable) await Updates.fetchUpdateAsync();
    } catch (e) {
      error ??= e instanceof Error ? e.message : String(e);
    }
  }
  // At most every 6 hours, across restarts too (index.json is ~300 kB, maybe over mobile data); meanwhile the last
  // check's answer stands (`saved.map`).
  if (reason === "manual" || Date.now() - saved.lastCatalogCheck > CATALOG_CHECK_MS) {
    const catalog = await loadCatalog();
    if (catalog) save({ lastCatalogCheck: Date.now() });
    else error ??= getMapPacks().catalogError;
  }
  refreshMap({ start: true });
  setState({ checking: false, lastCheck: Date.now(), checkError: error });
}

/** Downloads the newest build's IPA/APK (App update page, or "Update" on the prompt), then on Android installs it. */
export async function getBuild({ install }: { install: boolean }): Promise<void> {
  const build = state.found.native ?? state.latest;
  if (!build || state.download?.phase === "downloading") return;
  downloadAbort = new AbortController();
  setState({ download: { build: build.build, phase: "downloading", bytes: 0, total: build.size } });
  try {
    const file = await downloadBuild(
      build,
      (bytes) => state.download?.phase === "downloading" && setState({ download: { ...state.download, bytes } }),
      downloadAbort.signal,
    );
    if (!file) {
      setState({ download: null });
      return;
    }
    setState({ download: { build: build.build, phase: "ready", bytes: build.size, total: build.size } });
    if (install) await openBuild();
  } catch (e) {
    Sentry.captureException(e, { tags: { feature: "app-update" } });
    setState({ download: { build: build.build, phase: "failed", bytes: 0, total: build.size, error: e instanceof Error ? e.message : String(e) } });
  }
}

export function cancelBuildDownload(): void {
  downloadAbort?.abort();
  setState({ download: null });
}

/** Opens the downloaded build: the installer on Android, the share sheet on iOS. */
export async function openBuild(): Promise<void> {
  const build = state.found.native ?? state.latest;
  const file = build && downloadedFile(build);
  if (!file) return;
  if (build.platform === "android") await installApk(file);
  else await shareIpa(file);
}

/**
 * Android: a notification for a native update, once per build (§5.3), taken back once it is installed. Android 13+
 * asks once whether the app may notify: in front and not while the car moves.
 */
async function notifyNativeUpdate(): Promise<void> {
  if (Platform.OS !== "android" || !AppNotice) return;
  const notice = updateNotice(state.found.native, saved.noticedBuild);
  if (notice.cancel) {
    AppNotice.cancelUpdateNotice();
    save({ noticedBuild: null });
  }
  if (notice.show == null) return;
  const moving = (deps?.activity().speedMps ?? 0) > MOVING_MPS;
  if (Number(Platform.Version) >= 33 && !saved.askedNotifications && AppState.currentState === "active" && !moving) {
    save({ askedNotifications: true });
    asking = true;
    await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => undefined);
    asking = false;
  }
  const strings = stringsNow();
  try {
    if (AppNotice.showUpdateNotice(strings.updateNoticeTitle, strings.updateNoticeText, strings.updateNoticeChannel, UPDATE_PAGE_URL)) {
      save({ noticedBuild: notice.show });
    }
  } catch (e) {
    Sentry.captureException(e, { tags: { feature: "app-update" } });
  }
}

/**
 * A downloaded JS update runs at once, in the background, when nothing would be cut short (§5.2, `reloadBlocker`);
 * otherwise from the next start. Android keeps the app's process for days, so the next start can be far off.
 */
function considerReload(): void {
  if (!deps || reloading || asking || AppState.currentState === "active") return;
  const map = getMapPacks().download;
  const blocker = reloadBlocker({
    jsPending: state.found.js != null,
    ...deps.activity(),
    downloading: state.download?.phase === "downloading" || (map != null && map.phase !== "paused"),
    backgroundSinceMs: backgroundSince,
    now: Date.now(),
  });
  if (blocker) return;
  reloading = true;
  Sentry.addBreadcrumb({ category: "app-update", message: `restart into JS update ${state.found.js} in the background` });
  Updates.reloadAsync().catch((e) => {
    reloading = false;
    Sentry.captureException(e, { tags: { feature: "app-update" } });
  });
}

/** In the background: the restart's chance, after `RELOAD_BACKGROUND_MS`; in front: none. */
function onAppState(appState: string): void {
  clearTimeout(reloadTimer);
  if (appState === "active") {
    backgroundSince = null;
    void checkForUpdates("resume");
    return;
  }
  if (appState !== "background") return;
  backgroundSince = Date.now();
  const due = backgroundSince + RELOAD_BACKGROUND_MS;
  reloadTimer = setTimeout(() => {
    // Late: the process was frozen and wakes now, most likely because the driver opens the app.
    if (Date.now() - due > RELOAD_LATE_MS) return;
    considerReload();
  }, RELOAD_BACKGROUND_MS);
}

/**
 * Starts the checks: at launch, on return to the foreground, and on a network change; gives the map downloads the
 * network (an update started on Wi-Fi pauses on mobile data and goes on back on Wi-Fi). Once per app life.
 */
export function startUpdateCenter(appDeps: UpdateCenterDeps): void {
  if (started) return;
  started = true;
  deps = appDeps;
  clearDownloads();
  setInstallGate({ allowed: () => !appDeps.driving(), subscribe: appDeps.subscribeDriving });
  // A trip that ends (its parked minutes over), a route that stops or the adapter going quiet while the app is in the
  // background: the restart's chance.
  appDeps.subscribeActivity(considerReload);
  // A download starts or ends, another region becomes active, a catalog arrives: the map update changes too. Not on
  // every progress tick.
  let seen: unknown[] = [];
  subscribeMapPacks(() => {
    const { installed, catalog, download } = getMapPacks();
    const next = [installed, catalog, download?.region, download?.phase];
    if (next.every((v, i) => v === seen[i])) return;
    seen = next;
    refreshMap();
  });
  // Downloads follow the network themselves (map-packs `followNetwork`): an update pauses off Wi-Fi, any download
  // with no network.
  setDownloadNetwork({ current: currentDownloadNetwork, subscribe: onDownloadNetwork });
  onNetworkChange((unmetered) => {
    if (unmetered === state.unmetered) return;
    setState({ unmetered });
    refreshMap({ start: unmetered });
  });
  AppState.addEventListener("change", onAppState);
  setTimeout(() => void checkForUpdates("launch"), LAUNCH_DELAY_MS);
}
