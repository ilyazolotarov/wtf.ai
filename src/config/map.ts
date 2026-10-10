import { useMemo } from "react";

import { tintDarkStyle, type MapStyleJson } from "@/config/map-dark";
import { withWorld } from "@/config/map-world";
import { readActiveStyle, readActiveWorld, useMapPacks, type InstalledState } from "@/services/offline-map/map-packs";

/**
 * The map draws only the active offline region (SPEC §3.8): OpenFreeMap Liberty, built into
 * the release by `tools/tiles`, with the world drawn around it (`map-world`), re-tinted for dark
 * mode. There is no online map: without a downloaded region the app asks for one first (`map-setup`).
 */
export type MapStyle = MapStyleJson;

/**
 * The map data credit MapLibre's (i) button shows (OSMF attribution guidelines: in a corner of the map; OpenMapTiles
 * schema, CC BY 4.0). Map packs built before 2026-10-10 carry none in their style, so it is set on every vector source
 * that lacks one.
 */
export const MAP_ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a> ' +
  '<a href="https://www.openmaptiles.org/">© OpenMapTiles</a>';

export function withAttribution(style: MapStyleJson): MapStyleJson {
  const sources = style.sources as Record<string, { type?: string; attribution?: string }> | undefined;
  if (!sources) return style;
  const fixed = Object.fromEntries(
    Object.entries(sources).map(([id, source]) => [id, source.type === "vector" && !source.attribution ? { ...source, attribution: MAP_ATTRIBUTION } : source]),
  );
  return { ...style, sources: fixed };
}

/** Active offline region's style for the scheme, or `null` when there is no usable pack. */
function packStyle(installed: InstalledState, scheme: "light" | "dark"): MapStyleJson | null {
  try {
    const read = readActiveStyle(installed);
    if (!read) return null;
    const style = withWorld(withAttribution(read), readActiveWorld(installed));
    return scheme === "dark" ? tintDarkStyle(style) : style;
  } catch (error) {
    console.warn("Offline map style unreadable", error);
    return null;
  }
}

/** Style for the current scheme; `null` while no offline region is usable. */
export function useMapStyle(scheme: "light" | "dark"): MapStyle | null {
  const { installed } = useMapPacks();
  return useMemo(() => packStyle(installed, scheme), [installed, scheme]);
}

/** True once an offline region is downloaded, active and readable: the app can be used. */
export function hasUsableMap(installed: InstalledState): boolean {
  return packStyle(installed, "light") !== null;
}

export function useHasUsableMap(): boolean {
  const { installed } = useMapPacks();
  return useMemo(() => hasUsableMap(installed), [installed]);
}
