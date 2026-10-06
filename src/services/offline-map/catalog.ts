/**
 * Offline map catalog: `index.json` of a map release built by `tools/tiles` (SPEC §3.8).
 * Published as GitHub release `maps-<osm_date>` by .github/workflows/map-packs.yml; a custom
 * base URL (`tiles serve` on a PC) replaces GitHub for testing.
 */
export const MAP_RELEASES_REPO = "ilyazolotarov/wtf.ai";
const RELEASE_TAG = /^maps-\d{4}-\d{2}-\d{2}$/;
const INDEX_FORMAT = 2;

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

async function latestReleaseBase(signal?: AbortSignal): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${MAP_RELEASES_REPO}/releases?per_page=30`, {
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
  return `https://github.com/${MAP_RELEASES_REPO}/releases/download/${tag}/`;
}

/** Newest published catalog, or the one at `customBaseUrl` when given. */
export async function fetchCatalog(customBaseUrl?: string, signal?: AbortSignal): Promise<MapCatalog> {
  const baseUrl = customBaseUrl?.trim()
    ? customBaseUrl.trim().replace(/\/*$/, "/")
    : await latestReleaseBase(signal);
  const res = await fetch(`${baseUrl}index.json`, { signal });
  if (!res.ok) throw new Error(`index.json: HTTP ${res.status}`);
  const index = (await res.json()) as Omit<MapCatalog, "baseUrl">;
  if (index.format !== INDEX_FORMAT) throw new Error(`Unsupported map catalog format ${index.format}`);
  return { ...index, baseUrl };
}

export const assetUrl = (catalog: MapCatalog, file: CatalogFile) =>
  catalog.baseUrl + encodeURIComponent(file.asset);
