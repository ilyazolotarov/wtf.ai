/**
 * Dark mode re-tints OpenFreeMap Liberty in place instead of switching styles.
 *
 * One palette of fixed role colors (`DARK_PALETTE`). Liberty's layers are sorted
 * into roles (ground, landuse, parks, water, buildings, a road ladder, labels)
 * and every color literal in the layer's paint, expressions included, is
 * replaced with that role's color. That gives deliberate contrast steps:
 *
 *   ground < minor < secondary < primary < motorway
 *
 * with water and parks set apart from the ground by lightness as well as hue,
 * so the map no longer reads flat.
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

export interface DarkPalette {
  /** Background / bare land. */
  ground: string;
  /** Residential, industrial and other landuse (a small lift over ground). */
  landuse: string;
  park: string;
  /** Forest; darker than park. */
  wood: string;
  water: string;
  building: string;
  buildingEdge: string;
  casing: string;
  /** Footways, service roads, tracks. */
  path: string;
  minor: string;
  secondary: string;
  primary: string;
  /**
   * Motorways AND trunk roads. In Ukraine (and much of Eastern Europe) the
   * national M-/H- roads are tagged trunk, not motorway, so they need this
   * color to stand out from ordinary primary streets.
   */
  motorway: string;
  rail: string;
  boundary: string;
  /** Place names (cities, districts). */
  label: string;
  labelHalo: string;
  poiLabel: string;
  waterLabel: string;
  roadLabel: { color: string; halo: string; haloWidth: number };
}

/** Night Drive: maximum contrast for driving and OLED; amber main roads, orange highways, dark-on-white road names. */
export const DARK_PALETTE: DarkPalette = {
  ground: "#0b0d11",
  landuse: "#10131a",
  park: "#0c1c13",
  wood: "#0a1710",
  water: "#05264a",
  building: "#191d26",
  buildingEdge: "#242a37",
  casing: "#000000",
  path: "#2f3542",
  minor: "#4c5566",
  secondary: "#8e98aa",
  primary: "#f2b43c",
  motorway: "#ff8a1f",
  rail: "#5d6677",
  boundary: "#7a6ea3",
  label: "#ffffff",
  labelHalo: "#000000",
  poiLabel: "#e8ecf2",
  waterLabel: "#5aaeff",
  roadLabel: { color: "#111111", halo: "rgba(255,255,255,0.95)", haloWidth: 2 },
};

// ---------------------------------------------------------------- color utils

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
    if (h.length <= 4)
      h = h
        .split("")
        .map((c) => c + c)
        .join("");
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
    h =
      mx === r
        ? (g - b) / d + (g < b ? 6 : 0)
        : mx === g
          ? (b - r) / d + 2
          : (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: sat, l, a };
}

function formatColor(c: Hsla): string {
  const l = Math.max(0, Math.min(1, c.l));
  return `hsla(${Math.round(c.h)}, ${Math.round(c.s * 100)}%, ${Math.round(l * 100)}%, ${c.a})`;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function hexRgb(hex: string): [number, number, number] {
  const c = parseColor(hex);
  if (!c) throw new Error(`Bad palette color: ${hex}`);
  // Back to RGB via a canvas-free HSL→RGB conversion.
  const k = (n: number) => (n + c.h / 30) % 12;
  const a = c.s * Math.min(c.l, 1 - c.l);
  const f = (n: number) =>
    c.l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** Linear RGB-space mix of two palette colors, returned as HSLA. */
function mix(a: string, b: string, t: number): Hsla {
  const ca = hexRgb(a);
  const cb = hexRgb(b);
  const m = ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
  return parseColor(`rgb(${m[0]}, ${m[1]}, ${m[2]})`)!;
}

/** A tint that ignores the source color and paints a fixed one, keeping alpha. */
function solid(color: string): Tint {
  const c = parseColor(color);
  if (!c) throw new Error(`Bad palette color: ${color}`);
  return (src) => ({ ...c, a: src.a * c.a });
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

// ------------------------------------------------------------------- roles

interface Tints {
  land: Tint;
  water: Tint;
  building: Tint;
  buildingEdge: Tint;
  label: Tint;
  labelHalo: Tint;
  poiLabel: Tint;
  waterLabel: Tint;
  roadLabel: Tint;
  roadLabelHalo: Tint;
  line: (id: string) => Tint;
}

function makeTints(p: DarkPalette): Tints {
  const lines = {
    casing: solid(p.casing),
    motorway: solid(p.motorway),
    primary: solid(p.primary),
    secondary: solid(p.secondary),
    minor: solid(p.minor),
    path: solid(p.path),
    rail: solid(p.rail),
    boundary: solid(p.boundary),
  };
  return {
    // Greens (parks, grass, wood) keep a green role; everything else becomes
    // ground, lifted slightly toward `landuse` the darker Liberty drew it.
    land: (c) => {
      const green = c.s > 0.12 && c.h >= 65 && c.h <= 170;
      const out = green
        ? mix(p.park, p.wood, clamp01((0.86 - c.l) * 4))
        : mix(p.ground, p.landuse, clamp01((0.97 - c.l) * 5));
      return { ...out, a: c.a };
    },
    water: solid(p.water),
    building: solid(p.building),
    buildingEdge: solid(p.buildingEdge),
    label: solid(p.label),
    labelHalo: solid(p.labelHalo),
    poiLabel: solid(p.poiLabel),
    waterLabel: solid(p.waterLabel),
    roadLabel: solid(p.roadLabel.color),
    roadLabelHalo: solid(p.roadLabel.halo),
    line: (id) => {
      if (/boundary|admin/i.test(id)) return lines.boundary;
      if (/rail|transit/i.test(id)) return lines.rail;
      if (/casing/i.test(id)) return lines.casing;
      if (/motorway/i.test(id)) return lines.motorway;
      if (/trunk|primary/i.test(id)) return lines.primary;
      if (/secondary|tertiary/i.test(id)) return lines.secondary;
      if (/path|pedestrian|footway|cycleway|steps|track|service/i.test(id))
        return lines.path;
      return lines.minor;
    },
  };
}

/** Gives a label a dark halo even when Liberty didn't define one. */
function ensureHalo(paint: Paint, min: number, halo: Tint) {
  paint["text-halo-color"] =
    paint["text-halo-color"] != null
      ? walk(paint["text-halo-color"], halo)
      : formatColor(halo({ h: 0, s: 0, l: 0, a: 1 }));
  const w = paint["text-halo-width"];
  if (w == null) paint["text-halo-width"] = min;
  else if (typeof w === "number") paint["text-halo-width"] = Math.max(w, min);
}

function tintLayer(
  layer: MapStyleLayer,
  t: Tints,
  p: DarkPalette,
): MapStyleLayer {
  const paint: Paint = { ...layer.paint };
  const set = (prop: string, tint: Tint) => {
    if (paint[prop] != null) paint[prop] = walk(paint[prop], tint);
  };
  const id = layer.id;
  const isWater = /water|ocean|river|lake/i.test(id);
  const isBuilding = /building/i.test(id);
  const isShield = /shield/i.test(id);
  const isRoadLabel =
    layer.layout?.["symbol-placement"] === "line" ||
    /road|highway|transportation|street/i.test(id);

  switch (layer.type) {
    case "background":
      set("background-color", t.land);
      break;
    case "fill":
      if (isWater) {
        set("fill-color", t.water);
        set("fill-outline-color", t.water);
      } else if (isBuilding) {
        set("fill-color", t.building);
        set("fill-outline-color", t.buildingEdge);
      } else {
        set("fill-color", t.land);
        set("fill-outline-color", t.land);
      }
      break;
    case "fill-extrusion":
      set("fill-extrusion-color", t.building);
      break;
    case "line":
      if (/trunk/i.test(id) && !/casing/i.test(id)) {
        // Liberty draws trunk + primary in one layer; split them by class so
        // trunk roads (most national highways in Ukraine) get the highway color.
        paint["line-color"] = [
          "match",
          ["get", "class"],
          "trunk",
          p.motorway,
          p.primary,
        ];
      } else {
        set("line-color", isWater ? t.water : t.line(id));
      }
      break;
    case "symbol":
      if (isShield) break;
      if (isWater) {
        set("text-color", t.waterLabel);
        ensureHalo(paint, 1.2, t.labelHalo);
      } else if (isRoadLabel) {
        paint["text-color"] = formatColor(
          t.roadLabel({ h: 0, s: 0, l: 0, a: 1 }),
        );
        paint["text-halo-color"] = formatColor(
          t.roadLabelHalo({ h: 0, s: 0, l: 0, a: 1 }),
        );
        paint["text-halo-width"] = p.roadLabel.haloWidth;
        paint["text-halo-blur"] = 0;
      } else if (/poi|airport|aerodrome/i.test(id)) {
        set("text-color", t.poiLabel);
        ensureHalo(paint, 1.2, t.labelHalo);
      } else {
        set("text-color", t.label);
        ensureHalo(paint, 1.2, t.labelHalo);
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

const TINTS = makeTints(DARK_PALETTE);

/** Re-tints a Liberty style for dark mode. */
export function tintDarkStyle<T extends MapStyleJson>(style: T): T {
  return { ...style, layers: style.layers.map((l) => tintLayer(l, TINTS, DARK_PALETTE)) };
}
