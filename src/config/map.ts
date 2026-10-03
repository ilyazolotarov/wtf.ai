import { useEffect, useMemo, useState } from "react";

import { tintDarkStyle, type MapStyleJson } from "@/config/map-dark";
import { readActiveStyle, useMapPacks, type InstalledState } from "@/services/offline-map/map-packs";

/**
 * OpenFreeMap Liberty in both color schemes (Calm redesign); dark re-tints it.
 * Used only while no offline map is downloaded (SPEC §9 privacy exception).
 */
export const MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

export type MapStyle = string | MapStyleJson;

/** Active offline region's style for the scheme, or `null` when there is no usable pack. */
function packStyle(installed: InstalledState, scheme: "light" | "dark"): MapStyleJson | null {
  try {
    const style = readActiveStyle(installed);
    if (!style) return null;
    return scheme === "dark" ? tintDarkStyle(style) : style;
  } catch (error) {
    console.warn("Offline map style unreadable, using online map", error);
    return null;
  }
}

let darkStyle: MapStyleJson | null = null;
let darkStyleRequest: Promise<MapStyleJson> | null = null;

function loadDarkStyle(): Promise<MapStyleJson> {
  darkStyleRequest ??= fetch(MAP_STYLE_URL)
    .then((res) => {
      if (!res.ok) throw new Error(`Map style HTTP ${res.status}`);
      return res.json() as Promise<MapStyleJson>;
    })
    .then((style) => (darkStyle = tintDarkStyle(style)))
    .catch((error: unknown) => {
      darkStyleRequest = null;
      throw error;
    });
  return darkStyleRequest;
}

/**
 * Style for the current scheme: the active offline region if one is downloaded, else
 * online Liberty. Online dark mode is `null` until the tinted style is ready, so
 * the map never flashes the light style at night; if the fetch fails it falls
 * back to plain Liberty.
 */
export function useMapStyle(scheme: "light" | "dark"): MapStyle | null {
  const [, setLoaded] = useState(0);
  const [failed, setFailed] = useState(false);
  const { installed } = useMapPacks();
  const offline = useMemo(() => packStyle(installed, scheme), [installed, scheme]);

  useEffect(() => {
    if (offline || scheme !== "dark" || darkStyle) return;
    let alive = true;
    loadDarkStyle().then(
      () => alive && setLoaded((n) => n + 1),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [offline, scheme]);

  if (offline) return offline;
  if (scheme === "light") return MAP_STYLE_URL;
  return darkStyle ?? (failed ? MAP_STYLE_URL : null);
}
