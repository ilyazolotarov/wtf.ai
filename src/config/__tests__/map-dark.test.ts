import { tintDarkStyle, type MapStyleLayer } from "@/config/map-dark";

const tint = (layers: MapStyleLayer[]) => tintDarkStyle({ version: 8, layers }).layers;

describe("dark map tint", () => {
  test("darkens ground and water, keeps non-color values", () => {
    const [bg, water] = tint([
      { id: "background", type: "background", paint: { "background-color": "#f8f4f0" } },
      { id: "water", type: "fill", paint: { "fill-color": "rgb(158,189,255)", "fill-opacity": 0.5 } },
    ]);
    expect(bg.paint?.["background-color"]).toBe("hsla(30, 13%, 17%, 1)");
    expect(water.paint).toEqual({ "fill-color": "hsla(212, 28%, 17%, 1)", "fill-opacity": 0.5 });
  });

  test("recolors color literals inside expressions only", () => {
    const [road] = tint([
      {
        id: "road_minor",
        type: "line",
        paint: { "line-color": ["match", ["get", "class"], "service", "#fff", "hsl(0,0%,80%)"] },
      },
    ]);
    expect(road.paint?.["line-color"]).toEqual([
      "match",
      ["get", "class"],
      "service",
      "hsla(215, 8%, 40%, 1)",
      "hsla(215, 8%, 38%, 1)",
    ]);
  });

  test("road names get dark text on a white halo, shields untouched", () => {
    const [name, shield, place] = tint([
      { id: "highway-name-major", type: "symbol", layout: { "symbol-placement": "line" }, paint: { "text-color": "#765" } },
      { id: "road_shield_us", type: "symbol", paint: { "text-color": "#000" } },
      { id: "label_city", type: "symbol", paint: { "text-color": "#333", "text-halo-color": "rgba(255,255,255,0.8)" } },
    ]);
    expect(name.paint).toMatchObject({ "text-color": "#161616", "text-halo-color": "rgba(255,255,255,0.92)" });
    expect(shield.paint).toEqual({ "text-color": "#000" });
    expect(place.paint).toEqual({ "text-color": "hsla(0, 0%, 86%, 1)", "text-halo-color": "hsla(0, 0%, 8%, 0.8)" });
  });

  test("does not mutate the input style", () => {
    const layer: MapStyleLayer = { id: "background", type: "background", paint: { "background-color": "#fff" } };
    tint([layer]);
    expect(layer.paint?.["background-color"]).toBe("#fff");
  });
});
