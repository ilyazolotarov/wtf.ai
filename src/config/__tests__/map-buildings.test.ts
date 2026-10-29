import { readFileSync } from "fs";
import { join } from "path";

import { raisesBuildings, withFlatBuildings } from "@/config/map-buildings";
import type { MapStyleJson } from "@/config/map-dark";

const liberty = (): MapStyleJson =>
  JSON.parse(readFileSync(join(__dirname, "../../../tools/tiles/style/liberty.json"), "utf8")) as MapStyleJson;

describe("flat buildings", () => {
  test("no extrusions; the flat fill drawn past z14, where the extrusions took over", () => {
    const style = liberty();
    expect(style.layers.some((l) => l.type === "fill-extrusion")).toBe(true);
    const flat = withFlatBuildings(style);
    const buildings = flat.layers.filter((l) => l["source-layer"] === "building");
    expect(buildings.map((l) => l.type)).toEqual(["fill"]);
    expect(buildings[0].minzoom).toBe(13);
    expect(buildings[0].maxzoom).toBeUndefined();
    expect(buildings[0].paint).toEqual(style.layers.find((l) => l.id === buildings[0].id)?.paint);
  });

  test("every other layer as it was, in its order", () => {
    const style = liberty();
    const others = (s: MapStyleJson) => s.layers.filter((l) => l["source-layer"] !== "building");
    expect(others(withFlatBuildings(style))).toEqual(others(style));
  });
});

describe("Settings → 3D buildings", () => {
  test("on everywhere, phone only on the phone's maps, off nowhere", () => {
    expect([raisesBuildings("on", false), raisesBuildings("on", true)]).toEqual([true, true]);
    expect([raisesBuildings("phone", false), raisesBuildings("phone", true)]).toEqual([true, false]);
    expect([raisesBuildings("off", false), raisesBuildings("off", true)]).toEqual([false, false]);
  });
});
