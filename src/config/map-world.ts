import type { MapStyleJson, MapStyleLayer } from "@/config/map-dark";

/**
 * The world around the active region (SPEC §3.8). A pack's tiles cover its region only, and at low zoom they carry
 * whatever slice of the world their few tiles hold, so the map changed at every zoom. `world.geojson` (built by
 * `tools/tiles`, shipped with the shared files) is drawn over the tiles instead: water, land, country borders and
 * names, and Ukraine's oblasts with their borders. The oblasts the active region's own tiles show are left out, so
 * its real map shows through the hole. Russia is sea.
 *
 * Its look is taken from the pack's own layers (water, background, boundaries, country labels), so dark mode re-tints
 * it like the rest of the map.
 */
export interface ActiveWorld {
  url: string;
  region: string;
}

const SOURCE = "world";
/** NE label ranks per Liberty country-label layer (`label_country_1` best). */
const LABEL_RANKS: Record<string, [number, number]> = {
  label_country_1: [0, 2],
  label_country_2: [3, 4],
  label_country_3: [5, 99],
};

function find(style: MapStyleJson, id: string): MapStyleLayer | undefined {
  return style.layers.find((l) => l.id === id);
}

/** A tile layer's look on the world source. */
function restyle(template: MapStyleLayer, id: string, filter: unknown[]): MapStyleLayer {
  const { "source-layer": _, ...rest } = template;
  return { ...rest, id, source: SOURCE, filter };
}

export function withWorld(style: MapStyleJson, world: ActiveWorld | null): MapStyleJson {
  if (!world) return style;
  const background = find(style, "background")?.paint?.["background-color"] ?? "#f8f4f0";
  const water = find(style, "water")?.paint?.["fill-color"] ?? "rgb(158,189,255)";
  const country = find(style, "boundary_2");
  const region = find(style, "boundary_3");

  const kind = (k: string) => ["==", ["get", "kind"], k];
  // Not shown by the active region's tiles.
  const outside = ["!", ["has", `covered:${world.region}`]];

  const layers: MapStyleLayer[] = [
    {
      id: "world_water",
      type: "fill",
      source: SOURCE,
      filter: ["all", kind("water"), outside],
      // Its edges meet the same water in the tiles: no antialiasing seam.
      paint: { "fill-color": water, "fill-antialias": false },
    },
    {
      id: "world_land",
      type: "fill",
      source: SOURCE,
      filter: ["all", kind("land"), outside],
      // An outline in the fill colour hides the seams between neighbouring countries and oblasts.
      paint: { "fill-color": background, "fill-outline-color": background },
    },
  ];
  if (region) layers.push(restyle(region, "world_region_boundary", ["all", kind("region-border"), outside]));
  if (country) layers.push(restyle(country, "world_boundary", kind("border")));
  for (const [id, [lo, hi]] of Object.entries(LABEL_RANKS)) {
    const template = find(style, id);
    if (!template) continue;
    const label = restyle(template, `world_${id}`, ["all", kind("label"), [">=", ["get", "rank"], lo], ["<=", ["get", "rank"], hi]]);
    layers.push({ ...label, layout: { ...template.layout, "text-field": ["get", "name"], "symbol-sort-key": ["get", "rank"] } });
  }
  // The Ukrainian Sea, named like the tiles' seas: once in its middle, and off Ukraine's border closer in.
  const seaName = find(style, "water_name_point_label");
  if (seaName) {
    const layout = { ...seaName.layout, "text-field": ["concat", ["get", "name"], "\n", ["get", "name_uk"]] };
    const sea = (near: number) => ["all", kind("sea-label"), ["==", ["get", "near"], near]];
    layers.push({ ...restyle(seaName, "world_water_name", sea(0)), layout: { ...layout, "text-size": ["interpolate", ["linear"], ["zoom"], 1, 12, 5, 20] } });
    layers.push({ ...restyle(seaName, "world_water_name_near", sea(1)), layout, minzoom: 5 });
  }

  return {
    ...style,
    sources: { ...(style.sources as object), [SOURCE]: { type: "geojson", data: world.url, maxzoom: 14 } },
    // The tiles' country names stop at their tiles' edges: the world's own replace them.
    layers: [...style.layers.filter((l) => !(l.id in LABEL_RANKS)), ...layers],
  };
}
