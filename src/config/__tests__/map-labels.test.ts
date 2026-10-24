import { DARK_PALETTE, tintDarkStyle, type MapStyleJson } from "@/config/map-dark";
import { HOUSE_NUMBER_LAYER, POI_MINZOOM, withHouseNumbers, withStreetLabels } from "@/config/map-labels";

/** Evaluates the few expressions the POI filter uses (all, !, in, get, literal) against a feature's properties. */
function evaluate(e: unknown, props: Record<string, string>): unknown {
  if (!Array.isArray(e)) return e;
  const [op, ...args] = e as [string, ...unknown[]];
  if (op === "all") return args.every((a) => evaluate(a, props) === true);
  if (op === "!") return !evaluate(args[0], props);
  if (op === "get") return props[args[0] as string];
  if (op === "literal") return args[0];
  if (op === "in") return (evaluate(args[1], props) as unknown[]).includes(evaluate(args[0], props));
  throw new Error(`unexpected ${op}`);
}

const style = (): MapStyleJson => ({
  version: 8,
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#f8f4f0" } },
    { id: "building", type: "fill", source: "openmaptiles", "source-layer": "building", paint: { "fill-color": "hsl(35,8%,85%)" } },
    { id: "building-3d", type: "fill-extrusion", source: "openmaptiles", "source-layer": "building", paint: {} },
    { id: "highway-name-minor", type: "symbol", source: "openmaptiles", "source-layer": "transportation_name", layout: { "symbol-placement": "line" } },
    { id: "poi_r1", type: "symbol", source: "openmaptiles", "source-layer": "poi", minzoom: 15 },
    { id: "poi_r20", type: "symbol", source: "openmaptiles", "source-layer": "poi", minzoom: 17 },
    { id: "poi_transit", type: "symbol", source: "openmaptiles", "source-layer": "poi" },
  ],
});

describe("house numbers", () => {
  test("go right above the last building layer, below every other label, from the tiles' housenumber layer", () => {
    const out = withHouseNumbers(style());
    expect(out.layers.map((l) => l.id)).toEqual(["background", "building", "building-3d", HOUSE_NUMBER_LAYER, "highway-name-minor", "poi_r1", "poi_r20", "poi_transit"]);
    const layer = out.layers[3];
    expect(layer).toMatchObject({ type: "symbol", source: "openmaptiles", "source-layer": "housenumber" });
    expect(layer.layout?.["text-field"]).toEqual(["get", "housenumber"]);
  });

  test("are added once, and not to a style without buildings", () => {
    const once = withHouseNumbers(style());
    expect(withHouseNumbers(once)).toBe(once);
    const bare: MapStyleJson = { version: 8, layers: [{ id: "background", type: "background" }] };
    expect(withHouseNumbers(bare)).toBe(bare);
  });

  test("dark mode draws them in their own quiet colour on a building-coloured halo", () => {
    const layer = tintDarkStyle(withHouseNumbers(style())).layers.find((l) => l.id === HOUSE_NUMBER_LAYER)!;
    expect(layer.paint?.["text-color"]).toBe("hsla(219, 15%, 65%, 1)"); // DARK_PALETTE.houseNumber
    expect(layer.paint?.["text-halo-color"]).toBe("hsla(222, 21%, 12%, 0.9)"); // the buildings' fill, as drawn
    expect(DARK_PALETTE.houseNumber).toBe("#9aa3b4");
  });

  test("shop and POI names start at street level; later ones and transit stops keep theirs", () => {
    const zooms = Object.fromEntries(withStreetLabels(style()).layers.map((l) => [l.id, l.minzoom]));
    expect(zooms).toMatchObject({ poi_r1: POI_MINZOOM, poi_r20: 17, poi_transit: undefined, [HOUSE_NUMBER_LAYER]: 15 });
    expect(POI_MINZOOM).toBe(16);
  });

  test("bins, playgrounds and artworks aren't drawn; gates and galleries are; the layers' own filters still apply", () => {
    const poi = withStreetLabels(style()).layers.find((l) => l.id === "poi_r1")!;
    const shown = (props: Record<string, string>) => evaluate(poi.filter, props);
    expect(shown({ class: "waste_basket", subclass: "waste_basket" })).toBe(false);
    expect(shown({ class: "playground", subclass: "playground" })).toBe(false);
    expect(shown({ class: "art_gallery", subclass: "artwork" })).toBe(false);
    expect(shown({ class: "art_gallery", subclass: "gallery" })).toBe(true);
    expect(shown({ class: "gate", subclass: "gate" })).toBe(true);
    expect(shown({ class: "fuel", subclass: "fuel" })).toBe(true);
    const filtered = withStreetLabels({ version: 8, layers: [{ id: "poi_r7", type: "symbol", "source-layer": "poi", filter: ["==", 1, 1] }] });
    expect(filtered.layers[0].filter).toEqual(["all", ["==", 1, 1], poi.filter]);
  });
});
