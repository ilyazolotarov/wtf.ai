import { Directory, DownloadTask, File, Paths, type DownloadPauseState } from "expo-file-system";
import { useSyncExternalStore } from "react";

import type { MapStyleJson } from "@/config/map-dark";
import { kvStore } from "@/services/kv-store";
import { assetUrl, fetchCatalog, type CatalogRegion, type MapCatalog } from "@/services/offline-map/catalog";

/**
 * Offline map packs (SPEC §3.8), downloaded from the map catalog (catalog.ts):
 *
 *   Documents/maps/
 *     installed.json        InstalledState (what is complete and verified)
 *     common/               style.json, sprites/, fonts/ — shared by all regions
 *     <region>.pmtiles      one per installed region; `.part` while downloading
 *     <region>.graph.bin    its road graph for map matching (MAPMATCH-SPEC §11); `.part` too
 *
 * One download at a time. Tiles download in an iOS background session; a paused download
 * survives app restarts (DownloadTask.savable() in kv-store). The graph follows the tiles in
 * the foreground (an oblast's is 10–40 MB). Every file is checked against the catalog's size
 * and MD5 before it is used.
 */
export interface InstalledRegion {
  region: string;
  iso: string;
  name: { en: string; uk: string };
  bounds: [number, number, number, number];
  osm_date: string;
  size: number;
  /** Tiles checksum; absent on installs made before it was recorded. */
  md5?: string;
  /** Road graph; absent until downloaded (regions installed before graphs get it as an update). */
  graph?: { size: number; md5: string };
}

export interface InstalledState {
  /** `fingerprint` (of the shared files' MD5s) is absent on installs made before it was recorded. */
  common: { osm_date: string; fingerprint?: string } | null;
  regions: Record<string, InstalledRegion>;
  active: string | null;
}

export interface MapDownload {
  region: string;
  phase: "common" | "tiles" | "graph" | "verifying" | "paused";
  bytes: number;
  total: number;
}

export interface MapPacksState {
  installed: InstalledState;
  catalog: MapCatalog | null;
  catalogLoading: boolean;
  catalogError: string | null;
  download: MapDownload | null;
  downloadError: string | null;
}

interface PausedDownload {
  region: CatalogRegion;
  osm_date: string;
  url: string;
  state: DownloadPauseState;
}

const ROOT = () => new Directory(Paths.document, "maps");
const COMMON = () => new Directory(ROOT(), "common");
const tilesFile = (region: string) => new File(ROOT(), `${region}.pmtiles`);
const partFile = (region: string) => new File(ROOT(), `${region}.pmtiles.part`);
const graphFile = (region: string) => new File(ROOT(), `${region}.graph.bin`);
const graphPartFile = (region: string) => new File(ROOT(), `${region}.graph.bin.part`);
const INSTALLED = () => new File(ROOT(), "installed.json");
const PAUSED_KEY = "map-download-paused";
const CATALOG_URL_KEY = "map-catalog-url";
/** Keep this much free space beyond the download itself. */
const DISK_MARGIN = 300e6;

const EMPTY: InstalledState = { common: null, regions: {}, active: null };

function readInstalled(): InstalledState {
  try {
    const file = INSTALLED();
    return file.exists ? { ...EMPTY, ...(JSON.parse(file.textSync()) as InstalledState) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

function initialState(): MapPacksState {
  const paused = kvStore.getJson<PausedDownload>(PAUSED_KEY);
  return {
    installed: readInstalled(),
    catalog: null,
    catalogLoading: false,
    catalogError: null,
    download: paused ? { region: paused.region.region, phase: "paused", bytes: 0, total: paused.region.size } : null,
    downloadError: null,
  };
}

let state: MapPacksState | null = null;
const listeners = new Set<() => void>();
let task: DownloadTask | null = null;
/** Incremented by every start, resume and cancel; a stale run ignores its own result. */
let runId = 0;

function getState(): MapPacksState {
  state ??= initialState();
  return state;
}

function setState(patch: Partial<MapPacksState>) {
  state = { ...getState(), ...patch };
  listeners.forEach((listener) => listener());
}

function setDownload(region: string, phase: MapDownload["phase"], bytes: number, total: number) {
  setState({ download: { region, phase, bytes, total } });
}

function saveInstalled(installed: InstalledState) {
  const root = ROOT();
  if (!root.exists) root.create({ intermediates: true });
  INSTALLED().write(JSON.stringify(installed));
  setState({ installed });
}

export function subscribeMapPacks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const getMapPacks = getState;

export function useMapPacks(): MapPacksState {
  return useSyncExternalStore(subscribeMapPacks, getState);
}

export const getCatalogUrl = () => kvStore.getJson<string>(CATALOG_URL_KEY) ?? "";
export const setCatalogUrl = (url: string) => kvStore.setJson(CATALOG_URL_KEY, url.trim());

export async function loadCatalog(): Promise<void> {
  if (getState().catalogLoading) return;
  setState({ catalogLoading: true, catalogError: null });
  try {
    setState({ catalog: await fetchCatalog(getCatalogUrl()), catalogLoading: false });
  } catch (e) {
    setState({ catalogLoading: false, catalogError: e instanceof Error ? e.message : String(e) });
  }
}

/** Throws unless `file` matches the catalog entry. MD5 runs natively but blocks for seconds on 1 GB. */
function verify(file: File, expected: { size: number; md5: string }, label: string) {
  const info = file.info({ md5: true });
  if (info.size !== expected.size) throw new Error(`${label}: ${info.size} bytes, expected ${expected.size}`);
  if (info.md5 !== expected.md5) throw new Error(`${label}: checksum mismatch`);
}

/**
 * Identifies the shared files by content, not `osm_date`: a forced rebuild of the same OSM
 * extract (new glyphs, style fixes) keeps the date but changes the files. FNV-1a over the MD5s.
 */
function commonFingerprint(catalog: MapCatalog): string {
  let hash = 0x811c9dc5;
  for (const entry of [...catalog.common].sort((a, b) => a.path.localeCompare(b.path))) {
    for (const ch of `${entry.path}:${entry.md5};`) hash = Math.imul(hash ^ ch.charCodeAt(0), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const commonCurrent = (installed: InstalledState, catalog: MapCatalog) =>
  installed.common?.fingerprint === commonFingerprint(catalog) && new File(COMMON(), "style.json").exists;

const tilesCurrent = (have: InstalledRegion | undefined, entry: CatalogRegion) =>
  have?.md5 === entry.md5 && tilesFile(entry.region).exists;

/** True also when the catalog has no graph for the region: nothing to fetch. */
const graphCurrent = (have: InstalledRegion | undefined, entry: CatalogRegion) =>
  !entry.graph || (have?.graph?.md5 === entry.graph.md5 && graphFile(entry.region).exists);

/** An installed region whose tiles, graph or shared files differ from the catalog's. */
export function regionNeedsUpdate(installed: InstalledState, catalog: MapCatalog, region: string): boolean {
  const have = installed.regions[region];
  const entry = catalog.regions.find((r) => r.region === region);
  if (!have || !entry) return false;
  return !tilesCurrent(have, entry) || !graphCurrent(have, entry) || !commonCurrent(installed, catalog);
}

/** The active region's road graph file; null when it has none (display-only, or not downloaded yet). */
export function activeGraphFile(installed: InstalledState): { region: string; file: File; md5: string } | null {
  const region = installed.active;
  const graph = region ? installed.regions[region]?.graph : undefined;
  if (!region || !graph) return null;
  const file = graphFile(region);
  return file.exists ? { region, file, md5: graph.md5 } : null;
}

/** Shared style, sprites and glyphs for the catalog's release, swapped in only when all verify. */
async function ensureCommon(id: number, catalog: MapCatalog, region: string) {
  const { installed } = getState();
  if (commonCurrent(installed, catalog)) return;
  const total = catalog.common.reduce((sum, f) => sum + f.size, 0);
  const staging = new Directory(ROOT(), "common.staging");
  if (staging.exists) staging.delete();
  staging.create({ intermediates: true });
  let bytes = 0;
  for (const entry of catalog.common) {
    if (id !== runId) return;
    setDownload(region, "common", bytes, total);
    const dest = new File(staging, entry.path);
    dest.parentDirectory.create({ intermediates: true, idempotent: true });
    await File.downloadFileAsync(assetUrl(catalog, entry), dest, { idempotent: true });
    verify(dest, entry, entry.asset);
    bytes += entry.size;
  }
  const common = COMMON();
  if (common.exists) common.delete();
  staging.rename("common");
  saveInstalled({
    ...getState().installed,
    common: { osm_date: catalog.osm_date, fingerprint: commonFingerprint(catalog) },
  });
}

function installTiles(entry: CatalogRegion, osm_date: string) {
  const part = partFile(entry.region);
  verify(part, entry, entry.asset);
  const dest = tilesFile(entry.region);
  if (dest.exists) dest.delete();
  part.rename(dest.name);
  const { installed } = getState();
  const { asset: _asset, sha256: _sha256, graph: _graph, ...info } = entry;
  // The graph installed so far stays until ensureGraph replaces it.
  const graph = installed.regions[entry.region]?.graph;
  saveInstalled({
    ...installed,
    regions: { ...installed.regions, [entry.region]: { ...info, osm_date, ...(graph ? { graph } : {}) } },
    active: installed.active && installed.regions[installed.active] ? installed.active : entry.region,
  });
}

/**
 * Runs the tiles download: a new one, the paused in-memory task, or one rebuilt from saved
 * state after a restart. Returns true once the tiles are installed, false when paused or
 * cancelled; throws on failure. Results of a run that was cancelled meanwhile (`id` no longer
 * current) are ignored.
 */
async function runTiles(id: number, entry: CatalogRegion, osm_date: string, url: string, saved?: DownloadPauseState): Promise<boolean> {
  // Not gated on `id`: a paused in-memory task keeps the callback from the run that created it.
  const onProgress = ({ bytesWritten }: { bytesWritten: number }) => {
    if (getState().download?.region === entry.region) setDownload(entry.region, "tiles", bytesWritten, entry.size);
  };
  let operation: Promise<File | null>;
  if (task?.state === "paused") {
    operation = task.resumeAsync();
  } else if (saved) {
    task = DownloadTask.fromSavable(saved, { onProgress });
    operation = task.resumeAsync();
  } else {
    task = new DownloadTask(url, partFile(entry.region), { onProgress, sessionType: "background" });
    operation = task.downloadAsync();
  }
  setDownload(entry.region, "tiles", getState().download?.bytes ?? 0, entry.size);
  setState({ downloadError: null });
  const file = await operation;
  if (id !== runId) return false;
  if (file == null) {
    // Paused: keep the resume data so the download survives an app restart.
    kvStore.setJson(PAUSED_KEY, { region: entry, osm_date, url, state: task.savable() } satisfies PausedDownload);
    setDownload(entry.region, "paused", getState().download?.bytes ?? 0, entry.size);
    return false;
  }
  task = null;
  kvStore.setJson(PAUSED_KEY, null);
  setDownload(entry.region, "verifying", entry.size, entry.size);
  await letRender(); // "verifying" before MD5 blocks
  installTiles(entry, osm_date);
  return true;
}

const letRender = () => new Promise((resolve) => setTimeout(resolve, 50));

/**
 * The region's road graph, when the catalog has one that isn't installed yet. Foreground and
 * not pausable: it is small next to the tiles (Ukraine's is the exception, ~450 MB).
 */
async function ensureGraph(id: number, baseUrl: string, entry: CatalogRegion) {
  const graph = entry.graph;
  if (!graph || graphCurrent(getState().installed.regions[entry.region], entry)) return;
  const part = graphPartFile(entry.region);
  if (part.exists) part.delete();
  setDownload(entry.region, "graph", 0, graph.size);
  const onProgress = ({ bytesWritten }: { bytesWritten: number }) => {
    if (getState().download?.region === entry.region) setDownload(entry.region, "graph", bytesWritten, graph.size);
  };
  task = new DownloadTask(baseUrl + encodeURIComponent(graph.asset), part, { onProgress });
  const file = await task.downloadAsync();
  if (id !== runId || file == null) return;
  task = null;
  setDownload(entry.region, "verifying", graph.size, graph.size);
  await letRender();
  verify(part, graph, graph.asset);
  const dest = graphFile(entry.region);
  if (dest.exists) dest.delete();
  part.rename(dest.name);
  const { installed } = getState();
  const have = installed.regions[entry.region];
  if (!have) return;
  saveInstalled({
    ...installed,
    regions: { ...installed.regions, [entry.region]: { ...have, graph: { size: graph.size, md5: graph.md5 } } },
  });
}

/** Drops the download and its partial file; shows `error` if given. */
function cleanUp(region: string, error?: unknown) {
  task = null;
  kvStore.setJson(PAUSED_KEY, null);
  for (const part of [partFile(region), graphPartFile(region)]) if (part.exists) part.delete();
  const message = error == null ? null : error instanceof Error ? error.message : String(error);
  setState({ download: null, downloadError: message });
}

export async function downloadRegion(region: string): Promise<void> {
  const { catalog, download } = getState();
  const entry = catalog?.regions.find((r) => r.region === region);
  if (!catalog || !entry || download) return;
  const id = ++runId;
  try {
    // Update of a region whose tiles didn't change: only the shared files and the graph are fetched.
    const have = getState().installed.regions[region];
    const tiles = tilesCurrent(have, entry) ? 0 : entry.size;
    const graph = graphCurrent(have, entry) ? 0 : (entry.graph?.size ?? 0);
    const needed = tiles + graph + catalog.common.reduce((sum, f) => sum + f.size, 0) + DISK_MARGIN;
    if (Paths.availableDiskSpace < needed) {
      throw new Error(`Not enough free space: ${Math.ceil(needed / 1e6)} MB needed`);
    }
    setState({ downloadError: null });
    await ensureCommon(id, catalog, region);
    if (id !== runId) return;
    if (tiles > 0) {
      const part = partFile(region);
      if (part.exists) part.delete();
      if (!(await runTiles(id, entry, catalog.osm_date, assetUrl(catalog, entry)))) return;
    }
    await ensureGraph(id, catalog.baseUrl, entry);
    if (id === runId) setState({ download: null });
  } catch (e) {
    if (id === runId) cleanUp(region, e);
  }
}

/** Only the tiles pause; the graph download is short. */
export function pauseDownload(): void {
  if (getState().download?.phase === "tiles" && task?.state === "active") task.pause();
}

export async function resumeDownload(): Promise<void> {
  const paused = kvStore.getJson<PausedDownload>(PAUSED_KEY);
  if (!paused) return;
  const id = ++runId;
  try {
    if (!(await runTiles(id, paused.region, paused.osm_date, paused.url, paused.state))) return;
    // The graph is an asset of the same release as the tiles.
    await ensureGraph(id, paused.url.slice(0, paused.url.lastIndexOf("/") + 1), paused.region);
    if (id === runId) setState({ download: null });
  } catch (e) {
    if (id === runId) cleanUp(paused.region.region, e);
  }
}

export function cancelDownload(): void {
  const region = getState().download?.region;
  runId++;
  task?.cancel();
  if (region) cleanUp(region);
}

export function removeRegion(region: string): void {
  for (const file of [tilesFile(region), graphFile(region)]) if (file.exists) file.delete();
  const { installed } = getState();
  const { [region]: _removed, ...regions } = installed.regions;
  const active = installed.active === region ? (Object.keys(regions)[0] ?? null) : installed.active;
  // Last region gone: drop the shared files too, so a fresh download fetches them anew
  // (unless a download in progress has already fetched them for its own region).
  const last = Object.keys(regions).length === 0 && !getState().download;
  if (last && COMMON().exists) COMMON().delete();
  saveInstalled({ ...installed, regions, active, common: last ? null : installed.common });
}

export function setActiveRegion(region: string): void {
  const { installed } = getState();
  if (installed.regions[region]) saveInstalled({ ...installed, active: region });
}

/** Style for the active region, or `null` when no pack is usable. */
export function readActiveStyle(installed: InstalledState): MapStyleJson | null {
  const region = installed.active;
  if (!region || !installed.common) return null;
  const tiles = tilesFile(region);
  const style = new File(COMMON(), "style.json");
  if (!tiles.exists || !style.exists) return null;
  const raw = style
    .textSync()
    .replaceAll("{common}", COMMON().uri.replace(/\/$/, ""))
    .replaceAll("{tiles}", tiles.uri);
  return JSON.parse(raw) as MapStyleJson;
}
