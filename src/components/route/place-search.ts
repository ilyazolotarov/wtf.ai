import type { Strings } from "@/i18n/en";
import type { Coordinate } from "@/nav/geo";
import { orientPoint, parseCoordinates } from "@/nav/search/coordinates";
import { geoSearchText } from "@/nav/search/geo-uri";
import type { SearchIndex, SearchResult } from "@/nav/search/search-index";
import { inBounds } from "@/providers/places";
import type { Place } from "@/services/navigation/places-store";

import { resultDetail, resultTitle } from "./search-text";

// Places to route to from what the driver searched for (SEARCH-SPEC §5): the route screen's and the car's search.

type T = (key: keyof Strings) => string;
type Bounds = [number, number, number, number] | null;

/** A search result as the lists show it and the route goes to; a house keeps its entrances (its card offers them). */
export function resultPlace(r: SearchResult, language: "en" | "uk", t: T): Place {
  return {
    id: `search:${r.key}`,
    title: resultTitle(r, language, t),
    detail: resultDetail(r, language, t),
    lat: r.lat,
    lon: r.lon,
    ...(r.entrances.length > 0 ? { entrances: r.entrances.map((e) => ({ ref: e.ref!, lat: e.lat, lon: e.lon })) } : {}),
  };
}

/**
 * Coordinates typed or pasted (SEARCH-SPEC §4.5): the place at that point, named by the house there (within 75 m, as a
 * dropped pin), else "Selected location" in its settlement; the coordinates follow. The route goes to the exact point.
 */
export function pointPlace(text: string, index: SearchIndex | null, bounds: Bounds, language: "en" | "uk", t: T): Place | null {
  const typed = parseCoordinates(text);
  if (!typed) return null;
  const at = orientPoint(typed, (c) => inBounds(bounds, c));
  let named: { title: string; detail: string | null } | null = null;
  try {
    const town = index?.settlementAt(at) ?? null;
    const house = index?.nearestAddress(at) ?? null;
    // A house's detail is its settlement; one addressed by its quarter or village names none of its own.
    const detail = house && (house.settlement || !town ? resultDetail(house, language, t) : resultTitle(town, language, t));
    named = house
      ? { title: resultTitle(house, language, t), detail }
      : { title: t("selectedLocation"), detail: town ? resultTitle(town, language, t) : null };
  } catch (e) {
    console.warn(`point name: ${e instanceof Error ? e.message : String(e)}`);
  }
  const coordinates = `${at.lat.toFixed(5)}, ${at.lon.toFixed(5)}`;
  return {
    id: `point:${at.lat.toFixed(6)},${at.lon.toFixed(6)}`,
    title: named?.title ?? t("selectedLocation"),
    detail: named?.detail ? `${named.detail} · ${coordinates}` : coordinates,
    lat: at.lat,
    lon: at.lon,
  };
}

/**
 * What a query finds at once (the car's search; the route screen waits for typing to pause): a point (typed, or a
 * `geo:` link), else the region's index, nearest first around `near`; a region without one has `cities` to match.
 */
export function findPlaces(
  query: string,
  options: { index: SearchIndex | null; bounds: Bounds; near: Coordinate | null; cities: Place[]; language: "en" | "uk"; t: T; limit?: number },
): Place[] {
  const { index, bounds, near, cities, language, t, limit = 25 } = options;
  const text = (geoSearchText(query) ?? query).trim();
  if (!text) return [];
  const point = pointPlace(text, index, bounds, language, t);
  if (point) return [point];
  if (!index) {
    const q = text.toLocaleLowerCase();
    return cities.filter((c) => c.title.toLocaleLowerCase().includes(q)).slice(0, limit);
  }
  try {
    return index.search(text, { near, limit }).map((r) => resultPlace(r, language, t));
  } catch (e) {
    console.warn(`search: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
