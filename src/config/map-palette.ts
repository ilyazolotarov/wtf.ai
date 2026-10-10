import type { MapStyleJson } from "./map-dark";

/** The colours the map draws its ground, water and streets in (#RRGGBB). */
export interface MapPalette {
  land: string;
  building: string;
  park: string;
  water: string;
  minor: string;
  minorCasing: string;
  /** Main streets (trunk and primary). */
  major: string;
  majorCasing: string;
}

/** The Liberty layer and paint property each colour is read from. */
const ROLES: Record<keyof MapPalette, [layer: string, prop: string]> = {
  land: ["background", "background-color"],
  building: ["building", "fill-color"],
  park: ["park", "fill-color"],
  water: ["water", "fill-color"],
  minor: ["road_minor", "line-color"],
  minorCasing: ["road_minor_casing", "line-color"],
  major: ["road_trunk_primary", "line-color"],
  majorCasing: ["road_trunk_primary_casing", "line-color"],
};

/** Street level: where a zoom-dependent colour is read. */
const STREET_ZOOM = 16;

/**
 * The palette of a map style as the map draws it: the active pack's Liberty, or the same re-tinted for dark mode
 * (`tintDarkStyle`), so whatever draws "a map" elsewhere (the Guide's lessons) matches the real one. Null when a
 * layer is missing or its colour can't be read.
 */
export function stylePalette(style: MapStyleJson): MapPalette | null {
  const out: Partial<MapPalette> = {};
  for (const [role, [layerId, prop]] of Object.entries(ROLES) as [keyof MapPalette, [string, string]][]) {
    const paint = style.layers.find((l) => l.id === layerId)?.paint;
    const value = valueAt(paint?.[prop], STREET_ZOOM);
    const hex = typeof value === "string" ? cssToHex(value) : null;
    if (hex === null) return null;
    out[role] = hex;
  }
  // A translucent fill (Liberty's parks: 0.7) shows the land through it: the colour the map shows.
  for (const role of ["building", "park", "water"] as const) {
    const opacity = valueAt(style.layers.find((l) => l.id === ROLES[role][0])?.paint?.["fill-opacity"], STREET_ZOOM);
    if (typeof opacity === "number" && opacity < 1) out[role] = blend(out.land!, out[role]!, opacity);
  }
  return out as MapPalette;
}

/**
 * A paint value at `zoom`: a literal; the stop of a zoom `interpolate`/`step` at or below it; a `match`'s default
 * (the dark map's main streets: orange trunk roads, else amber, and the lessons draw ordinary main streets).
 */
function valueAt(value: unknown, zoom: number): unknown {
  if (!Array.isArray(value)) return value;
  const [op] = value;
  if (op === "match") return valueAt(value[value.length - 1], zoom);
  // ["interpolate", how, ["zoom"], z, v, …] and ["step", ["zoom"], v0, z, v, …]
  if (op !== "interpolate" && op !== "step") return null;
  let picked: unknown = op === "step" ? value[2] : value[4];
  for (let i = 3; i + 1 < value.length; i += 2) if (typeof value[i] === "number" && value[i] <= zoom) picked = value[i + 1];
  return valueAt(picked, zoom);
}

/** `top` at `opacity` over `under`, both #RRGGBB. */
export function blend(under: string, top: string, opacity: number): string {
  const ch = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [u, t] = [ch(under), ch(top)];
  return `#${u.map((v, i) => Math.round(v + (t[i] - v) * opacity).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/** A CSS colour (#rgb, #rrggbb, #rrggbbaa, rgb(a), hsl(a)) as #RRGGBB, alpha dropped; null if not one. */
export function cssToHex(css: string): string | null {
  const s = css.trim().toLowerCase();
  let rgb: number[];
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  const fn = /^(rgb|hsl)a?\(([^)]+)\)$/.exec(s);
  if (hex) {
    const h = hex[1].length <= 4 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  } else if (fn?.[1] === "rgb") {
    rgb = fn[2].split(",").slice(0, 3).map((v) => parseFloat(v));
  } else if (fn?.[1] === "hsl") {
    const [h, sat, l] = fn[2].split(",").map((v) => parseFloat(v));
    const c = (1 - Math.abs((2 * l) / 100 - 1)) * (sat / 100);
    const x = c * (1 - Math.abs((((h / 60) % 2) + 2) % 2 - 1));
    const m = l / 100 - c / 2;
    const sector = Math.floor((((h % 360) + 360) % 360) / 60);
    const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][sector];
    rgb = [r, g, b].map((v) => (v + m) * 255);
  } else return null;
  if (rgb.some((v) => !Number.isFinite(v))) return null;
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}
