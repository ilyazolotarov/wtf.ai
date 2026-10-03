import { useEffect, useState } from "react";

import { tintDarkStyle, type MapStyleJson } from "@/config/map-dark";

/** OpenFreeMap Liberty in both color schemes (Calm redesign); dark re-tints it. */
export const MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

export type MapStyle = string | MapStyleJson;

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
 * Style for the current scheme. In dark mode this is `null` until the tinted
 * style is ready, so the map never flashes the light style at night; if the
 * fetch fails it falls back to plain Liberty.
 */
export function useMapStyle(scheme: "light" | "dark"): MapStyle | null {
  const [, setLoaded] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (scheme !== "dark" || darkStyle) return;
    let alive = true;
    loadDarkStyle().then(
      () => alive && setLoaded((n) => n + 1),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [scheme]);

  if (scheme === "light") return MAP_STYLE_URL;
  return darkStyle ?? (failed ? MAP_STYLE_URL : null);
}
