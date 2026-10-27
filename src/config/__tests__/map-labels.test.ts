import { DARK_PALETTE, tintDarkStyle, type MapStyleJson } from "@/config/map-dark";
import {
  HOUSE_NUMBER_LAYER,
  LIGHT_LABEL_COLOR,
  POI_MINZOOM,
  STREET_PICK_LAYER,
  withBlackLabels,
  withHouseNumbers,
  withLabelLanguage,
  withStreetLabels,
  withUprightLineNames,
} from "@/config/map-labels";

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
    { id: "highway-name-path", type: "symbol", source: "openmaptiles", "source-layer": "transportation_name" },
  ],
});

describe("house numbers", () => {
  test("go right above the last building layer, below every other label, from the tiles' housenumber layer", () => {
    const out = withHouseNumbers(style());
    expect(out.layers.map((l) => l.id)).toEqual(["background", "building", "building-3d", HOUSE_NUMBER_LAYER, "highway-name-minor", "poi_r1", "poi_r20", "poi_transit", "highway-name-path"]);
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

  test("an invisible layer of the named street lines, on top, for a long press to ask which street is under it", () => {
    const layers = withStreetLabels(style()).layers;
    expect(layers.at(-1)).toMatchObject({ id: STREET_PICK_LAYER, type: "line", "source-layer": "transportation_name", paint: { "line-opacity": 0.01 } });
    expect(withStreetLabels(withStreetLabels(style())).layers.filter((l) => l.id === STREET_PICK_LAYER)).toHaveLength(1);
  });
});

describe("names along lines", () => {
  test("stand up facing the driver when the map is tilted; point labels and unnamed lines are left alone", () => {
    const out = withUprightLineNames({
      version: 8,
      layers: [
        { id: "highway-name-minor", type: "symbol", "source-layer": "transportation_name", layout: { "symbol-placement": "line", "text-field": ["get", "name"] } },
        { id: "road_one_way_arrow", type: "symbol", "source-layer": "transportation", layout: { "symbol-placement": "line", "icon-image": "arrow" } },
        { id: "poi_r1", type: "symbol", "source-layer": "poi", layout: { "text-field": ["get", "name"] } },
      ],
    });
    expect(out.layers.map((l) => l.layout?.["text-pitch-alignment"])).toEqual(["viewport", undefined, undefined]);
  });
});

describe("the light map's names", () => {
  test("streets, places and POIs black on a light halo; water, transit, house numbers and shields keep theirs", () => {
    const named = (id: string, sourceLayer: string, paint: Record<string, unknown>) => ({
      id,
      type: "symbol",
      "source-layer": sourceLayer,
      layout: { "text-field": ["get", "name"] },
      paint,
    });
    const out = withBlackLabels({
      version: 8,
      layers: [
        named("highway-name-major", "transportation_name", { "text-color": "#666", "text-halo-width": 1 }),
        named("highway-name-path", "transportation_name", { "text-color": "hsl(30,23%,62%)", "text-halo-color": "#f8f4f0", "text-halo-width": 0.5 }),
        named("poi_r1", "poi", { "text-color": "#666", "text-halo-color": "#ffffff", "text-halo-width": 1 }),
        named("label_other", "place", { "text-color": "#333" }),
        named("poi_transit", "poi", { "text-color": "#2e5a80" }),
        named("water_name_line_label", "water_name", { "text-color": "#495e91" }),
        named("housenumber", "housenumber", { "text-color": "hsl(30,8%,27%)" }),
        named("highway-shield-non-us", "transportation_name", { "text-color": "#000" }),
      ],
    });
    expect(out.layers.map((l) => l.paint?.["text-color"])).toEqual([
      LIGHT_LABEL_COLOR,
      LIGHT_LABEL_COLOR,
      LIGHT_LABEL_COLOR,
      LIGHT_LABEL_COLOR,
      "#2e5a80",
      "#495e91",
      "hsl(30,8%,27%)",
      "#000",
    ]);
    // A halo where the style had none; the path's own, a little wider.
    expect(out.layers[0].paint).toMatchObject({ "text-halo-color": "rgba(255,255,255,0.9)", "text-halo-width": 1 });
    expect(out.layers[1].paint).toMatchObject({ "text-halo-color": "#f8f4f0", "text-halo-width": 1 });
  });
});

describe("labels in the app's language", () => {
  const liberty = ["case", ["has", "name:nonlatin"], ["concat", ["get", "name:latin"], "\n", ["get", "name:nonlatin"]], ["coalesce", ["get", "name_en"], ["get", "name"]]];
  const named = (): MapStyleJson => ({
    version: 8,
    layers: [
      { id: "label_city", type: "symbol", layout: { "text-field": liberty } },
      { id: "housenumber", type: "symbol", layout: { "text-field": ["get", "housenumber"] } },
      { id: "road_shield", type: "symbol", layout: { "text-field": ["to-string", ["get", "ref"]] } },
      { id: "world_label_country_1", type: "symbol", layout: { "text-field": ["get", "name"] } },
      { id: "world_water_name", type: "symbol", layout: { "text-field": ["concat", ["get", "name"], "\n", ["get", "name_uk"]] } },
    ],
  });
  /** coalesce and get, as MapLibre reads them. */
  const read = (e: unknown, props: Record<string, string>): unknown => {
    const [op, ...args] = e as [string, ...unknown[]];
    if (op === "get") return props[args[0] as string] ?? null;
    if (op === "coalesce") return args.map((a) => read(a, props)).find((v) => v != null) ?? null;
    throw new Error(`unexpected ${op}`);
  };
  const field = (s: MapStyleJson, id: string) => s.layers.find((l) => l.id === id)?.layout?.["text-field"];
  const street = { name: "Софіївська вулиця", "name:uk": "Софіївська вулиця", "name:en": "Sofiivska Street", "name:latin": "Sofiivska vulytsia" };

  test("one name, in Ukrainian or English, where Liberty wrote both", () => {
    expect(read(field(withLabelLanguage(named(), "uk"), "label_city"), street)).toBe("Софіївська вулиця");
    expect(read(field(withLabelLanguage(named(), "en"), "label_city"), street)).toBe("Sofiivska Street");
  });

  test("without a name in the language: the name on the ground, or its Latin form in English", () => {
    const local = { name: "Lidl" };
    expect(read(field(withLabelLanguage(named(), "uk"), "label_city"), local)).toBe("Lidl");
    const noEnglish = { name: "вулиця Лугова", "name:latin": "vulytsia Luhova" };
    expect(read(field(withLabelLanguage(named(), "en"), "label_city"), noEnglish)).toBe("vulytsia Luhova");
  });

  test("the world's names in the language where it has them; numbers and shields untouched", () => {
    const sea = { name: "Ukrainian Sea", name_uk: "Українське море" };
    expect(read(field(withLabelLanguage(named(), "uk"), "world_water_name"), sea)).toBe("Українське море");
    expect(read(field(withLabelLanguage(named(), "en"), "world_water_name"), sea)).toBe("Ukrainian Sea");
    expect(read(field(withLabelLanguage(named(), "uk"), "world_label_country_1"), { name: "Poland" })).toBe("Poland");
    for (const language of ["en", "uk"] as const) {
      expect(field(withLabelLanguage(named(), language), "housenumber")).toEqual(["get", "housenumber"]);
      expect(field(withLabelLanguage(named(), language), "road_shield")).toEqual(["to-string", ["get", "ref"]]);
    }
  });
});
