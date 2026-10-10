import { DARK_PALETTE, tintDarkStyle, type MapStyleLayer } from "@/config/map-dark";

const tint = (layers: MapStyleLayer[]) => tintDarkStyle({ version: 8, layers }).layers;

describe("dark map tint", () => {
  test("paints ground and water their palette colors, keeps non-color values", () => {
    const [bg, water, park] = tint([
      { id: "background", type: "background", paint: { "background-color": "#f8f4f0" } },
      { id: "water", type: "fill", paint: { "fill-color": "rgb(158,189,255)", "fill-opacity": 0.5 } },
      { id: "park", type: "fill", paint: { "fill-color": "#d8e8c8" } },
    ]);
    expect(bg.paint?.["background-color"]).toBe("hsla(223, 24%, 6%, 1)"); // #0b0d11
    expect(water.paint).toEqual({ "fill-color": "hsla(211, 87%, 15%, 1)", "fill-opacity": 0.5 }); // #05264a
    expect(park.paint?.["fill-color"]).toBe("hsla(146, 40%, 8%, 1)"); // between park and wood
  });

  test("recolors color literals inside expressions only", () => {
    const [road] = tint([
      {
        id: "road_minor",
        type: "line",
        paint: { "line-color": ["match", ["get", "class"], "service", "#fff", "hsl(0,0%,80%)"] },
      },
    ]);
    expect(road.paint?.["line-color"]).toEqual(["match", ["get", "class"], "service", "hsla(219, 15%, 35%, 1)", "hsla(219, 15%, 35%, 1)"]);
  });

  test("trunk roads (Ukraine's national highways) get the motorway color, boundaries their own", () => {
    const [trunk, boundary] = tint([
      { id: "road_trunk_primary", type: "line", paint: { "line-color": "#fff" } },
      { id: "boundary_2", type: "line", paint: { "line-color": "hsl(248,1%,41%)" } },
    ]);
    expect(trunk.paint?.["line-color"]).toEqual(["match", ["get", "class"], "trunk", DARK_PALETTE.motorway, DARK_PALETTE.primary]);
    expect(boundary.paint?.["line-color"]).toBe("hsla(254, 22%, 54%, 1)"); // #7a6ea3
  });

  test("road names get dark text on a white halo, shields untouched, places light on dark", () => {
    const [name, shield, place] = tint([
      { id: "highway-name-major", type: "symbol", layout: { "symbol-placement": "line" }, paint: { "text-color": "#765" } },
      { id: "road_shield_us", type: "symbol", paint: { "text-color": "#000" } },
      { id: "label_city", type: "symbol", paint: { "text-color": "#333", "text-halo-color": "rgba(255,255,255,0.8)" } },
    ]);
    expect(name.paint).toMatchObject({ "text-color": "hsla(0, 0%, 7%, 1)", "text-halo-color": "hsla(0, 0%, 100%, 0.95)", "text-halo-width": 2 });
    expect(shield.paint).toEqual({ "text-color": "#000" });
    expect(place.paint).toEqual({ "text-color": "hsla(0, 0%, 100%, 1)", "text-halo-color": "hsla(0, 0%, 0%, 0.8)", "text-halo-width": 1.2 });
  });

  test("does not mutate the input style", () => {
    const layer: MapStyleLayer = { id: "background", type: "background", paint: { "background-color": "#fff" } };
    tint([layer]);
    expect(layer.paint?.["background-color"]).toBe("#fff");
  });
});
