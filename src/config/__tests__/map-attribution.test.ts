import { MAP_ATTRIBUTION, withAttribution } from "@/config/map";

describe("map attribution", () => {
  test("a vector source without a credit gets the OSM / OpenMapTiles one; others are left as they are", () => {
    const style = withAttribution({
      layers: [],
      sources: {
        openmaptiles: { type: "vector", url: "pmtiles://x" },
        credited: { type: "vector", url: "pmtiles://y", attribution: "own" },
        shade: { type: "raster", url: "z" },
      },
    });
    const sources = style.sources as Record<string, { attribution?: string }>;
    expect(sources.openmaptiles.attribution).toBe(MAP_ATTRIBUTION);
    expect(MAP_ATTRIBUTION).toContain("openstreetmap.org/copyright");
    expect(sources.credited.attribution).toBe("own");
    expect(sources.shade.attribution).toBeUndefined();
  });
});
