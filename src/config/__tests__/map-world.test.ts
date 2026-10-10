import { tintDarkStyle, type MapStyleJson } from "@/config/map-dark";
import { withWorld } from "@/config/map-world";

const STYLE: MapStyleJson = {
  sources: { openmaptiles: { type: "vector", url: "pmtiles://x" } },
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#f8f4f0" } },
    { id: "water", type: "fill", source: "openmaptiles", "source-layer": "water", paint: { "fill-color": "rgb(158,189,255)" } },
    { id: "boundary_2", type: "line", source: "openmaptiles", "source-layer": "boundary", paint: { "line-color": "#666" } },
    {
      id: "label_country_1",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "place",
      layout: { "text-field": ["get", "name_en"], "text-font": ["noto-sans-bold"] },
    },
    {
      id: "water_name_point_label",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "water_name",
      layout: { "text-field": ["get", "name"], "text-font": ["noto-sans-italic"] },
    },
  ],
};

describe("world around the active region", () => {
  test("without a world file the pack's style is left as it is", () => {
    expect(withWorld(STYLE, null)).toBe(STYLE);
  });

  test("drawn over the tiles, leaving out what the active region's tiles show", () => {
    const style = withWorld(STYLE, { url: "file:///common/world.geojson", region: "kyiv" });
    expect((style.sources as Record<string, unknown>).world).toEqual({ type: "geojson", data: "file:///common/world.geojson", maxzoom: 14 });
    const ids = style.layers.map((l) => l.id);
    expect(ids).toEqual([
      "background",
      "water",
      "boundary_2",
      "water_name_point_label",
      "world_water",
      "world_land",
      "world_boundary",
      "world_label_country_1",
      "world_water_name",
      "world_water_name_near",
    ]);
    const land = style.layers.find((l) => l.id === "world_land");
    expect(JSON.stringify(land?.filter)).toContain('["has","covered:kyiv"]');
    expect(land?.paint?.["fill-color"]).toBe("#f8f4f0");
    expect(style.layers.find((l) => l.id === "world_water")?.paint?.["fill-color"]).toBe("rgb(158,189,255)");
  });

  test("country names and borders keep the tiles' look on the world source", () => {
    const style = withWorld(STYLE, { url: "file:///w", region: "ukraine" });
    const label = style.layers.find((l) => l.id === "world_label_country_1");
    expect(label).toMatchObject({ source: "world", layout: { "text-field": ["get", "name"], "text-font": ["noto-sans-bold"] } });
    expect(label).not.toHaveProperty("source-layer");
    expect(style.layers.find((l) => l.id === "world_boundary")).toMatchObject({ source: "world", paint: { "line-color": "#666" } });
  });

  test("the Ukrainian Sea is named in English and Ukrainian, in the tiles' sea-name font", () => {
    const style = withWorld(STYLE, { url: "file:///w", region: "ukraine" });
    const sea = style.layers.find((l) => l.id === "world_water_name_near");
    expect(sea).toMatchObject({ source: "world", minzoom: 5, layout: { "text-font": ["noto-sans-italic"] } });
    expect(sea?.layout?.["text-field"]).toEqual(["concat", ["get", "name"], "\n", ["get", "name_uk"]]);
  });

  test("dark mode tints the world's water as water and its land as ground", () => {
    const dark = tintDarkStyle(withWorld(STYLE, { url: "file:///w", region: "ukraine" })).layers;
    const paint = (id: string) => dark.find((l) => l.id === id)?.paint ?? {};
    expect(paint("world_water")["fill-color"]).toBe(paint("water")["fill-color"]);
    expect(paint("world_land")["fill-color"]).toBe(paint("background")["background-color"]);
  });
});
