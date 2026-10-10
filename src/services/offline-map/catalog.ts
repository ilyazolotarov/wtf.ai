/**
 * Offline map catalog: `index.json` of a map release built by `tools/tiles` (SPEC §3.8).
 * Read from the update Worker (`maps/latest.json` → `maps/<osm_date>/`, docs/UPDATES-SPEC.md §4); while it has none
 * (or the build has no UPDATES_ORIGIN), from the newest GitHub release `maps-<osm_date>` of MAP_RELEASES_REPO. A custom
 * base URL (`tiles serve` on a PC) replaces both for testing.
 */
import { MAP_RELEASES_REPO, UPDATES_ORIGIN } from "@/config/app-updates";

/** Where published maps come from (app.config.js); null: not configured in this build. */
export interface MapServers {
  updatesOrigin: string | null;
  releasesRepo: string | null;
}

const SERVERS: MapServers = { updatesOrigin: UPDATES_ORIGIN, releasesRepo: MAP_RELEASES_REPO };
const RELEASE_TAG = /^maps-\d{4}-\d{2}-\d{2}$/;
const OSM_DATE = /^\d{4}-\d{2}-\d{2}$/;
const INDEX_FORMAT = 2;

/** A map release made for a newer app: Offline maps asks to update the app. */
export class CatalogFormatError extends Error {
  constructor(readonly format: number) {
    super(`Unsupported map catalog format ${format}`);
  }
}

export interface CatalogFile {
  /** Release asset name (flat). */
  asset: string;
  size: number;
  md5: string;
  sha256: string;
}

export interface CatalogCommonFile extends CatalogFile {
  /** Where the app stores it, relative to the common directory. */
  path: string;
}

export interface CatalogRegion extends CatalogFile {
  region: string;
  iso: string;
  name: { en: string; uk: string };
  /** [minLon, minLat, maxLon, maxLat] */
  bounds: [number, number, number, number];
  /** Simplified outer rings of [lon, lat] (~1 km); absent in releases built before it. */
  outline?: [number, number][][];
  /** Road graph for map matching (MAPMATCH-SPEC §4.6); absent: the region is display-only. */
  graph?: CatalogFile;
  /** Address search index (SEARCH-SPEC); absent in releases built before it. */
  search?: CatalogFile;
}

export interface MapCatalog {
  format: number;
  osm_date: string;
  built_at: string;
  common: CatalogCommonFile[];
  regions: CatalogRegion[];
  /** Base URL the assets are downloaded from (ends with `/`). */
  baseUrl: string;
}

async function latestReleaseBase(repo: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
    headers: { Accept: "application/vnd.github+json" },
    signal,
  });
  if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);
  const tags = ((await res.json()) as { tag_name: string }[])
    .map((r) => r.tag_name)
    .filter((tag) => RELEASE_TAG.test(tag))
    .sort();
  const tag = tags.at(-1);
  if (!tag) throw new Error("No map release published yet");
  return `https://github.com/${repo}/releases/download/${tag}/`;
}

/** The Worker's current release directory, or null while it has none. */
async function workerReleaseBase(origin: string, signal?: AbortSignal): Promise<string | null> {
  const res = await fetch(`${origin}/maps/latest.json`, { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Map catalog: HTTP ${res.status}`);
  const { osm_date } = (await res.json()) as { osm_date?: string };
  if (!osm_date || !OSM_DATE.test(osm_date)) throw new Error("Map catalog: no current release");
  return `${origin}/maps/${osm_date}/`;
}

async function publishedBase(servers: MapServers, signal?: AbortSignal): Promise<string> {
  const worker = servers.updatesOrigin ? await workerReleaseBase(servers.updatesOrigin, signal) : null;
  if (worker) return worker;
  if (servers.releasesRepo) return latestReleaseBase(servers.releasesRepo, signal);
  throw new Error("No map source in this build (UPDATES_ORIGIN, MAP_RELEASES_REPO): enter one under Map source");
}

/** Newest published catalog, or the one at `customBaseUrl` when given. */
export async function fetchCatalog(customBaseUrl?: string, signal?: AbortSignal, servers: MapServers = SERVERS): Promise<MapCatalog> {
  const baseUrl = customBaseUrl?.trim() ? customBaseUrl.trim().replace(/\/*$/, "/") : await publishedBase(servers, signal);
  const res = await fetch(`${baseUrl}index.json`, { signal });
  if (!res.ok) throw new Error(`index.json: HTTP ${res.status}`);
  const index = (await res.json()) as Omit<MapCatalog, "baseUrl">;
  if (index.format !== INDEX_FORMAT) throw new CatalogFormatError(index.format);
  return { ...index, baseUrl };
}

export const assetUrl = (catalog: MapCatalog, file: CatalogFile) =>
  catalog.baseUrl + encodeURIComponent(file.asset);
