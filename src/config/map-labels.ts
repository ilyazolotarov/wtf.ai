import type { MapStyleJson, MapStyleLayer } from "@/config/map-dark";

/**
 * Street-level labels (SPEC §3.8): house numbers from z15, shop and other POI names from z16, so a street's
 * houses can be read before the shops crowd them.
 *
 * House numbers: the tiles carry them (OpenMapTiles `housenumber`: every `addr:housenumber`, a building's at its
 * centre) but Liberty draws none. The layer goes right above the buildings, below every other label: MapLibre places
 * later layers' labels first, so a number gives way to street names, places and POIs. Dark mode re-tints it like the
 * rest (`tintDarkStyle`, its own palette colour).
 */
export const HOUSE_NUMBER_LAYER = "housenumber";
/** A zoom past where the tiles start carrying them (z14), where most of a street's numbers already fit. */
export const HOUSE_NUMBER_MINZOOM = 15;
/** Liberty starts its most important POIs (`poi_r1`) at z15; the rest already start at 16 and 17. */
export const POI_MINZOOM = 16;
/**
 * POIs of no use to a driver that crowd a city's map (OpenMapTiles `poi.class`; counted on Kyiv's tiles: 5 200 bins,
 * 3 500 playgrounds, 2 200 courtyard pitches of 60 000 POIs). Gates and lift gates stay: a yard may be closed.
 */
export const HIDDEN_POI_CLASSES = [
  "waste_basket",
  "recycling",
  "playground",
  "pitch",
  "bicycle_parking",
  "shelter",
  "bollard",
  "information",
  "drinking_water",
];
/** …and subclasses of classes that stay: sculptures and murals (`art_gallery` keeps galleries and arts centres). */
export const HIDDEN_POI_SUBCLASSES = ["artwork"];

export function houseNumberLayer(source: string): MapStyleLayer {
  return {
    id: HOUSE_NUMBER_LAYER,
    type: "symbol",
    source,
    "source-layer": "housenumber",
    minzoom: HOUSE_NUMBER_MINZOOM,
    layout: {
      "text-field": ["get", "housenumber"],
      "text-font": ["noto-sans-regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 15, 9, 16, 10, 18, 12, 20, 14],
      "text-padding": 2,
    },
    // Darker than Liberty's buildings (hsl(35,8%,85%)), in their hue; the halo is the building itself.
    paint: { "text-color": "hsl(30,8%,42%)", "text-halo-color": "hsla(35,8%,85%,0.9)", "text-halo-width": 1 },
  };
}

/** The style with house numbers above its buildings; unchanged if it has them or no building layer. */
export function withHouseNumbers(style: MapStyleJson): MapStyleJson {
  if (style.layers.some((l) => l.id === HOUSE_NUMBER_LAYER)) return style;
  let last = -1;
  style.layers.forEach((l, i) => {
    if (l["source-layer"] === "building") last = i;
  });
  const source = style.layers[last]?.source;
  if (last < 0 || typeof source !== "string") return style;
  const layers = [...style.layers];
  layers.splice(last + 1, 0, houseNumberLayer(source));
  return { ...style, layers };
}

/**
 * POI labels that start below `POI_MINZOOM` start there instead, and the hidden POIs aren't drawn. Only
 * layers with a minzoom move: transit stops (`poi_transit`, none) keep showing from wherever their tiles carry them.
 */
export function withPoisFromStreetLevel(style: MapStyleJson): MapStyleJson {
  const hide = [
    "all",
    ["!", ["in", ["get", "class"], ["literal", HIDDEN_POI_CLASSES]]],
    ["!", ["in", ["get", "subclass"], ["literal", HIDDEN_POI_SUBCLASSES]]],
  ];
  return {
    ...style,
    layers: style.layers.map((l) => {
      if (l["source-layer"] !== "poi") return l;
      const minzoom = typeof l.minzoom === "number" && l.minzoom < POI_MINZOOM ? POI_MINZOOM : l.minzoom;
      const filter = l.filter ? ["all", l.filter, hide] : hide;
      return { ...l, ...(minzoom === undefined ? {} : { minzoom }), filter };
    }),
  };
}

/**
 * The streets a long press can name (`pin-pick.ts`): the tiles' named street lines (`transportation_name`), drawn
 * all but invisibly on top, so the map can say which runs under a finger anywhere along it, not only at its label.
 */
export const STREET_PICK_LAYER = "street-pick";

export function withStreetPick(style: MapStyleJson): MapStyleJson {
  const source = style.layers.find((l) => l["source-layer"] === "transportation_name")?.source;
  if (typeof source !== "string" || style.layers.some((l) => l.id === STREET_PICK_LAYER)) return style;
  const pick: MapStyleLayer = {
    id: STREET_PICK_LAYER,
    type: "line",
    source,
    "source-layer": "transportation_name",
    minzoom: 12,
    filter: ["has", "name"],
    // Not 0: MapLibre skips a layer it doesn't draw, from queries too. 1 % of a 1 px line shows nowhere.
    paint: { "line-opacity": 0.01, "line-width": 1 },
  };
  return { ...style, layers: [...style.layers, pick] };
}

/** All: house numbers from z15, POI names from z16, no bins, playgrounds and the like, the streets a press names. */
export function withStreetLabels(style: MapStyleJson): MapStyleJson {
  return withStreetPick(withPoisFromStreetLevel(withHouseNumbers(style)));
}
