import type { MapStyleJson } from "@/config/map-dark";
import type { Buildings3d } from "@/services/map-preferences";

/** Whether a map draws its buildings raised (Settings → 3D buildings): `onCar`, the car's screen's map. */
export function raisesBuildings(buildings3d: Buildings3d, onCar: boolean): boolean {
  return buildings3d === "on" || (buildings3d === "phone" && !onCar);
}

/**
 * The buildings flat (Settings → 3D buildings, UI-SPEC §4.6): no extrusions. Liberty's flat building fill, which stops
 * at z14 where its extrusions take over, is drawn at every zoom instead, its edge and dark tint as they are.
 */
export function withFlatBuildings(style: MapStyleJson): MapStyleJson {
  return {
    ...style,
    layers: style.layers.flatMap((layer) => {
      if (layer["source-layer"] !== "building") return [layer];
      if (layer.type === "fill-extrusion") return [];
      if (layer.type !== "fill" || layer.maxzoom === undefined) return [layer];
      const flat = { ...layer };
      delete flat.maxzoom;
      return [flat];
    }),
  };
}
