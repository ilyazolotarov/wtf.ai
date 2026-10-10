import { readFileSync } from "node:fs";
import path from "node:path";

import { FALLBACK_PALETTE } from "@/components/guide/map-colors";
import { tintDarkStyle, type MapStyleJson } from "@/config/map-dark";
import { cssToHex, stylePalette, type MapPalette } from "@/config/map-palette";

const liberty = JSON.parse(readFileSync(path.join(__dirname, "../../../tools/tiles/style/liberty.json"), "utf8")) as MapStyleJson;

/** Each channel within `tol` (the dark tint rounds to whole hsl percents). */
function near(a: MapPalette, b: MapPalette, tol: number): string[] {
  const off: string[] = [];
  for (const role of Object.keys(a) as (keyof MapPalette)[]) {
    const ch = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const [x, y] = [ch(a[role]), ch(b[role])];
    if (x.some((v, i) => Math.abs(v - y[i]) > tol)) off.push(`${role}: ${a[role]} vs ${b[role]}`);
  }
  return off;
}

describe("the map's palette, read from its style", () => {
  test("light: Liberty as the map packs ship it, and the lessons' fallback is the same", () => {
    expect(stylePalette(liberty)).toEqual(FALLBACK_PALETTE.light);
  });

  test("dark: Liberty re-tinted for Night Drive, and the fallback is its palette", () => {
    const dark = stylePalette(tintDarkStyle(liberty));
    expect(dark).not.toBeNull();
    expect(near(dark!, FALLBACK_PALETTE.dark, 3)).toEqual([]);
  });

  test("a zoom-dependent colour is read at street level; a missing layer gives none", () => {
    const style = (land: unknown): MapStyleJson => ({
      layers: liberty.layers.map((l) => (l.id === "background" ? { ...l, paint: { "background-color": land } } : l)),
    });
    expect(stylePalette(style(["interpolate", ["linear"], ["zoom"], 10, "#000", 15, "#fff", 18, "#f00"]))?.land).toBe("#FFFFFF");
    expect(stylePalette(style(["step", ["zoom"], "#000", 14, "#00f"]))?.land).toBe("#0000FF");
    expect(stylePalette({ layers: liberty.layers.filter((l) => l.id !== "water") })).toBeNull();
  });

  test("CSS colours to hex", () => {
    expect(cssToHex("#fea")).toBe("#FFEEAA");
    expect(cssToHex("#0b0d11")).toBe("#0B0D11");
    expect(cssToHex("rgb(158,189,255)")).toBe("#9EBDFF");
    expect(cssToHex("hsl(35,8%,85%)")).toBe("#DCD9D6");
    expect(cssToHex("hsla(0, 0%, 100%, 0.5)")).toBe("#FFFFFF");
    expect(cssToHex("blue")).toBeNull();
  });
});
