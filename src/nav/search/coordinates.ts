import type { Coordinate } from "@/nav/geo";

/**
 * A point typed or pasted into the search field (SEARCH-SPEC §4.5): "50.45012, 30.52341" (Google Maps' copy),
 * "50°27'00.4"N 30°31'24.2"E", "50.45° N, 30.52° E", "50°27.006'N 30°31.403'E", "N50.45 E30.52", "50,45 30,52",
 * a Google Maps, OpenStreetMap or Apple Maps link, a `geo:` URI, "lat: 50.45, lon: 30.52". Offline: a short link
 * (maps.app.goo.gl) is not opened.
 */
export interface TypedPoint extends Coordinate {
  /** Which number is the latitude is known (letters, a link, labels); else read as "lat, lon", maybe the other way. */
  ordered: boolean;
}

const SIGNED = String.raw`[-+]?\d+(?:\.\d+)?`;
const LINK = /^(?:https?:\/\/|geo:|www\.)/i;
// In a link, the place: Google's pin (!3d…!4d…), a query parameter, geo:.
const LINK_PLACE = [
  new RegExp(String.raw`!3d(${SIGNED})!4d(${SIGNED})`),
  new RegExp(String.raw`[?&](?:q|query|ll|sll|daddr|destination|coordinates)=(${SIGNED}),\s*(${SIGNED})`),
  new RegExp(String.raw`^geo:(${SIGNED}),(${SIGNED})`, "i"),
];
// Else the map's centre: Google's @lat,lon, OSM's #map=z/lat/lon.
const LINK_CENTRE = [
  new RegExp(String.raw`@(${SIGNED}),(${SIGNED})`),
  new RegExp(String.raw`#map=\d+(?:\.\d+)?/(${SIGNED})/(${SIGNED})`),
];
const LAT_KEY = new RegExp(String.raw`(?:^|[^a-z])m?lat(?:itude)?\s*[:=]\s*(${SIGNED})`, "i");
const LON_KEY = new RegExp(String.raw`(?:^|[^a-z])m?(?:lon|lng)(?:gitude)?\s*[:=]\s*(${SIGNED})`, "i");
// A hemisphere letter, a number with its unit (degrees, minutes, seconds), a separator; anything else is not a point.
const TOKEN = /([NSEW])|([-+]?\d+(?:\.\d+)?)\s*([°'"])?|([,;])|(\S)/gi;

/** The point the text is, or null when it's not just coordinates. */
export function parseCoordinates(text: string): TypedPoint | null {
  let s = text.trim();
  if (!s || s.length > 2000) return null;
  // Links come URL-encoded ("50.45%2C30.52").
  if (/%[0-9a-f]{2}/i.test(s)) {
    try {
      s = decodeURIComponent(s);
    } catch {
      // keep it as it is
    }
  }
  const link = LINK.test(s);
  const found = link ? linked(s, LINK_PLACE) : null;
  if (found) return found;
  // Labelled: "lat: 50.45, lon: 30.52", OSM's marker (mlat, mlon).
  const lat = LAT_KEY.exec(s);
  const lon = LON_KEY.exec(s);
  if (lat && lon) return checked(Number(lat[1]), Number(lon[1]), true);
  return link ? linked(s, LINK_CENTRE) : pair(s);
}

function linked(s: string, patterns: RegExp[]): TypedPoint | null {
  for (const pattern of patterns) {
    const m = pattern.exec(s);
    if (m) return checked(Number(m[1]), Number(m[2]), true);
  }
  return null;
}

interface Half {
  letter: "N" | "S" | "E" | "W" | null;
  degrees: string;
  degreeSign: boolean;
  minutes: number | null;
  seconds: number | null;
}

/** Two halves: "50.45, 30.52", degrees with minutes and seconds, hemisphere letters before or after. */
function pair(text: string): TypedPoint | null {
  let s = text
    .replace(/^[([{]\s*|\s*[)\]}]$/g, "")
    .replace(/[º˚]/g, "°")
    .replace(/''|[″”“]/g, '"')
    .replace(/[′’‘´`]/g, "'");
  // Decimal commas, as a Ukrainian phone writes them: "50,45 30,52", "50,45; 30,52", "50,45, 30,52".
  const comma = /^([-+]?\d+),(\d+)(?:\s*;\s*|\s+|,\s+)([-+]?\d+),(\d+)$/.exec(s);
  if (comma) s = `${comma[1]}.${comma[2]} ${comma[3]}.${comma[4]}`;
  const tokens = [...s.matchAll(TOKEN)];
  if (tokens.length === 0) return null;
  // Letters lead ("N50.45 E30.52") or follow ("50.45N 30.52E"): the first token tells which.
  const leading = tokens[0][1] !== undefined;
  // The halves read so far; the last one takes minutes, seconds and a trailing letter until a separator or a letter
  // closes it.
  const halves: Half[] = [];
  let open = false;
  let letter: Half["letter"] = null;
  for (const [, l, number, unit, separator, other] of tokens) {
    const last = open ? halves[halves.length - 1] : null;
    if (other !== undefined) return null;
    if (separator !== undefined) {
      if (letter || halves.length !== 1) return null;
      open = false;
    } else if (l !== undefined) {
      const upper = l.toUpperCase() as Half["letter"];
      if (leading) {
        if (letter) return null;
        letter = upper;
        open = false;
      } else {
        if (!last) return null;
        last.letter = upper;
        open = false;
      }
    } else if (unit === "'" || unit === '"') {
      if (!last || !last.degreeSign || last.degrees.includes(".") || /^[-+]/.test(number!)) return null;
      if (unit === "'" ? last.minutes !== null || last.seconds !== null : last.seconds !== null) return null;
      if (unit === "'") last.minutes = Number(number);
      else last.seconds = Number(number);
    } else {
      // Degrees: a new half (after a leading letter, that letter's).
      if (leading && !letter) return null;
      halves.push({ letter, degrees: number!, degreeSign: unit === "°", minutes: null, seconds: null });
      open = true;
      letter = null;
    }
  }
  if (letter || halves.length !== 2) return null;
  const [a, b] = halves.map(value);
  if (!a || !b) return null;
  // Lettered: N/S is the latitude, E/W the longitude, in either order.
  if (a.axis || b.axis) {
    if (a.axis === b.axis) return null;
    const aIsLat = a.axis ? a.axis === "lat" : b.axis === "lon";
    return aIsLat ? checked(a.value, b.value, true) : checked(b.value, a.value, true);
  }
  // Bare numbers need a fraction or a degree sign: "16 3" is a house and its entrance.
  if (!a.precise || !b.precise) return null;
  // A first number past ±90 can only be a longitude.
  if (Math.abs(a.value) > 90 && Math.abs(b.value) <= 90) return checked(b.value, a.value, true);
  return checked(a.value, b.value, false);
}

function value(h: Half): { value: number; axis: "lat" | "lon" | null; precise: boolean } | null {
  const minutes = h.minutes ?? 0;
  const seconds = h.seconds ?? 0;
  if (minutes >= 60 || seconds >= 60) return null;
  if (h.letter && /^[-+]/.test(h.degrees)) return null;
  const magnitude = Math.abs(Number(h.degrees)) + minutes / 60 + seconds / 3600;
  const negative = h.degrees.startsWith("-") || h.letter === "S" || h.letter === "W";
  return {
    value: negative ? -magnitude : magnitude,
    axis: h.letter === "N" || h.letter === "S" ? "lat" : h.letter ? "lon" : null,
    precise: h.degrees.includes(".") || h.degreeSign,
  };
}

function checked(lat: number, lon: number, ordered: boolean): TypedPoint | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, ordered };
}

/** The point the driver meant: a bare "lat, lon" read the other way round when only that puts it in the region. */
export function orientPoint(point: TypedPoint, inRegion: (c: Coordinate) => boolean): Coordinate {
  const swapped = { lat: point.lon, lon: point.lat };
  if (!point.ordered && Math.abs(swapped.lat) <= 90 && !inRegion(point) && inRegion(swapped)) return swapped;
  return { lat: point.lat, lon: point.lon };
}
