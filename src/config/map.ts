import { useMemo } from "react";

import { tintDarkStyle, type MapStyleJson } from "@/config/map-dark";
import { readActiveStyle, useMapPacks, type InstalledState } from "@/services/offline-map/map-packs";

/**
 * The map draws only the active offline region (SPEC §3.8): OpenFreeMap Liberty, built into
 * the release by `tools/tiles`, re-tinted for dark mode. There is no online map: without a
 * downloaded region the app asks for one first (`map-setup`).
 */
export type MapStyle = MapStyleJson;

/** Active offline region's style for the scheme, or `null` when there is no usable pack. */
function packStyle(installed: InstalledState, scheme: "light" | "dark"): MapStyleJson | null {
  try {
    const style = readActiveStyle(installed);
    if (!style) return null;
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
