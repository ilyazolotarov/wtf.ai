import { DARK_PALETTE } from "@/config/map-dark";
import { blend, type MapPalette } from "@/config/map-palette";

/** Liberty draws parks at this opacity over the land. */
const PARK_OPACITY = 0.7;

/** A lesson map's colours: the real map's palette, and the car drawn on it. */
export type MapColors = MapPalette & { car: string };

export const CAR_COLOR = { light: "#1D1C1A", dark: "#F2F0EC" } as const;

/**
 * The map's palette when no offline region is usable to read it from (`useMapPalette`): Liberty's colours as the map
 * packs ship them, and the Night Drive palette it is re-tinted with. A test holds both to what `stylePalette` reads
 * from `tools/tiles/style/liberty.json`.
 */
export const FALLBACK_PALETTE: Record<"light" | "dark", MapPalette> = {
  light: {
    land: "#F8F4F0",
    building: "#DCD9D6",
    park: blend("#F8F4F0", "#D8E8C8", PARK_OPACITY),
    water: "#9EBDFF",
    minor: "#FFFFFF",
    minorCasing: "#CFCDCA",
    major: "#FFEEAA",
    majorCasing: "#E9AC77",
  },
  dark: {
    land: DARK_PALETTE.ground,
    building: DARK_PALETTE.building,
    park: blend(DARK_PALETTE.ground.toUpperCase(), DARK_PALETTE.park.toUpperCase(), PARK_OPACITY),
    water: DARK_PALETTE.water,
    minor: DARK_PALETTE.minor,
    minorCasing: DARK_PALETTE.casing,
    major: DARK_PALETTE.primary,
    majorCasing: DARK_PALETTE.casing,
  },
};
