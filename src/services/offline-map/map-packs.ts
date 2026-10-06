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
 *     <region>.search.bin   its address search index (SEARCH-SPEC); `.part` too
 *
 * One download at a time, shown as one: the shared files (when changed), tiles, graph and search index are
 * fetched in turn in an iOS background session into `common.staging/` and `.part` files, with
 * one byte count and pause/resume on whichever file is current. The job (with the current
 * file's DownloadTask.savable()) is kept in kv-store, so it survives app restarts. Only when
 * every file matches the catalog's size and MD5 is it all installed, in one step.
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
  /** Search index; absent until downloaded (an update for regions installed before it). */
  search?: { size: number; md5: string };
}

export interface InstalledState {
  /** `fingerprint` (of the shared files' MD5s) is absent on installs made before it was recorded. */
  common: { osm_date: string; fingerprint?: string } | null;
  regions: Record<string, InstalledRegion>;
  active: string | null;
}

/** Progress of the whole download (shared files, tiles and road graph together), in bytes. */
export interface MapDownload {
  region: string;
  phase: "downloading" | "verifying" | "paused";
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

/** One file of a download job; `dest` is relative to the maps directory. */
interface JobFile {
  url: string;
  dest: string;
  size: number;
  md5: string;
  label: string;
}

/**
 * A region download: every file it needs, fetched one after another into staging locations,
 * then verified and installed together. Saved in kv-store, so a paused (or interrupted)
 * download survives an app restart.
 */
interface DownloadJob {
  region: CatalogRegion;
  osm_date: string;
  /** Shared files to install (into `common/`), when they are part of this job. */
  common: { osm_date: string; fingerprint: string } | null;
  tiles: boolean;
  graph: boolean;
  /** Absent in jobs saved before search indexes. */
  search?: boolean;
  files: JobFile[];
  /** Next file to fetch; bytes of the files before it. */
  index: number;
  done: number;
  total: number;
  /** Resume data of `files[index]` when paused mid-file. */
  resume?: DownloadPauseState;
}

const ROOT = () => new Directory(Paths.document, "maps");
const COMMON = () => new Directory(ROOT(), "common");
const STAGING = "common.staging";
const tilesFile = (region: string) => new File(ROOT(), `${region}.pmtiles`);
const tilesPart = (region: string) => `${region}.pmtiles.part`;
const graphFile = (region: string) => new File(ROOT(), `${region}.graph.bin`);
const graphPart = (region: string) => `${region}.graph.bin.part`;
const searchFile = (region: string) => new File(ROOT(), `${region}.search.bin`);
const searchPart = (region: string) => `${region}.search.bin.part`;
const INSTALLED = () => new File(ROOT(), "installed.json");
const JOB_KEY = "map-download-job";
/** Key of the earlier tiles-only pause state; dropped on start. */
const LEGACY_PAUSED_KEY = "map-download-paused";
const CATALOG_URL_KEY = "map-catalog-url";
/** Files below this size are fetched `PARALLEL` at a time over a normal session. */
const SMALL_FILE = 4e6;
const PARALLEL = 6;
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
  kvStore.setJson(LEGACY_PAUSED_KEY, null);
  job = kvStore.getJson<DownloadJob>(JOB_KEY);
  return {
    installed: readInstalled(),
    catalog: null,
    catalogLoading: false,
    catalogError: null,
    // A job found at start is paused: the app was closed (or killed) during the download.
    download: job ? { region: job.region.region, phase: "paused", bytes: job.done, total: job.total } : null,
    downloadError: null,
  };
}

let state: MapPacksState | null = null;
const listeners = new Set<() => void>();
let job: DownloadJob | null = null;
let task: DownloadTask | null = null;
/** Set by pause; honoured between small-file batches (the big files pause their task). */
let pauseRequested = false;
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

function setDownload(phase: MapDownload["phase"], bytes: number) {
  if (job) setState({ download: { region: job.region.region, phase, bytes, total: job.total } });
}

function saveJob() {
  kvStore.setJson(JOB_KEY, job);
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

/** True also when the catalog has no search index for the region. */
const searchCurrent = (have: InstalledRegion | undefined, entry: CatalogRegion) =>
  !entry.search || (have?.search?.md5 === entry.search.md5 && searchFile(entry.region).exists);

/** An installed region whose tiles, graph, search index or shared files differ from the catalog's. */
export function regionNeedsUpdate(installed: InstalledState, catalog: MapCatalog, region: string): boolean {
  const have = installed.regions[region];
  const entry = catalog.regions.find((r) => r.region === region);
  if (!have || !entry) return false;
  return (
    !tilesCurrent(have, entry) ||
    !graphCurrent(have, entry) ||
    !searchCurrent(have, entry) ||
    !commonCurrent(installed, catalog)
  );
}

/** The active region's road graph file; null when it has none (display-only, or not downloaded yet). */
export function activeGraphFile(installed: InstalledState): { region: string; file: File; md5: string } | null {
  const region = installed.active;
  const graph = region ? installed.regions[region]?.graph : undefined;
  if (!region || !graph) return null;
  const file = graphFile(region);
  return file.exists ? { region, file, md5: graph.md5 } : null;
}

/** The active region's search index file; null when it has none. */
export function activeSearchFile(installed: InstalledState): { region: string; file: File; md5: string } | null {
  const region = installed.active;
  const search = region ? installed.regions[region]?.search : undefined;
  if (!region || !search) return null;
  const file = searchFile(region);
  return file.exists ? { region, file, md5: search.md5 } : null;
}

/** What `region` still lacks: shared files (if changed), tiles, graph and search index (if changed). */
function planJob(catalog: MapCatalog, entry: CatalogRegion): DownloadJob {
  const { installed } = getState();
  const have = installed.regions[entry.region];
  const files: JobFile[] = [];
  const common = !commonCurrent(installed, catalog);
  if (common) {
    for (const f of catalog.common) {
      files.push({ url: assetUrl(catalog, f), dest: `${STAGING}/${f.path}`, size: f.size, md5: f.md5, label: f.asset });
    }
  }
  const tiles = !tilesCurrent(have, entry);
  if (tiles) {
    files.push({ url: assetUrl(catalog, entry), dest: tilesPart(entry.region), size: entry.size, md5: entry.md5, label: entry.asset });
  }
  const graph = !graphCurrent(have, entry) && entry.graph ? entry.graph : null;
  if (graph) {
    files.push({ url: assetUrl(catalog, graph), dest: graphPart(entry.region), size: graph.size, md5: graph.md5, label: graph.asset });
  }
  const search = !searchCurrent(have, entry) && entry.search ? entry.search : null;
  if (search) {
    files.push({ url: assetUrl(catalog, search), dest: searchPart(entry.region), size: search.size, md5: search.md5, label: search.asset });
  }
  return {
    region: entry,
    osm_date: catalog.osm_date,
    common: common ? { osm_date: catalog.osm_date, fingerprint: commonFingerprint(catalog) } : null,
    tiles,
    graph: !!graph,
    search: !!search,
    files,
    index: 0,
    done: 0,
    total: files.reduce((sum, f) => sum + f.size, 0),
  };
}

const letRender = () => new Promise((resolve) => setTimeout(resolve, 50));

/** Moves the verified files into place and records the region, all at once. */
function install(j: DownloadJob) {
  const region = j.region.region;
  if (j.common) {
    const common = COMMON();
    if (common.exists) common.delete();
    new Directory(ROOT(), STAGING).rename("common");
  }
  for (const [want, part, dest] of [
    [j.tiles, tilesPart(region), tilesFile(region)],
    [j.graph, graphPart(region), graphFile(region)],
    [!!j.search, searchPart(region), searchFile(region)],
  ] as const) {
    if (!want) continue;
    if (dest.exists) dest.delete();
    new File(ROOT(), part).rename(dest.name);
  }
  const { installed } = getState();
  const have = installed.regions[region];
  const { asset: _asset, md5, sha256: _sha256, graph, search, size, ...info } = j.region;
  const regionGraph = j.graph && graph ? { size: graph.size, md5: graph.md5 } : have?.graph;
  const regionSearch = j.search && search ? { size: search.size, md5: search.md5 } : have?.search;
  saveInstalled({
    ...installed,
    common: j.common ?? installed.common,
    regions: {
      ...installed.regions,
      [region]: {
        ...info,
        osm_date: j.tiles ? j.osm_date : (have?.osm_date ?? j.osm_date),
        size: j.tiles ? size : (have?.size ?? size),
        md5: j.tiles ? md5 : have?.md5,
        ...(regionGraph ? { graph: regionGraph } : {}),
        ...(regionSearch ? { search: regionSearch } : {}),
      },
    },
    active: installed.active && installed.regions[installed.active] ? installed.active : region,
  });
}

/**
 * Fetches the job's remaining files (resuming the current one when paused), then verifies and
 * installs them. Stops quietly when paused or when a newer run (cancel, restart) takes over.
 */
async function run(id: number) {
  const j = job;
  if (!j) return;
  setState({ downloadError: null });
  pauseRequested = false;
  while (j.index < j.files.length) {
    // Pause pressed while no task was running (between files).
    if (pauseRequested && task?.state !== "paused") {
      setDownload("paused", j.done);
      return;
    }
    const f = j.files[j.index];
    const index = j.index;
    if (f.size < SMALL_FILE && !j.resume && task?.state !== "paused") {
      // A batch of small files (glyphs, sprites) in parallel over a normal session: one by one
      // through the background session, each with its own redirect, crawls.
      const batch: JobFile[] = [];
      for (let k = index; k < j.files.length && batch.length < PARALLEL && j.files[k].size < SMALL_FILE; k++) {
        batch.push(j.files[k]);
      }
      let fetched = 0;
      await Promise.all(
        batch.map(async (b) => {
          const dest = new File(ROOT(), b.dest);
          dest.parentDirectory.create({ intermediates: true, idempotent: true });
          await File.downloadFileAsync(b.url, dest, { idempotent: true });
          fetched += b.size;
          if (id === runId) setDownload("downloading", j.done + fetched);
        }),
      );
      if (id !== runId) return;
      j.done += fetched;
      j.index += batch.length;
      saveJob();
      // Pause lands between batches; a batch takes a moment.
      if (pauseRequested) {
        setDownload("paused", j.done);
        return;
      }
      continue;
    }
    // Not gated on `id`: a paused in-memory task keeps the callback from the run that created it.
    const onProgress = ({ bytesWritten }: { bytesWritten: number }) => {
      if (job === j && j.index === index && getState().download?.phase === "downloading") {
        setDownload("downloading", j.done + bytesWritten);
      }
    };
    let operation: Promise<File | null>;
    if (task?.state === "paused") {
      operation = task.resumeAsync();
    } else if (j.resume) {
      task = DownloadTask.fromSavable(j.resume, { onProgress });
      operation = task.resumeAsync();
    } else {
      const dest = new File(ROOT(), f.dest);
      dest.parentDirectory.create({ intermediates: true, idempotent: true });
      if (dest.exists) dest.delete();
      task = new DownloadTask(f.url, dest, { onProgress, sessionType: "background" });
      operation = task.downloadAsync();
    }
    setDownload("downloading", Math.max(j.done, getState().download?.bytes ?? 0));
    const file = await operation;
    if (id !== runId) return;
    if (file == null) {
      j.resume = task?.savable();
      saveJob();
      setDownload("paused", getState().download?.bytes ?? j.done);
      return;
    }
    task = null;
    j.resume = undefined;
    j.done += f.size;
    j.index++;
    saveJob();
  }
  setDownload("verifying", j.total);
  await letRender(); // "verifying" before MD5 blocks
  for (const f of j.files) verify(new File(ROOT(), f.dest), f, f.label);
  if (id !== runId) return;
  install(j);
  job = null;
  saveJob();
  setState({ download: null });
}

/** Drops the job and its partial files; shows `error` if given. */
function cleanUp(error?: unknown) {
  task = null;
  if (job) {
    for (const f of job.files) {
      const part = new File(ROOT(), f.dest);
      if (part.exists) part.delete();
    }
  }
  const staging = new Directory(ROOT(), STAGING);
  if (staging.exists) staging.delete();
  job = null;
  saveJob();
  const message = error == null ? null : error instanceof Error ? error.message : String(error);
  setState({ download: null, downloadError: message });
}

async function runGuarded(id: number) {
  try {
    await run(id);
  } catch (e) {
    if (id === runId) cleanUp(e);
  }
}

export async function downloadRegion(region: string): Promise<void> {
  const { catalog, download } = getState();
  const entry = catalog?.regions.find((r) => r.region === region);
  if (!catalog || !entry || download) return;
  const id = ++runId;
  const planned = planJob(catalog, entry);
  if (planned.files.length === 0) return;
  const needed = planned.total + DISK_MARGIN;
  if (Paths.availableDiskSpace < needed) {
    setState({ downloadError: `Not enough free space: ${Math.ceil(needed / 1e6)} MB needed` });
    return;
  }
  const staging = new Directory(ROOT(), STAGING);
  if (staging.exists) staging.delete();
  job = planned;
  saveJob();
  setDownload("downloading", 0);
  await runGuarded(id);
}

export function pauseDownload(): void {
  if (getState().download?.phase !== "downloading") return;
  pauseRequested = true;
  if (task?.state === "active") task.pause();
}

export async function resumeDownload(): Promise<void> {
  if (!job || getState().download?.phase !== "paused") return;
  await runGuarded(++runId);
}

export function cancelDownload(): void {
  runId++;
  task?.cancel();
  cleanUp();
}

export function removeRegion(region: string): void {
  for (const file of [tilesFile(region), graphFile(region), searchFile(region)]) if (file.exists) file.delete();
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
