/**
 * Dark mode re-tints OpenFreeMap Liberty in place instead of switching styles
 * (Calm redesign): dark ground, muted roads, light labels. Road names keep dark
 * text on a white halo so they stay readable at a glance while driving.
 */

type Paint = Record<string, unknown>;

export interface MapStyleLayer {
  id: string;
  type: string;
  layout?: Record<string, unknown>;
  paint?: Paint;
  [key: string]: unknown;
}

export interface MapStyleJson {
  layers: MapStyleLayer[];
  [key: string]: unknown;
}

interface Hsla {
  h: number;
  s: number;
  l: number;
  a: number;
}

type Tint = (c: Hsla) => Hsla;

function parseColor(input: string): Hsla | null {
  const s = input.trim();
  let r: number, g: number, b: number;
  let a = 1;
  let x: RegExpMatchArray | null;
  if ((x = s.match(/^#([0-9a-f]{3,8})$/i))) {
    let h = x[1];
    if (h.length <= 4) h = h.split("").map((c) => c + c).join("");
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
    if (h.length === 8) a = parseInt(h.slice(6, 8), 16) / 255;
  } else if ((x = s.match(/^rgba?\(([^)]+)\)$/i))) {
    const p = x[1].split(",").map((v) => parseFloat(v));
    [r, g, b] = p;
    if (p[3] != null) a = p[3];
  } else if ((x = s.match(/^hsla?\(([^)]+)\)$/i))) {
    const p = x[1].split(",").map((v) => parseFloat(v));
    return { h: p[0], s: p[1] / 100, l: p[2] / 100, a: p[3] ?? 1 };
  } else {
    return null;
  }
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  let h = 0;
  let sat = 0;
  if (mx !== mn) {
    const d = mx - mn;
    sat = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: sat, l, a };
}

function formatColor(c: Hsla): string {
  const l = Math.max(0, Math.min(1, c.l));
  return `hsla(${Math.round(c.h)}, ${Math.round(c.s * 100)}%, ${Math.round(l * 100)}%, ${c.a})`;
}

/** Recolors every color literal in a paint value, expressions included. */
function walk(value: unknown, tint: Tint): unknown {
  if (Array.isArray(value)) return value.map((v) => walk(v, tint));
  if (typeof value === "string") {
    const c = parseColor(value);
    return c ? formatColor(tint(c)) : value;
  }
  return value;
}

const ground: Tint = (c) => ({ h: c.h, s: c.s * 0.35, l: 0.105 + c.l * 0.07, a: c.a });
const water: Tint = (c) => ({ h: 212, s: 0.28, l: 0.17, a: c.a });
const road: Tint = (c) =>
  c.s > 0.15
    ? { h: c.h, s: Math.min(1, c.s * 1.15), l: c.l * 0.88, a: c.a }
    : { h: 215, s: 0.08, l: 0.3 + c.l * 0.1, a: c.a };
const casing: Tint = (c) => ({ h: c.h, s: c.s * 0.3, l: 0.13, a: c.a });
const building: Tint = (c) => ({ h: c.h, s: c.s * 0.3, l: 0.16 + c.l * 0.06, a: c.a });
const label: Tint = (c) => ({ h: c.h, s: c.s * 0.4, l: 0.92 - c.l * 0.3, a: c.a });
const halo: Tint = (c) => ({ h: 0, s: 0, l: 0.08, a: c.a });

function tintLayer(layer: MapStyleLayer): MapStyleLayer {
  const paint: Paint = { ...layer.paint };
  const set = (prop: string, tint: Tint) => {
    if (paint[prop] != null) paint[prop] = walk(paint[prop], tint);
  };
  const id = layer.id;
  const isWater = /water|ocean|river|lake/i.test(id);
  const isShield = /shield/i.test(id);
  const isRoadLabel =
    layer.layout?.["symbol-placement"] === "line" ||
    /road|highway|transportation|street/i.test(id);

  switch (layer.type) {
    case "background":
      set("background-color", ground);
      break;
    case "fill":
      set("fill-color", isWater ? water : ground);
      set("fill-outline-color", ground);
      break;
    case "fill-extrusion":
      set("fill-extrusion-color", building);
      break;
    case "line":
      set("line-color", isWater ? water : /casing/i.test(id) ? casing : road);
      break;
    case "symbol":
      if (isShield) break;
      if (isRoadLabel && !isWater) {
        paint["text-color"] = "#161616";
        paint["text-halo-color"] = "rgba(255,255,255,0.92)";
        paint["text-halo-width"] = 2;
        paint["text-halo-blur"] = 0;
      } else {
        set("text-color", label);
        set("text-halo-color", halo);
      }
      break;
    case "raster":
      paint["raster-brightness-max"] = 0.25;
      paint["raster-opacity"] = 0.4;
      break;
    default:
      return layer;
  }
  return { ...layer, paint };
}

export function tintDarkStyle<T extends MapStyleJson>(style: T): T {
  return { ...style, layers: style.layers.map(tintLayer) };
}
