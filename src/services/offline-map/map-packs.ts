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
 *
 * One download at a time. Tiles download in an iOS background session; a paused download
 * survives app restarts (DownloadTask.savable() in kv-store). Every file is checked against
 * the catalog's size and MD5 before it is used.
 */
export interface InstalledRegion {
  region: string;
  iso: string;
  name: { en: string; uk: string };
  bounds: [number, number, number, number];
  osm_date: string;
  size: number;
}

export interface InstalledState {
  common: { osm_date: string } | null;
  regions: Record<string, InstalledRegion>;
  active: string | null;
}

export interface MapDownload {
  region: string;
  phase: "common" | "tiles" | "verifying" | "paused";
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

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMapPacks(): MapPacksState {
  return useSyncExternalStore(subscribe, getState);
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

/** Shared style, sprites and glyphs for the catalog's release, swapped in only when all verify. */
async function ensureCommon(id: number, catalog: MapCatalog, region: string) {
  const { installed } = getState();
  if (installed.common?.osm_date === catalog.osm_date && new File(COMMON(), "style.json").exists) return;
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
  saveInstalled({ ...getState().installed, common: { osm_date: catalog.osm_date } });
}

function installTiles(entry: CatalogRegion, osm_date: string) {
  const part = partFile(entry.region);
  verify(part, entry, entry.asset);
  const dest = tilesFile(entry.region);
  if (dest.exists) dest.delete();
  part.rename(dest.name);
  const { installed } = getState();
  const { asset: _asset, md5: _md5, sha256: _sha256, ...info } = entry;
  saveInstalled({
    ...installed,
    regions: { ...installed.regions, [entry.region]: { ...info, osm_date } },
    active: installed.active && installed.regions[installed.active] ? installed.active : entry.region,
  });
}

/**
 * Runs the tiles download: a new one, the paused in-memory task, or one rebuilt from saved
 * state after a restart. Returns when complete or paused; throws on failure. Results of a run
 * that was cancelled meanwhile (`id` no longer current) are ignored.
 */
async function runTiles(id: number, entry: CatalogRegion, osm_date: string, url: string, saved?: DownloadPauseState) {
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
  if (id !== runId) return;
  if (file == null) {
    // Paused: keep the resume data so the download survives an app restart.
    kvStore.setJson(PAUSED_KEY, { region: entry, osm_date, url, state: task.savable() } satisfies PausedDownload);
    setDownload(entry.region, "paused", getState().download?.bytes ?? 0, entry.size);
    return;
  }
  task = null;
  kvStore.setJson(PAUSED_KEY, null);
  setDownload(entry.region, "verifying", entry.size, entry.size);
  await new Promise((resolve) => setTimeout(resolve, 50)); // let "verifying" render before MD5 blocks
  installTiles(entry, osm_date);
  setState({ download: null });
}

/** Drops the download and its partial file; shows `error` if given. */
function cleanUp(region: string, error?: unknown) {
  task = null;
  kvStore.setJson(PAUSED_KEY, null);
  const part = partFile(region);
  if (part.exists) part.delete();
  const message = error == null ? null : error instanceof Error ? error.message : String(error);
  setState({ download: null, downloadError: message });
}

export async function downloadRegion(region: string): Promise<void> {
  const { catalog, download } = getState();
  const entry = catalog?.regions.find((r) => r.region === region);
  if (!catalog || !entry || download) return;
  const id = ++runId;
  try {
    const needed = entry.size + catalog.common.reduce((sum, f) => sum + f.size, 0) + DISK_MARGIN;
    if (Paths.availableDiskSpace < needed) {
      throw new Error(`Not enough free space: ${Math.ceil(needed / 1e6)} MB needed`);
    }
    setState({ downloadError: null });
    await ensureCommon(id, catalog, region);
    if (id !== runId) return;
    const part = partFile(region);
    if (part.exists) part.delete();
    await runTiles(id, entry, catalog.osm_date, assetUrl(catalog, entry));
  } catch (e) {
    if (id === runId) cleanUp(region, e);
  }
}

export function pauseDownload(): void {
  if (task?.state === "active") task.pause();
}

export async function resumeDownload(): Promise<void> {
  const paused = kvStore.getJson<PausedDownload>(PAUSED_KEY);
  if (!paused) return;
  const id = ++runId;
  try {
    await runTiles(id, paused.region, paused.osm_date, paused.url, paused.state);
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
  const file = tilesFile(region);
  if (file.exists) file.delete();
  const { installed } = getState();
  const { [region]: _removed, ...regions } = installed.regions;
  const active = installed.active === region ? (Object.keys(regions)[0] ?? null) : installed.active;
  saveInstalled({ ...installed, regions, active });
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
