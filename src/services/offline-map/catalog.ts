/**
 * Offline map catalog: `index.json` of a map release built by `tools/tiles` (SPEC §3.8).
 * Read from the update Worker (`maps/latest.json` → `maps/<osm_date>/`, docs/UPDATES-SPEC.md §4).
 */
import { UPDATES_ORIGIN } from "@/config/app-updates";

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

/** The Worker's current release directory. */
async function publishedBase(origin: string | null, signal?: AbortSignal): Promise<string> {
  if (!origin) throw new Error("No map source in this build (UPDATES_ORIGIN)");
  const res = await fetch(`${origin}/maps/latest.json`, { signal });
  if (res.status === 404) throw new Error("No map release published yet");
  if (!res.ok) throw new Error(`Map catalog: HTTP ${res.status}`);
  const { osm_date } = (await res.json()) as { osm_date?: string };
  if (!osm_date || !OSM_DATE.test(osm_date)) throw new Error("Map catalog: no current release");
  return `${origin}/maps/${osm_date}/`;
}

/** Newest published catalog. */
export async function fetchCatalog(signal?: AbortSignal, origin: string | null = UPDATES_ORIGIN): Promise<MapCatalog> {
  const baseUrl = await publishedBase(origin, signal);
  const res = await fetch(`${baseUrl}index.json`, { signal });
  if (!res.ok) throw new Error(`index.json: HTTP ${res.status}`);
  const index = (await res.json()) as Omit<MapCatalog, "baseUrl">;
  if (index.format !== INDEX_FORMAT) throw new CatalogFormatError(index.format);
  return { ...index, baseUrl };
}

export const assetUrl = (catalog: MapCatalog, file: CatalogFile) =>
  catalog.baseUrl + encodeURIComponent(file.asset);
