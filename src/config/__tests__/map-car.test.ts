import { CAR_MIN_ICON_DP, CAR_MIN_TEXT_DP, withCarPois, withoutFootways } from "@/config/map-car";
import type { MapStyleJson } from "@/config/map-dark";

/** Evaluates the few expressions the filters use (all, any, !, in, get, literal, ==) against a feature's properties. */
function evaluate(e: unknown, props: Record<string, string>): unknown {
  if (!Array.isArray(e)) return e;
  const [op, ...args] = e as [string, ...unknown[]];
  if (op === "all") return args.every((a) => evaluate(a, props) === true);
  if (op === "any") return args.some((a) => evaluate(a, props) === true);
  if (op === "!") return !evaluate(args[0], props);
  if (op === "get") return props[args[0] as string];
  if (op === "literal") return args[0];
  if (op === "in") return (evaluate(args[1], props) as unknown[]).includes(evaluate(args[0], props));
  if (op === "==") return evaluate(args[0], props) === evaluate(args[1], props);
  throw new Error(`unexpected ${op}`);
}

const style = (): MapStyleJson => ({
  version: 8,
  layers: [
    { id: "highway-name-minor", type: "symbol", source: "openmaptiles", "source-layer": "transportation_name", layout: { "text-size": 13 } },
    { id: "poi_r1", type: "symbol", source: "openmaptiles", "source-layer": "poi", layout: { "text-size": 12, "text-field": ["get", "name"] } },
    { id: "poi_transit", type: "symbol", source: "openmaptiles", "source-layer": "poi", filter: ["in", ["get", "class"], ["literal", ["airport", "bus", "rail"]]], layout: { "text-size": 12, "icon-size": 0.7 } },
  ],
});

describe("the car's POIs", () => {
  test("only fuel, charging and the landmarks: railway and metro stations, not tram or bus stops", () => {
    const [, r1] = withCarPois(style(), 1.4).layers;
    // As the tiles carry them (OpenMapTiles poi: class and subclass).
    const pois = [
      ["fuel", "fuel"],
      ["fuel", "charging_station"],
      ["railway", "station"],
      ["railway", "halt"],
      ["railway", "subway"],
      ["railway", "tram_stop"],
      ["bus", "bus_stop"],
      ["entrance", "subway_entrance"],
      ["cafe", "cafe"],
      ["parking", "parking"],
    ];
    const shown = pois.filter(([cls, subclass]) => evaluate(r1.filter, { class: cls, subclass }) === true).map(([, s]) => s);
    expect(shown).toEqual(["fuel", "charging_station", "station", "halt", "subway"]);
  });

  test("names and icons at the guidelines' sizes once the car draws the map bigger", () => {
    const scale = 1.4;
    const [street, r1, transit] = withCarPois(style(), scale).layers;
    for (const layer of [r1, transit]) {
      expect((layer.layout!["text-size"] as number) * scale).toBeGreaterThanOrEqual(CAR_MIN_TEXT_DP);
      expect((layer.layout!["icon-size"] as number) * 19 * scale).toBeGreaterThanOrEqual(CAR_MIN_ICON_DP);
      expect((layer.layout!["icon-size"] as number) * 19 * scale).toBeLessThan(CAR_MIN_ICON_DP + 1);
    }
    expect(r1.layout?.["text-field"]).toEqual(["get", "name"]);
    // Street names go with their road: only the car's scale makes them bigger.
    expect(street).toEqual(style().layers[0]);
  });
});

describe("the car's ways", () => {
  test("no footways, steps, cycleways or pedestrian streets, nor their names; roads, yards and tracks stay", () => {
    const out = withoutFootways({
      version: 8,
      layers: [
        { id: "road_minor", type: "line", "source-layer": "transportation", filter: ["==", ["get", "brunnel"], "none"] },
        { id: "highway-name-path", type: "symbol", "source-layer": "transportation_name" },
        { id: "water", type: "fill", "source-layer": "water" },
      ],
    });
    const [road, names, water] = out.layers;
    const drawn = (layer: typeof road, props: Record<string, string>) => evaluate(layer.filter, props) === true;
    expect(["minor", "service", "track", "path", "pedestrian"].filter((c) => drawn(road, { class: c, brunnel: "none" }))).toEqual([
      "minor",
      "service",
      "track",
    ]);
    expect(drawn(road, { class: "minor", brunnel: "bridge" })).toBe(false);
    expect(drawn(names, { class: "path" })).toBe(false);
    expect(drawn(names, { class: "secondary" })).toBe(true);
    expect(water.filter).toBeUndefined();
  });
});
