// The active region's address search index (SEARCH-SPEC §6): the downloaded
// `<region>.search.bin`, read by random access like the road graph.

import { SearchIndex } from "@/nav/search/search-index";
import { fileHandleByteSource } from "@/services/offline-map/road-graph-file";
import { activeSearchFile, getMapPacks } from "@/services/offline-map/map-packs";

let open: { key: string; region: string; index: SearchIndex; close(): void } | null = null;
/** A file that failed to open isn't retried until the installed index changes. */
let failedKey: string | null = null;

/** The active region's search index; null when it has none (not downloaded, or an older release). */
export function activeSearchIndex(): SearchIndex | null {
  const active = activeSearchFile(getMapPacks().installed);
  const key = active ? `${active.region}:${active.md5}` : null;
  if (open?.key === key) return open.index;
  open?.close();
  open = null;
  if (!active || !key || key === failedKey) return null;
  try {
    const source = fileHandleByteSource(active.file);
    open = { key, region: active.region, index: new SearchIndex(source), close: source.close };
    failedKey = null;
    return open.index;
  } catch (e) {
    failedKey = key;
    console.warn(`search index ${active.region}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
