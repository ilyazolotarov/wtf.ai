import type { Coordinate } from "@/nav/geo";

/**
 * A place another app or the car's assistant asks for (SEARCH-SPEC §4.6): a `geo:` URI (RFC 5870 and Android's `?q=`:
 * `geo:50.45,30.52`, `geo:0,0?q=Khreshchatyk+22`, `geo:50.45,30.52?q=Name`, `geo:0,0?q=50.45,30.52(Name)`) or Google
 * Maps' `google.navigation:q=…`.
 */
export interface GeoRequest {
  /** The point, when the link gives one. */
  point: Coordinate | null;
  /** With no point, the words to search for; with one, its name. */
  query: string | null;
}

const NUMBER = String.raw`[-+]?\d+(?:\.\d+)?`;
const SCHEME = /^(geo|google\.navigation):(.*)$/is;
// "50.45,30.52" with an optional "(Name)", as a query.
const LABELLED_POINT = new RegExp(String.raw`^(${NUMBER})\s*,\s*(${NUMBER})\s*(?:\((.*)\))?$`, "s");
const PATH_POINT = new RegExp(String.raw`^(${NUMBER}),(${NUMBER})(?:,${NUMBER})?(?:;.*)?$`, "s");

/** What the link asks for; null when it is not one, or asks for nothing. */
export function parseGeoUri(uri: string): GeoRequest | null {
  const m = SCHEME.exec(uri.trim());
  if (!m) return null;
  const geo = m[1].toLowerCase() === "geo";
  const rest = m[2];
  const mark = rest.indexOf("?");
  // `google.navigation:q=…` has no path, only parameters.
  const [path, query] = mark >= 0 ? [rest.slice(0, mark), rest.slice(mark + 1)] : geo ? [rest, ""] : ["", rest];
  const params = parameters(query);
  let point = geo ? pathPoint(path) : null;
  let name: string | null = null;
  const q = params.get("q") ?? params.get("daddr") ?? null;
  const labelled = q ? LABELLED_POINT.exec(q) : null;
  if (labelled) {
    point ??= checked(Number(labelled[1]), Number(labelled[2]));
    name = words(labelled[3] ?? "");
  } else if (q) {
    name = words(q);
  }
  const ll = params.get("ll");
  const llPoint = ll ? LABELLED_POINT.exec(ll) : null;
  if (llPoint) point ??= checked(Number(llPoint[1]), Number(llPoint[2]));
  if (!point && !name) return null;
  return { point, query: name };
}

function pathPoint(path: string): Coordinate | null {
  const m = PATH_POINT.exec(decode(path).trim());
  return m ? checked(Number(m[1]), Number(m[2])) : null;
}

/** A point on the map; "0,0" is a geo URI's "no point". */
function checked(lat: number, lon: number): Coordinate | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return lat === 0 && lon === 0 ? null : { lat, lon };
}

function parameters(query: string): Map<string, string> {
  const params = new Map<string, string>();
  for (const part of query.split("&")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = decode(part.slice(0, eq)).toLowerCase();
    if (!params.has(key)) params.set(key, decode(part.slice(eq + 1)));
  }
  return params;
}

function decode(s: string): string {
  const spaced = s.replace(/\+/g, " ");
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}

const words = (s: string): string | null => s.replace(/\s+/g, " ").trim() || null;

/**
 * The link as the search field's words: the point's coordinates ("50.450000, 30.520000"), else its words as the index
 * holds them (`addressQueries`' first); null: not a link.
 */
export function geoSearchText(uri: string): string | null {
  const geo = parseGeoUri(uri);
  if (!geo) return null;
  return geo.point ? `${geo.point.lat.toFixed(6)}, ${geo.point.lon.toFixed(6)}` : addressQueries(geo.query!)[0];
}

const COUNTRIES = new Set(["ukraine", "україна", "украина"]);
// "02000"; the US "CA 94043-1351".
const POSTCODE = /^(?:[A-Z]{2}\s+)?\d{5}(?:-\d{4})?$/i;
const REGION = /\b(?:oblast|region|raion|district)\b|област|район/i;
const HOUSE = /^\d+[\p{L}\d/-]*$/u;

/**
 * A link's words to search for, the first as complete as the index can match, then less: the car's assistant sends
 * Google's formatted address ("Khreshchatyk St, 22, Kyiv, Ukraine, 02000"; a place's name first: "Kyiv Pechersk
 * Lavra, Lavrska St, 15, Kyiv, Ukraine, 01015"), whose country, postcode (read as the house) and oblast the index
 * doesn't hold. Then a place's address before its name; an address's street without the house.
 */
export function addressQueries(query: string): string[] {
  const parts = query
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const kept = parts.filter((p, i) => i === 0 || !(COUNTRIES.has(p.toLowerCase()) || POSTCODE.test(p) || REGION.test(p)));
  const queries = [kept.join(", ")];
  if (kept.length >= 3 && HOUSE.test(kept[2]) && !HOUSE.test(kept[1])) queries.push(kept.slice(1).join(", "), kept[0]);
  else if (kept.length >= 2 && HOUSE.test(kept[1])) queries.push([kept[0], ...kept.slice(2)].join(", "));
  return queries;
}
