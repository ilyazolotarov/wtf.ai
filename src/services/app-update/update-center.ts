// The app's update checks (docs/UPDATES-SPEC.md §5): what is new for the app and the active region's map, the
// automatic map updates, and what the prompts and dots need. The prompts themselves are `UpdatePrompts` (map screen).
import * as Updates from "expo-updates";
import { AppState } from "react-native";
import { useSyncExternalStore } from "react";

import { Sentry } from "@/config/sentry";
import { kvStore } from "@/services/kv-store";
import {
  downloadRegion,
  getMapPacks,
  loadCatalog,
  pauseDownload,
  plannedBytes,
  regionNeedsUpdate,
  resumeDownload,
  setInstallGate,
  subscribeMapPacks,
} from "@/services/offline-map/map-packs";

import { badges, mapAction, nativeUpdate, SNOOZE_MS, type AppBuildInfo, type Found, type MapUpdate } from "./decide";
import {
  clearDownloads,
  downloadBuild,
  downloadedFile,
  fetchLatestBuild,
  installApk,
  ownBuild,
  shareIpa,
} from "./native-build";
import { isUnmetered, onNetworkChange } from "./network";

/** Back in front on an unmetered network: checks at most this often. */
const RESUME_CHECK_MS = 30 * 60 * 1000;
/** The map catalog changes weekly: fetched at most this often (a manual check always). */
const CATALOG_CHECK_MS = 6 * 3600 * 1000;
/** At launch, after the map is up. */
const LAUNCH_DELAY_MS = 5000;
const FETCH_TIMEOUT_MS = 15000;
const STORE_KEY = "app-update";

interface Saved {
  /** promptKey → until when "Later" holds it back. */
  snoozed: Record<string, number>;
  /** The OSM date the driver skipped for the active region. */
  skippedMap: string | null;
  lastCatalogCheck: number;
  /** The active region's update at the last catalog check: the dots stay across restarts without a new fetch. */
  map: MapUpdate | null;
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

/** What the update center needs from the rest of the app: is a trip or a route on (the install gate). */
export interface UpdateCenterDeps {
  driving(): boolean;
  subscribeDriving(listener: () => void): () => void;
}

let saved: Saved = {
  snoozed: {},
  skippedMap: null,
  lastCatalogCheck: 0,
  map: null,
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

/** "Later": no prompt for this version for 3 days; the dots stay. */
export function snooze(key: string): void {
  const now = Date.now();
  const snoozed = Object.fromEntries(Object.entries(saved.snoozed).filter(([, until]) => until > now));
  save({ snoozed: { ...snoozed, [key]: now + SNOOZE_MS } });
}

/** "Skip" on a map prompt: no prompt and no dot for this OSM date. */
export function skipMap(osmDate: string): void {
  save({ skippedMap: osmDate });
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
      map = { region, name: entry.name, osmDate: catalog.osm_date, bytes: plannedBytes(catalog, region) };
    }
    if (JSON.stringify(map) !== JSON.stringify(saved.map)) save({ map });
  } else if (saved.map && saved.map.region === region && installed.regions[region]?.osm_date !== saved.map.osmDate) {
    // No catalog fetched since the app started: the last check's answer, while that region is still the older one.
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
  const unmetered = await isUnmetered().catch(() => false);
  setState({ unmetered });
  if (reason === "resume" && (!unmetered || (state.lastCheck != null && Date.now() - state.lastCheck < RESUME_CHECK_MS))) return;
  setState({ checking: true, checkError: null });
  let error: string | null = null;
  try {
    const latest = await withTimeout(fetchLatestBuild);
    setState({ latest, found: { ...state.found, native: nativeUpdate(latest, ownBuild()) } });
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
 * Starts the checks: at launch, on return to the foreground, and the automatic map update's network rule (an update
 * started on Wi-Fi pauses on mobile data and goes on back on Wi-Fi). Once per app life.
 */
export function startUpdateCenter(deps: UpdateCenterDeps): void {
  if (started) return;
  started = true;
  clearDownloads();
  setInstallGate({ allowed: () => !deps.driving(), subscribe: deps.subscribeDriving });
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
  onNetworkChange((unmetered) => {
    if (unmetered === state.unmetered) return;
    setState({ unmetered });
    const { download } = getMapPacks();
    if (download?.auto && download.phase === "downloading" && !unmetered) pauseDownload();
    if (download?.auto && download.phase === "paused" && unmetered) void resumeDownload();
    refreshMap({ start: unmetered });
  });
  AppState.addEventListener("change", (s) => s === "active" && void checkForUpdates("resume"));
  setTimeout(() => void checkForUpdates("launch"), LAUNCH_DELAY_MS);
}
