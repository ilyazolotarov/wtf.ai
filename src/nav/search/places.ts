// Places to stop at in the search file (STOPS-SPEC §6.1, SEARCH-SPEC §3.3): fuel, charging, cafés, food,
// pharmacies, parking. Written by tools/tiles/tiles/search.py (`place_section`); keep both in step.

/** Header flag: the file has the places section and its trailer (offset, count, "WTFP") before the entrances'. */
export const FLAG_PLACES = 2;
export const PLACE_MAGIC = "WTFP";
/** i32 lat, lon (1e-6°), u32 name (NONE: none), u16 flags, u8 category, u8 reserved. */
export const PLACE_BYTES = 16;
/** u32 cell key, u32 first place; the table ends with (NONE, place count). */
export const CELL_BYTES = 8;
/** Grid cells are 0.01°: key = row × CELL_COLS + column, rows from −90°, columns from −180°, in 1e-6° units. */
export const CELL_E6 = 10_000;
export const CELL_COLS = 36_000;

export type PlaceCategory = "fuel" | "charging" | "cafe" | "food" | "pharmacy" | "parking";

/** The category byte's meaning (1–6); any other value is a category this app doesn't know, and is skipped. */
export const PLACE_CATEGORIES: readonly (PlaceCategory | undefined)[] = [
  undefined,
  "fuel",
  "charging",
  "cafe",
  "food",
  "pharmacy",
  "parking",
];

/** Bits of `StopPlace.flags`: open 24/7, and at a fuel station the fuels it sells. */
export const PlaceFlag = { open24h: 1, diesel: 2, lpg: 4, octane92: 8, octane95: 16, octane98: 32 } as const;

export interface StopPlace {
  /** `p<index>`: the place's index in the file, stable for one file. */
  key: string;
  category: PlaceCategory;
  /** `name`, else `name:uk`, else `brand`; null: the row shows the category's word. */
  name: string | null;
  lat: number;
  lon: number;
  /** PlaceFlag bits. */
  flags: number;
}

/** A box in degrees. */
export interface PlaceBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** The cell row (latitude) or column (longitude) of a coordinate in 1e-6°. */
export const cellRow = (lat6: number) => Math.floor((lat6 + 90_000_000) / CELL_E6);
export const cellCol = (lon6: number) => Math.min(CELL_COLS - 1, Math.floor((lon6 + 180_000_000) / CELL_E6));
