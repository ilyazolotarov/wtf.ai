import { readFileSync } from "node:fs";
import path from "node:path";

import { CONE_OUTLINE } from "@/components/map/puck-style";
import { DARK_PALETTE, tintDarkStyle, type MapStyleJson } from "@/config/map-dark";
import { cssToHex, stylePalette } from "@/config/map-palette";
import { Colors } from "@/constants/theme";

jest.mock("@/global.css", () => ({}));

/**
 * What the app draws over the map stands out on everything under it, in both themes (UI-SPEC §6.1): the car's dot, its
 * heading cone, the placing pin, the routes and their markers, the pins and marks, the GPS ghost. Every surface meets
 * a band of theirs at WCAG's 3:1 for graphics (SC 1.4.11); labels read at 4.5:1 on their halo. The surfaces come from
 * the map's own styles (Liberty, and the same re-tinted for Night Drive) and the route colours.
 */

const MIN = 3;
const liberty = JSON.parse(readFileSync(path.join(__dirname, "../../../../tools/tiles/style/liberty.json"), "utf8")) as MapStyleJson;

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];

function rgba(css: string): Rgba {
  const a = /^rgba\(([^)]+)\)$/i.exec(css.trim());
  if (a) {
    const [r, g, b, alpha] = a[1].split(",").map((v) => parseFloat(v));
    return [r, g, b, alpha];
  }
  const hex = cssToHex(css);
  if (!hex) throw new Error(`not a colour: ${css}`);
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 1];
}

/** `top` over `under`, as the map composites a translucent band. */
const over = ([r, g, b, a]: Rgba, under: Rgb): Rgb => [r * a + under[0] * (1 - a), g * a + under[1] * (1 - a), b * a + under[2] * (1 - a)];
const solid = (css: string, under: Rgb): Rgb => over(rgba(css), under);

function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** CIE76 colour difference: two colours of one lightness still differ by hue. */
function deltaE(a: Rgb, b: Rgb): number {
  const lab = ([r, g, b]: Rgb) => {
    const lin = (v: number) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const [R, G, B] = [lin(r), lin(g), lin(b)];
    const xyz = [
      (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047,
      0.2126 * R + 0.7152 * G + 0.0722 * B,
      (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883,
    ].map((t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116));
    return [116 * xyz[1] - 16, 500 * (xyz[0] - xyz[1]), 200 * (xyz[1] - xyz[2])];
  };
  const [x, y] = [lab(a), lab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

const motorway = {
  // Liberty's motorways at street zoom (the last stop of its zoom interpolation); trunk roads in Night Drive.
  light: (() => {
    const c = liberty.layers.find((l) => l.id === "road_motorway")?.paint?.["line-color"] as unknown[];
    return c[c.length - 1] as string;
  })(),
  dark: DARK_PALETTE.motorway,
};

const SCHEMES = ["light", "dark"] as const;

/** Everything the dot, the cone and the pin can sit on: land, buildings, parks, water, roads, the routes. */
function surfaces(scheme: (typeof SCHEMES)[number]): Record<string, Rgb> {
  const map = stylePalette(scheme === "light" ? liberty : tintDarkStyle(liberty));
  if (!map) throw new Error("palette unreadable");
  const p = Colors[scheme];
  const ground = solid(map.land, [0, 0, 0]);
  return {
    land: ground,
    building: solid(map.building, ground),
    park: solid(map.park, ground),
    water: solid(map.water, ground),
    "minor road": solid(map.minor, ground),
    "main road": solid(map.major, ground),
    "main road casing": solid(map.majorCasing, ground),
    "motorway / trunk": solid(motorway[scheme], ground),
    route: solid(p.route, ground),
    "route casing": solid(p.routeCasing, ground),
    "alternative route": solid(p.routeAlt, ground),
    "alternative route casing": solid(p.routeAltCasing, ground),
  };
}

/** The best contrast any of `bands` (outermost first, each over the surface) makes with `surface`. */
const standsOut = (surface: Rgb, bands: string[]) => Math.max(...bands.map((b) => contrast(solid(b, surface), surface)));

describe.each(SCHEMES)("%s theme", (scheme) => {
  const p = Colors[scheme];
  const under = surfaces(scheme);
  const cases = Object.entries(under);

  test.each(cases)("the dot with GPS trusted stands out on %s", (_, surface) => {
    expect(standsOut(surface, [p.puckEdge, p.puckRing])).toBeGreaterThanOrEqual(MIN);
  });

  test.each(cases)("the dot in doubt stands out on %s", (_, surface) => {
    expect(standsOut(surface, [p.puckEdge, p.puckDoubt])).toBeGreaterThanOrEqual(MIN);
  });

  test("the dot's bands stand out from each other: edge and ring, and in doubt the ring and its centre", () => {
    for (const surface of Object.values(under)) {
      const edge = solid(p.puckEdge, surface);
      expect(contrast(edge, solid(p.puckRing, edge))).toBeGreaterThanOrEqual(MIN);
    }
    expect(contrast(solid(p.puckDoubt, [0, 0, 0]), solid(p.bg, [0, 0, 0]))).toBeGreaterThanOrEqual(MIN);
    // The trusted fill reads inside its white ring.
    expect(contrast(solid(p.puck, [0, 0, 0]), solid(p.puckRing, [0, 0, 0]))).toBeGreaterThanOrEqual(MIN);
  });

  test("the trusted dot's blue is not the route's: the line doesn't run into it", () => {
    expect(deltaE(solid(p.puck, [0, 0, 0]), solid(p.route, [0, 0, 0]))).toBeGreaterThanOrEqual(20);
  });

  test.each(cases)("the heading cone's outline stands out on %s, trusted and in doubt", (_, surface) => {
    const outline = CONE_OUTLINE[scheme];
    for (const ring of [p.puckRing, p.puckDoubt]) {
      const bands = outline.ring > 0 ? [p.puckEdge, ring] : [p.puckEdge];
      expect(standsOut(surface, bands)).toBeGreaterThanOrEqual(MIN);
    }
  });

  test.each(cases)("the placing pin stands out on %s", (_, surface) => {
    expect(standsOut(surface, [p.puckEdge, p.puckRing])).toBeGreaterThanOrEqual(MIN);
  });
});

/** `css` at `alpha` (a translucent fill), as an rgba() string. */
function withAlpha(css: string, alpha: number): string {
  const [r, g, b] = rgba(css);
  return `rgba(${r},${g},${b},${alpha})`;
}

describe.each(SCHEMES)("%s theme: the rest of what the app draws on the map", (scheme) => {
  const p = Colors[scheme];
  const under = surfaces(scheme);
  // The routes run over the map, not over each other.
  const mapOnly = Object.entries(under).filter(([name]) => !/route/.test(name));
  const all = Object.entries(under);

  /** Bands outermost first, as map-layers.tsx draws them: a casing or stroke round a line or fill. */
  const arrow = CONE_OUTLINE[scheme].ring > 0 ? [p.puckEdge, p.puckRing] : [p.puckEdge];
  const marks: [string, string[], [string, Rgb][]][] = [
    ["the route", [withAlpha(p.routeCasing, 0.9), p.route], mapOnly],
    ["an alternative route", [p.routeAltCasing, p.routeAlt], mapOnly],
    ["the next maneuver's dot", [p.maneuverEdge, p.maneuver], all],
    ["the destination", [p.routeCasing, p.route], all],
    ["a dropped pin", [p.puckEdge, p.puckRing, p.accent], all],
    ["the placed position", [p.puckEdge, p.puckRing, p.accent], all],
    ["the placed car's arrow", arrow, all],
    ["the GPS ghost", [p.puckEdge, p.puckRing, p.bad.c], all],
    ["another road the car may be on", [p.puckEdge, p.puckDoubt, p.bg], all],
  ];

  describe.each(marks)("%s", (_, bands, on) => {
    test.each(on)("stands out on %s", (__, surface) => {
      expect(standsOut(surface, bands)).toBeGreaterThanOrEqual(MIN);
    });
  });

  test.each([
    ["an alternative route's time", p.route],
    ["the ghost's “GPS?”", p.bad.c],
  ])("%s reads on its halo", (_, text) => {
    const halo = solid(p.bg, [0, 0, 0]);
    expect(contrast(solid(text, halo), halo)).toBeGreaterThanOrEqual(4.5);
  });
});
