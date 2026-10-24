// The active region's building entrances as a GeoJSON file for the map (SEARCH-SPEC §5): read once from the
// region's search file (its entrance section) and written to the cache, so MapLibre reads it natively instead of
// a region's worth of points crossing the bridge on every render.

import { Directory, File, Paths } from "expo-file-system";
import { useMemo } from "react";

import { activeSearchIndex } from "@/services/offline-map/search-file";
import { activeSearchFile, getMapPacks, useMapPacks, type InstalledState } from "@/services/offline-map/map-packs";

const DIR = () => new Directory(Paths.cache, "entrances");

/** File URL of the active region's entrances; null without a search file that has them. */
export function activeEntrancesUrl(installed: InstalledState = getMapPacks().installed): string | null {
  const active = activeSearchFile(installed);
  const index = activeSearchIndex();
  if (!active || !index) return null;
  try {
    const dir = DIR();
    if (!dir.exists) dir.create({ intermediates: true });
    const name = `${active.region}-${active.md5}.geojson`;
    const file = new File(dir, name);
    if (file.exists) return file.uri;
    const entrances = index.allEntrances();
    if (entrances.length === 0) return null;
    // `r`: the number, "" without one.
    const features = entrances.map(
      (e) =>
        `{"type":"Feature","geometry":{"type":"Point","coordinates":[${e.lon.toFixed(6)},${e.lat.toFixed(6)}]},"properties":{"r":${JSON.stringify(e.ref ?? "")}}}`,
    );
    file.create({ overwrite: true });
    file.write(`{"type":"FeatureCollection","features":[${features.join(",")}]}`);
    // The region's files from earlier search files (map updates) go.
    for (const old of dir.list()) if (old.name !== name && old.name.startsWith(`${active.region}-`)) old.delete();
    return file.uri;
  } catch (e) {
    console.warn(`entrances ${active.region}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** `activeEntrancesUrl`, again when the installed maps change. */
export function useEntrancesUrl(): string | null {
  const { installed } = useMapPacks();
  return useMemo(() => activeEntrancesUrl(installed), [installed]);
}
