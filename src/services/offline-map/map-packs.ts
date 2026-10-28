import { Directory, DownloadTask, File, Paths, type DownloadPauseState } from "expo-file-system";
import { useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";

import type { MapStyleJson } from "@/config/map-dark";
import { kvStore } from "@/services/kv-store";
import { assetUrl, CatalogFormatError, fetchCatalog, type CatalogRegion, type MapCatalog } from "@/services/offline-map/catalog";

/**
 * Offline map packs (SPEC §3.8), downloaded from the map catalog (catalog.ts):
 *
 *   Documents/maps/
 *     installed.json        InstalledState (what is complete and verified)
 *     common/               style.json, sprites/, fonts/ — shared by all regions
 *     <region>.<md5>.pmtiles one per installed region (InstalledRegion.tiles); `<region>.pmtiles.part` while downloading
 *     <region>.graph.bin    its road graph for map matching (MAPMATCH-SPEC §11); `.part` too
 *     <region>.search.bin   its address search index (SEARCH-SPEC); `.part` too
 *
 * One download at a time, shown as one: the shared files (when changed), tiles, graph and search index are
 * fetched in turn in an iOS background session into `common.staging/` and `.part` files, with
 * one byte count and pause/resume on whichever file is current. The job (with the current
 * file's DownloadTask.savable()) is kept in kv-store, so it survives app restarts. Only when
 * every file matches the catalog's size and MD5 is it all installed, in one step. An automatic update
 * (docs/UPDATES-SPEC.md §5.2) then waits, verified, until the install gate opens: never mid-drive.
 */
export interface InstalledRegion {
  region: string;
  iso: string;
  name: { en: string; uk: string };
  bounds: [number, number, number, number];
  /** From the catalog at install (absent for installs made before outlines). */
  outline?: [number, number][][];
  osm_date: string;
  size: number;
  /** Tiles checksum; absent on installs made before it was recorded. */
  md5?: string;
  /** Tiles file name (`tilesName`); absent on installs made before it changed with every update: `<region>.pmtiles`. */
  tiles?: string;
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
  /** `waiting`: an automatic update, verified, until the install gate opens (no trip, no route). */
  phase: "downloading" | "verifying" | "paused" | "waiting";
  bytes: number;
  total: number;
  /** Started by the app (an update on Wi-Fi), not by the driver. */
  auto: boolean;
  /** Paused by a dropped connection, not by the driver: it goes on by itself while the app is in front. */
  interrupted?: boolean;
  /** Paused because the app ended while checking or installing the files: waits for the driver's Resume. */
  checkEnded?: boolean;
}

export interface MapPacksState {
  installed: InstalledState;
  catalog: MapCatalog | null;
  /** When `catalog` was fetched (ms). */
  catalogAt: number | null;
  catalogLoading: boolean;
  catalogError: string | null;
  /** The published maps are for a newer app (another catalog format). */
  catalogTooNew: boolean;
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
  /** An automatic update: installed only once the gate allows. */
  auto?: boolean;
  files: JobFile[];
  /** Next file to fetch; bytes of the files before it. */
  index: number;
  done: number;
  total: number;
  /** Resume data of `files[index]` when paused mid-file. */
  resume?: DownloadPauseState;
  /** Paused with Pause: waits for Resume. Otherwise a job stopped (a dropped connection, the app ended) goes on. */
  pausedByDriver?: boolean;
  /** The step being checked or installed (a file's label, "small files", "install"); still set at start: the app ended in it. */
  checking?: string;
  /**
   * The app ended while checking or installing: the job waits for Resume and never goes on by itself, since the step
   * may end the app again (an iPhone killed for memory as the 1.19 GB Ukraine map was checked, at every launch).
   */
  checkEnded?: boolean;
}

const ROOT = () => new Directory(Paths.document, "maps");
const COMMON = () => new Directory(ROOT(), "common");
const STAGING = "common.staging";
/**
 * Every install of a region's tiles gets its own name. MapLibre keeps a PMTiles file's header and directories by URL
 * for the life of the app and never reads them again: an update written over the old name was read at the old
 * offsets, and every tile failed ("Error decompressing PMTiles tile").
 */
const tilesName = (region: string, md5: string) => `${region}.${md5.slice(0, 8)}.pmtiles`;
const tilesFile = (region: string, name: string | undefined) => new File(ROOT(), name ?? `${region}.pmtiles`);
const tilesPart = (region: string) => `${region}.pmtiles.part`;
const graphFile = (region: string) => new File(ROOT(), `${region}.graph.bin`);
const graphPart = (region: string) => `${region}.graph.bin.part`;
const searchFile = (region: string) => new File(ROOT(), `${region}.search.bin`);
const searchPart = (region: string) => `${region}.search.bin.part`;
const INSTALLED = () => new File(ROOT(), "installed.json");
const JOB_KEY = "map-download-job";
/** Key of the earlier tiles-only pause state; dropped on start. */
const LEGACY_PAUSED_KEY = "map-download-paused";
/** Files below this size are fetched `PARALLEL` at a time over a normal session. */
const SMALL_FILE = 4e6;
const PARALLEL = 6;
/** Keep this much free space beyond the download itself. */
const DISK_MARGIN = 300e6;
/**
 * An interrupted download tries again after these waits while the app is in front, and at once whenever it comes to
 * the front. Android cuts a background app's network (a Redmi: "Software caused connection abort", 2026-10-23/24), and
 * each failure used to drop every file fetched so far: the whole country again, several times, until the app stayed
 * open.
 */
const RETRY_MS = [5_000, 30_000, 120_000];

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
  if (job?.checking) {
    endedIn = job.checking;
    job.checking = undefined;
    job.checkEnded = true;
    saveJob();
  }
  return {
    installed: readInstalled(),
    catalog: null,
    catalogAt: null,
    catalogLoading: false,
    catalogError: null,
    catalogTooNew: false,
    // A job found at start is paused: the app was closed (or killed) during the download. Unless the driver paused
    // it (or it is an update, which waits for Wi-Fi), it goes on by itself.
    download: job
      ? {
          region: job.region.region,
          phase: "paused",
          bytes: job.done,
          total: job.total,
          auto: !!job.auto,
          ...(job.checkEnded ? { checkEnded: true } : resumesItself(job) ? { interrupted: true } : {}),
        }
      : null,
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
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retries = 0;
/** Told of every download that failed (the app sends it to Sentry); the screen shows the message itself. */
let reportFailure: (error: unknown, where: { region: string; file: string; index: number; files: number }) => void = () => {};
/** Told of each step of checking and installing (the app adds them to Sentry's breadcrumbs). */
let noteStep: (message: string) => void = () => {};
/** The step the app ended in last time (`DownloadJob.checking`), until reported. */
let endedIn: string | null = null;

/**
 * When an automatic update may replace the map in use, and a region just downloaded may become the map: not during a
 * trip or a route (set by the update center).
 */
export interface InstallGate {
  allowed(): boolean;
  subscribe(listener: () => void): () => void;
}
let installGate: InstallGate = { allowed: () => true, subscribe: () => () => {} };

export function setInstallGate(gate: InstallGate): void {
  installGate = gate;
}

/** A region downloaded during a trip or a route: becomes the map once the gate opens, unless the driver picks one. */
let pendingActive: (() => void) | null = null;

function activateWhenAllowed(region: string) {
  clearPendingActive();
  const unsubscribe = installGate.subscribe(() => {
    if (!installGate.allowed()) return;
    clearPendingActive();
    const { installed } = getState();
    if (installed.regions[region]) saveInstalled({ ...installed, active: region });
  });
  pendingActive = unsubscribe;
}

function clearPendingActive() {
  pendingActive?.();
  pendingActive = null;
}

/** Also told, once, when the app ended during a check or an install the last time it ran. */
export function onMapDownloadFailed(report: typeof reportFailure): void {
  reportFailure = report;
  getState();
  if (job && endedIn) {
    report(new Error(`The app ended while checking the map: ${endedIn}`), { region: job.region.region, file: endedIn, index: job.index, files: job.files.length });
  }
  endedIn = null;
}

export function onMapDownloadStep(note: typeof noteStep): void {
  noteStep = note;
}

function getState(): MapPacksState {
  if (!state) {
    state = initialState();
    // Already in front at launch, so no change of app state will come: an interrupted job goes on from here.
    if (state.download?.interrupted) scheduleRetry();
  }
  return state;
}

function setState(patch: Partial<MapPacksState>) {
  state = { ...getState(), ...patch };
  listeners.forEach((listener) => listener());
}

function setDownload(phase: MapDownload["phase"], bytes: number, interrupted = false) {
  if (job) setState({ download: { region: job.region.region, phase, bytes, total: job.total, auto: !!job.auto, ...(interrupted ? { interrupted } : {}) } });
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

/** Fetches the catalog; resolves with it (null when it failed: `catalogError` says why). */
export async function loadCatalog(): Promise<MapCatalog | null> {
  if (getState().catalogLoading) return null;
  setState({ catalogLoading: true, catalogError: null });
  try {
    const catalog = await fetchCatalog();
    setState({ catalog, catalogAt: Date.now(), catalogLoading: false, catalogTooNew: false });
    return catalog;
  } catch (e) {
    setState({ catalogLoading: false, catalogError: e instanceof Error ? e.message : String(e), catalogTooNew: e instanceof CatalogFormatError });
    return null;
  }
}

/** Throws unless `file` matches the catalog entry. MD5 runs natively but blocks for seconds on 1 GB. */
function verify(file: File, expected: { size: number; md5: string }, label: string) {
  const info = file.info({ md5: true });
  if (info.size !== expected.size) throw new Error(`${label}: ${info.size} bytes, expected ${expected.size}`);
  if (info.md5 !== expected.md5) throw new Error(`${label}: checksum mismatch`);
}

/** FNV-1a, 8 hex digits. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (const ch of text) hash = Math.imul(hash ^ ch.charCodeAt(0), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Identifies the shared files by content, not `osm_date`: a forced rebuild of the same OSM
 * extract (new glyphs, style fixes) keeps the date but changes the files. FNV-1a over the MD5s.
 */
export function commonFingerprint(catalog: MapCatalog): string {
  return fnv1a([...catalog.common].sort((a, b) => a.path.localeCompare(b.path)).map((e) => `${e.path}:${e.md5};`).join(""));
}

const releaseOf = (region: string, tiles?: string, graph?: string, search?: string, common?: string) =>
  fnv1a(`${region}:${tiles ?? ""}:${graph ?? ""}:${search ?? ""}:${common ?? ""}`);

/**
 * A region's map release by content: its tiles', road graph's and search index's MD5s and the shared files'. What a
 * skipped update is remembered by, not `osm_date`: a forced rebuild of the same extract that changes a file is offered
 * again (docs/UPDATES-SPEC.md §5.3). Null when the catalog has no such region.
 */
export function releaseFingerprint(catalog: MapCatalog, region: string): string | null {
  const entry = catalog.regions.find((r) => r.region === region);
  return entry ? releaseOf(region, entry.md5, entry.graph?.md5, entry.search?.md5, commonFingerprint(catalog)) : null;
}

/** The same for what is installed; a file recorded without its MD5 (older installs) never matches a release. */
export function installedRelease(installed: InstalledState, region: string): string | null {
  const have = installed.regions[region];
  if (!have) return null;
  return releaseOf(region, have.md5 ?? "?", have.graph?.md5, have.search?.md5, installed.common?.fingerprint ?? "?");
}

const commonCurrent = (installed: InstalledState, catalog: MapCatalog) =>
  installed.common?.fingerprint === commonFingerprint(catalog) && new File(COMMON(), "style.json").exists;

const tilesCurrent = (have: InstalledRegion | undefined, entry: CatalogRegion) =>
  have?.md5 === entry.md5 && tilesFile(entry.region, have?.tiles).exists;

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

/** The bytes a download of `region` would fetch now: only what changed. */
export function plannedBytes(catalog: MapCatalog, region: string): number {
  const entry = catalog.regions.find((r) => r.region === region);
  return entry ? planJob(catalog, entry).total : 0;
}

/** Resolves once the install gate allows, or when `stillWanted` says the job was dropped meanwhile. */
function gateOpen(stillWanted: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (installGate.allowed()) return resolve();
    const unsubscribe = installGate.subscribe(() => {
      if (!installGate.allowed() && stillWanted()) return;
      unsubscribe();
      resolve();
    });
  });
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

/**
 * Moves the verified files into place and records the region, all at once. A region downloaded for the first time
 * becomes the map (the driver just asked for it), during a trip or a route only once it is over; an update leaves the
 * active one as it is.
 */
function install(j: DownloadJob) {
  const region = j.region.region;
  const { installed } = getState();
  const have = installed.regions[region];
  const tiles = j.tiles ? tilesName(region, j.region.md5) : have?.tiles;
  if (j.common) {
    const common = COMMON();
    if (common.exists) common.delete();
    new Directory(ROOT(), STAGING).rename("common");
  }
  // The tiles they replace, under their own (older) name.
  if (j.tiles && tilesFile(region, have?.tiles).exists) tilesFile(region, have?.tiles).delete();
  for (const [want, part, dest] of [
    [j.tiles, tilesPart(region), tilesFile(region, tiles)],
    [j.graph, graphPart(region), graphFile(region)],
    [!!j.search, searchPart(region), searchFile(region)],
  ] as const) {
    if (!want) continue;
    if (dest.exists) dest.delete();
    new File(ROOT(), part).rename(dest.name);
  }
  const { asset: _asset, md5, sha256: _sha256, graph, search, size, ...info } = j.region;
  const regionGraph = j.graph && graph ? { size: graph.size, md5: graph.md5 } : have?.graph;
  const regionSearch = j.search && search ? { size: search.size, md5: search.md5 } : have?.search;
  const hasMap = !!installed.active && !!installed.regions[installed.active];
  const activateNow = !hasMap || (!have && installGate.allowed());
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
        ...(tiles ? { tiles } : {}),
        ...(regionGraph ? { graph: regionGraph } : {}),
        ...(regionSearch ? { search: regionSearch } : {}),
      },
    },
    active: activateNow ? region : installed.active,
  });
  if (!have && !activateNow) activateWhenAllowed(region);
}

/** Tries per small file before the download fails. */
const SMALL_TRIES = 3;

/**
 * One small file, tried again on failure with a new `File`: on Android, expo-modules-core looks up the destination
 * outside its registry's lock, so with parallel downloads and the garbage collector releasing other file objects it
 * can miss one that exists ("doesn't contain valid id"). Once that failed a whole region download.
 */
async function downloadSmall(b: JobFile): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const dest = new File(ROOT(), b.dest);
      dest.parentDirectory.create({ intermediates: true, idempotent: true });
      await File.downloadFileAsync(b.url, dest, { idempotent: true });
      return;
    } catch (e) {
      if (attempt >= SMALL_TRIES) throw e;
    }
  }
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
          await downloadSmall(b);
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
    } else if (resumeFromDisk(f)) {
      task = DownloadTask.fromSavable(resumeFromDisk(f)!, { onProgress });
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
  for (const f of j.files) {
    // Saved before each step, so a step that ends the app is known at the next start (one mark for the small files).
    const step = f.size < SMALL_FILE ? "small files" : f.label;
    if (j.checking !== step) markStep(j, step, `${f.size} bytes`);
    const t0 = Date.now();
    verify(new File(ROOT(), f.dest), f, f.label);
    if (f.size >= SMALL_FILE) noteStep(`checked ${f.label} in ${Date.now() - t0} ms`);
  }
  j.checking = undefined;
  saveJob();
  if (id !== runId) return;
  if (j.auto && !installGate.allowed()) {
    setDownload("waiting", j.total);
    await gateOpen(() => id === runId);
    if (id !== runId) return;
  }
  markStep(j, "install");
  install(j);
  noteStep(`installed ${j.region.region}`);
  job = null;
  saveJob();
  setState({ download: null });
}

function markStep(j: DownloadJob, step: string, detail?: string) {
  j.checking = step;
  saveJob();
  noteStep(detail ? `${step}: ${detail}` : step);
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
    retries = 0;
  } catch (e) {
    if (id !== runId) return;
    if (job && job.index < job.files.length && dropped(e)) {
      // A dropped connection mid-file: what is fetched stays, and the download goes on (`scheduleRetry`).
      const f = job.files[job.index];
      if (retries === 0) reportFailure(e, { region: job.region.region, file: f.label, index: job.index, files: job.files.length });
      task = null;
      job.resume = undefined;
      saveJob();
      setDownload("paused", job.done + partBytes(f), true);
      scheduleRetry();
      return;
    }
    if (job) {
      // Past the last file, it failed verifying or installing.
      const file = job.files[job.index]?.label ?? "verify";
      reportFailure(e, { region: job.region.region, file, index: job.index, files: job.files.length });
    }
    cleanUp(e);
  }
}

/** `auto`: an update the app started by itself (docs/UPDATES-SPEC.md §5.2), installed only once the gate allows. */
export async function downloadRegion(region: string, { auto = false }: { auto?: boolean } = {}): Promise<void> {
  const { catalog, download } = getState();
  const entry = catalog?.regions.find((r) => r.region === region);
  if (!catalog || !entry || download) return;
  const id = ++runId;
  const planned = { ...planJob(catalog, entry), auto };
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
  if (job) job.pausedByDriver = true;
  pauseRequested = true;
  if (task?.state === "active") task.pause();
}

export async function resumeDownload(): Promise<void> {
  if (!job || getState().download?.phase !== "paused") return;
  clearRetry();
  job.pausedByDriver = false;
  job.checkEnded = false;
  setDownload("downloading", getState().download?.bytes ?? job.done);
  await runGuarded(++runId);
}

export function cancelDownload(): void {
  clearRetry();
  runId++;
  task?.cancel();
  cleanUp();
}

export function removeRegion(region: string): void {
  const { installed } = getState();
  for (const file of [tilesFile(region, installed.regions[region]?.tiles), graphFile(region), searchFile(region)]) {
    if (file.exists) file.delete();
  }
  const { [region]: _removed, ...regions } = installed.regions;
  const active = installed.active === region ? (Object.keys(regions)[0] ?? null) : installed.active;
  // Last region gone: drop the shared files too, so a fresh download fetches them anew
  // (unless a download in progress has already fetched them for its own region).
  const last = Object.keys(regions).length === 0 && !getState().download;
  if (last && COMMON().exists) COMMON().delete();
  saveInstalled({ ...installed, regions, active, common: last ? null : installed.common });
}

export function setActiveRegion(region: string): void {
  clearPendingActive();
  const { installed } = getState();
  if (installed.regions[region]) saveInstalled({ ...installed, active: region });
}

/**
 * A job stopped without the driver's Pause, and not an update (which waits for Wi-Fi), nor one whose check ended the
 * app: it goes on by itself.
 */
function resumesItself(j: DownloadJob): boolean {
  return !j.pausedByDriver && !j.auto && !j.checkEnded;
}

/**
 * A failure of the connection (a timeout, a dropped or aborted stream), not of the file or the server (an HTTP error,
 * a size or checksum that doesn't match), which would only fail again.
 */
function dropped(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return !/HTTP [45]\d\d|checksum|expected|space|resume data/i.test(message);
}

/** Bytes of `f` already on disk (Android writes into the part file as it goes). */
function partBytes(f: JobFile): number {
  const part = new File(ROOT(), f.dest);
  return part.exists ? Math.min(part.size, f.size) : 0;
}

/**
 * Android resumes a file from the bytes on disk (a Range request from the part's length), so a file cut off by an error
 * or by the app ending goes on from there. iOS's resume data is opaque and only Pause makes it: there the file starts
 * again, the files before it kept.
 */
function resumeFromDisk(f: JobFile): DownloadPauseState | undefined {
  if (Platform.OS !== "android") return undefined;
  const part = new File(ROOT(), f.dest);
  if (!part.exists || part.size <= 0 || part.size >= f.size) return undefined;
  return { url: f.url, fileUri: part.uri, isDirectory: false, resumeData: String(part.size) };
}

function clearRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

/** The interrupted download again after the next wait, if the app is in front; else when it comes to the front. */
function scheduleRetry() {
  clearRetry();
  if (AppState.currentState !== "active" || retries >= RETRY_MS.length) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retries++;
    if (getState().download?.interrupted) void resumeDownload();
  }, RETRY_MS[retries]);
}

AppState.addEventListener("change", (appState) => {
  if (appState !== "active" || !getState().download?.interrupted) return;
  retries = 0;
  void resumeDownload();
});

/** Style for the active region, or `null` when no pack is usable. */
export function readActiveStyle(installed: InstalledState): MapStyleJson | null {
  const region = installed.active;
  if (!region || !installed.common) return null;
  const tiles = tilesFile(region, installed.regions[region]?.tiles);
  const style = new File(COMMON(), "style.json");
  if (!tiles.exists || !style.exists) return null;
  const raw = style
    .textSync()
    .replaceAll("{common}", COMMON().uri.replace(/\/$/, ""))
    .replaceAll("{tiles}", tiles.uri);
  return JSON.parse(raw) as MapStyleJson;
}

/**
 * The speed cameras of the installed maps (`cameras.json`, shared files since 2026-10-28; UI-SPEC §6.5), all of Ukraine,
 * and their key (the shared files' fingerprint); `null` without them.
 */
export function activeCamerasFile(installed: InstalledState): { key: string; file: File } | null {
  if (!installed.common) return null;
  const file = new File(COMMON(), "cameras.json");
  return file.exists ? { key: installed.common.fingerprint ?? installed.common.osm_date, file } : null;
}

/** The world drawn around the active region (`world.geojson`, shared files since 2026-10-10), or `null`. */
export function readActiveWorld(installed: InstalledState): { url: string; region: string } | null {
  const region = installed.active;
  if (!region || !installed.common) return null;
  const world = new File(COMMON(), "world.geojson");
  return world.exists ? { url: world.uri, region } : null;
}
