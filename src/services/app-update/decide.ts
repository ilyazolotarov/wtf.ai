// What the app does about the updates it found (docs/UPDATES-SPEC.md §5.2–5.4). Pure: the update center feeds it.

/** A native build as the update Worker publishes it (`apps/<platform>/latest.json`, tools/ota/protocol.ts `AppBuild`). */
export interface AppBuildInfo {
  platform: "ios" | "android";
  version: string;
  build: number;
  runtime: string;
  commit: string;
  date: string;
  file: string;
  size: number;
  md5: string;
  notes: string[];
}

/** This app's build: its number, its runtime, and whether it takes updates at all (Release, expo-updates on). */
export interface OwnBuild {
  build: number | null;
  runtime: string | null;
  release: boolean;
}

/** Downloads of the active region's map at most this big come by themselves on an unmetered network. */
export const AUTO_MAP_BYTES = 300e6;
/** "Later" keeps a prompt away this long; the dots stay. */
export const SNOOZE_MS = 3 * 24 * 3600 * 1000;
/** Moving faster than this, nothing prompts. */
export const MOVING_MPS = 2;

/**
 * The build to offer, or null. A newer build with the same runtime brings nothing the JS updates don't, so only one
 * with another runtime counts; Debug builds and dev clients never update.
 */
export function nativeUpdate(latest: AppBuildInfo | null, own: OwnBuild): AppBuildInfo | null {
  if (!latest || !own.release || own.build == null) return null;
  return latest.build > own.build && latest.runtime !== own.runtime ? latest : null;
}

/** The active region's map update: what to do with it. */
export interface MapUpdate {
  region: string;
  name: { en: string; uk: string };
  osmDate: string;
  /** What the download would fetch (only the files that changed). */
  bytes: number;
}

export type MapAction = "auto" | "prompt" | "dot" | "none";

export function mapAction(update: MapUpdate | null, unmetered: boolean, skippedOsmDate: string | null): MapAction {
  if (!update || skippedOsmDate === update.osmDate) return "none";
  if (!unmetered) return "dot";
  return update.bytes <= AUTO_MAP_BYTES ? "auto" : "prompt";
}

export type PromptKind = "native" | "js" | "map";

export interface Found {
  native: AppBuildInfo | null;
  /** A JS update downloaded and waiting for a restart (its update id). */
  js: string | null;
  map: MapUpdate | null;
  mapAction: MapAction;
}

/** Identifies a prompt's version, for "Later". */
export function promptKey(kind: PromptKind, found: Found): string | null {
  if (kind === "native") return found.native ? `native:${found.native.build}` : null;
  if (kind === "js") return found.js ? `js:${found.js}` : null;
  return found.map && found.mapAction === "prompt" ? `map:${found.map.region}:${found.map.osmDate}` : null;
}

export interface PromptContext {
  /** A trip records, a route is on, an adapter is connected, the car moves, or the map isn't on screen. */
  busy: boolean;
  now: number;
  /** promptKey → until when "Later" holds it back. */
  snoozed: Record<string, number>;
  /** Prompts already shown since the app started: one each per launch. */
  shown: ReadonlySet<string>;
}

/** The one prompt to show now, the most important first; null when nothing should interrupt. */
export function nextPrompt(found: Found, ctx: PromptContext): { kind: PromptKind; key: string } | null {
  if (ctx.busy) return null;
  for (const kind of ["native", "js", "map"] as const) {
    const key = promptKey(kind, found);
    if (key && !ctx.shown.has(key) && !((ctx.snoozed[key] ?? 0) > ctx.now)) return { kind, key };
  }
  return null;
}

/** The red dots (§5.4): on More, and on its App update and Offline maps rows. */
export function badges(found: Found): { app: boolean; maps: boolean; any: boolean } {
  const app = found.native != null || found.js != null;
  const maps = found.map != null && (found.mapAction === "prompt" || found.mapAction === "dot");
  return { app, maps, any: app || maps };
}

/**
 * The notification for a native update (Android, §5.3): the build to announce once, or null; `cancel` when the one
 * shown is no longer an update (installed, or withdrawn). A driver who opens the app only in the car never sees the
 * prompt there (busy), so the notification waits for them at home (2026-10-14: a tester drove 3 days and 7 builds
 * behind, the dot on More unnoticed).
 */
export function updateNotice(native: AppBuildInfo | null, noticed: number | null): { show: number | null; cancel: boolean } {
  if (!native) return { show: null, cancel: noticed != null };
  return { show: native.build === noticed ? null : native.build, cancel: false };
}

/** What the app is doing that a reload would cut short (the update center's own downloads are added to it). */
export interface ReloadContext {
  /** A JS update is downloaded and waits for a restart. */
  jsPending: boolean;
  recorder: "idle" | "armed" | "recording" | "lingering";
  route: boolean;
  /** The vehicle link's state (`LinkState`). */
  link: string;
  speedMps: number | undefined;
  /** A map or app download in progress. */
  downloading: boolean;
  /** The app has been in the background since. */
  backgroundSinceMs: number | null;
  now: number;
}

/**
 * In the background at least this long before the restart: not on a glance at another app. Under Android's ~10 s
 * before it freezes a cached app, after which the timer would only fire as the app opens again.
 */
export const RELOAD_BACKGROUND_MS = 5000;
/**
 * The adapter connecting, or the car answering: a driver getting in or sitting in it. Not `reconnecting` after a
 * trip: the adapter goes quiet about a minute after the engine stops, and its link retries while the car stands.
 */
const LINK_BUSY = new Set(["connecting", "probing", "initializing", "standby", "polling"]);

/**
 * Why the downloaded JS update can't run yet by itself, or null: it may (§5.2). Only in the background, so nobody
 * sees the restart, and only with nothing going on: the trip recorder idle (not armed by an adapter, recording, or in
 * its parked minutes), no route, the adapter not connecting or answering, not moving, no download. A trip's end in
 * the background is a chance too (the update center checks again on every change of these). Otherwise it runs from
 * the next start, as before.
 */
export function reloadBlocker(c: ReloadContext): string | null {
  if (!c.jsPending) return "no update";
  if (c.backgroundSinceMs == null || c.now - c.backgroundSinceMs < RELOAD_BACKGROUND_MS) return "in front";
  if (c.recorder !== "idle") return `trip ${c.recorder}`;
  if (c.route) return "route";
  if (LINK_BUSY.has(c.link)) return `adapter ${c.link}`;
  if ((c.speedMps ?? 0) > MOVING_MPS) return "moving";
  if (c.downloading) return "download";
  return null;
}
