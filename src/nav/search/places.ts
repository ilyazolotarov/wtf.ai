// Places to stop at in the search file (STOPS-SPEC §6.1, SEARCH-SPEC §3.3): fuel, charging, cafés, food,
// pharmacies, parking. Written by tools/tiles/tiles/search.py (`place_section`); keep both in step.

/** Header flag: the file has the places section and its trailer (offset, count, "WTFP") before the entrances'. */
export const FLAG_PLACES = 2;
export const PLACE_MAGIC = "WTFP";
/** i32 lat, lon (1e-6°), u32 name (NONE: none), u16 flags, u8 category, u8 reserved. */
export const PLACE_BYTES = 16;
/** u32 cell key, u32 first place; the table ends with (NONE, place count). */
export const CELL_BYTES = 8;
/**
 * Header flag: the places' opening hours, just before them: each place's schedule (u16, HOURS_NONE: unknown; padded
 * to 4 bytes), the schedules' first ranges (u32, one more than the schedules), the ranges (u16 start, end), and a
 * footer (offset, schedule count, "WTFH") ending where the places begin.
 */
export const FLAG_HOURS = 4;
export const HOURS_MAGIC = "WTFH";
export const HOURS_NONE = 0xffff;
/** Opening hours are minutes of the week, Monday 00:00 = 0, in [start, end) ranges. */
export const WEEK_MIN = 7 * 24 * 60;
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
  /** When it is open: [start, end) minutes of the week, as pairs, ascending ([]: always closed); null: unknown. */
  hours: readonly number[] | null;
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

/** The minute of the week (Monday 00:00 = 0) of a local time: the hours are the place's, the phone in its time zone. */
export const weekMinute = (d: Date) => ((d.getDay() + 6) % 7) * 1440 + d.getHours() * 60 + d.getMinutes();

/**
 * Open or not at `minute` of the week, and until when (a minute of the week): the end of the range it is in, or the
 * start of the next one; null: it never closes, or never opens.
 */
export function openAt(hours: readonly number[], minute: number): { open: boolean; until: number | null } {
  if (hours.length === 0) return { open: false, until: null };
  for (let i = 0; i < hours.length; i += 2) {
    const start = hours[i];
    const end = hours[i + 1];
    if (minute >= start && minute < end) {
      if (start === 0 && end === WEEK_MIN) return { open: true, until: null };
      // Sunday night into Monday: the range at the week's end goes on in the one at its start.
      return { open: true, until: end === WEEK_MIN && hours[0] === 0 ? hours[1] : end };
    }
    if (start > minute) return { open: false, until: start };
  }
  return { open: false, until: hours[0] };
}
