import type { MapStyleJson } from "@/config/map-dark";

/** Android for Cars' map guidelines: text not paired with a road or route at least 24 dp; icons and markers 36 dp. */
export const CAR_MIN_TEXT_DP = 24;
export const CAR_MIN_ICON_DP = 36;
/** The POI icons' size in the style's sprite (OpenFreeMap's), dp. */
const POI_ICON_DP = 19;
/** What a driver stops for (OpenMapTiles `poi.class`; charging stations are `fuel` too, subclass `charging_station`). */
export const CAR_POI_CLASSES = ["fuel"];
/**
 * Landmarks to check the dot by: railway stations and halts, the metro's too (`poi.class` `railway`); not tram stops,
 * as not bus stops. Airports come with their own layer (`aerodrome_label`), untouched.
 */
export const CAR_RAILWAY_SUBCLASSES = ["station", "halt", "subway"];
/** The POIs a driver needs (the car's map's; the phone's at any distance in heading-up, UI-SPEC §6.1), as a filter. */
export const DRIVER_POI_FILTER = [
  "any",
  ["in", ["get", "class"], ["literal", CAR_POI_CLASSES]],
  ["all", ["==", ["get", "class"], "railway"], ["in", ["get", "subclass"], ["literal", CAR_RAILWAY_SUBCLASSES]]],
];
/**
 * Ways a car can't take (OpenMapTiles `transportation.class`: footways, cycleways, steps, paths; pedestrian streets):
 * in parks and yards their dashes were the busiest thing on the car's screen. Service roads and tracks stay.
 */
export const CAR_HIDDEN_WAY_CLASSES = ["path", "pedestrian"];

/**
 * The car's map style (ANDROID-AUTO-SPEC §4, CARPLAY-SPEC §4): no footways, and only a driver's POIs, at the guidelines'
 * sizes for a map drawn `scale` times Android Auto's density; null: at the style's own sizes (CarPlay's points are
 * already made for the car's screen).
 */
export function carMapStyle(style: MapStyleJson, scale: number | null): MapStyleJson {
  return withCarPois(withoutFootways(style), scale);
}

/** No ways a car can't take, nor their names. */
export function withoutFootways(style: MapStyleJson): MapStyleJson {
  const drivable = ["!", ["in", ["get", "class"], ["literal", CAR_HIDDEN_WAY_CLASSES]]];
  return {
    ...style,
    layers: style.layers.map((l) => {
      const source = l["source-layer"];
      if (source !== "transportation" && source !== "transportation_name") return l;
      return { ...l, filter: l.filter ? ["all", l.filter, drivable] : drivable };
    }),
  };
}

/**
 * The car's map style (ANDROID-AUTO-SPEC §4), for a map drawn `scale` times the car's density (CarMapSurface): of the
 * POIs only what a driver stops for and the landmarks, their names and icons as big as the guidelines ask. Null: their
 * sizes as the style has them.
 */
export function withCarPois(style: MapStyleJson, scale: number | null): MapStyleJson {
  const keep = DRIVER_POI_FILTER;
  const sized =
    scale == null
      ? {}
      : { "text-size": Math.ceil(CAR_MIN_TEXT_DP / scale), "icon-size": Math.ceil((CAR_MIN_ICON_DP / (POI_ICON_DP * scale)) * 100) / 100 };
  return {
    ...style,
    layers: style.layers.map((l) => {
      if (l["source-layer"] !== "poi") return l;
      const layout = { ...l.layout, ...sized };
      return { ...l, layout, filter: l.filter ? ["all", l.filter, keep] : keep };
    }),
  };
}
