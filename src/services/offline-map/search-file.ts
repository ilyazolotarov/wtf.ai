// The active region's address search index (SEARCH-SPEC §6): the downloaded
// `<region>.search.bin`, read by random access like the road graph.

import { Directory, Paths } from "expo-file-system";

import { SearchIndex } from "@/nav/search/search-index";
import { fileHandleByteSource } from "@/services/offline-map/road-graph-file";
import { activeSearchFile, getMapPacks, type InstalledState } from "@/services/offline-map/map-packs";

let open: { key: string; region: string; index: SearchIndex; close(): void } | null = null;
/** A file that failed to open isn't retried until the installed index changes. */
let failedKey: string | null = null;

/**
 * The active region's search index; null when it has none (not downloaded, or an older release). In a component, pass
 * `useMapPacks().installed`: the React Compiler keeps a call without arguments for the component's life.
 */
export function activeSearchIndex(installed: InstalledState = getMapPacks().installed): SearchIndex | null {
  const active = activeSearchFile(installed);
  const key = active ? `${active.region}:${active.md5}` : null;
  if (open?.key === key) return open.index;
  open?.close();
  open = null;
  if (!active || !key || key === failedKey) return null;
  try {
    const source = fileHandleByteSource(active.file);
    open = { key, region: active.region, index: new SearchIndex(source), close: source.close };
    failedKey = null;
    dropEntranceFiles();
    return open.index;
  } catch (e) {
    failedKey = key;
    console.warn(`search index ${active.region}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

let entranceFilesDropped = false;

/**
 * The region's entrances as one GeoJSON file in the cache, which the map read until 2026-11-01 (`map-entrances.ts`
 * says why it no longer does): deleted once a run, a dozen MB for Ukraine.
 */
function dropEntranceFiles(): void {
  if (entranceFilesDropped) return;
  entranceFilesDropped = true;
  try {
    const dir = new Directory(Paths.cache, "entrances");
    if (dir.exists) dir.delete();
  } catch {
    // The cache is the OS's to clear too.
  }
}
