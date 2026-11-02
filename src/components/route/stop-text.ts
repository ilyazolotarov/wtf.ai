// How stops and places along the route read (STOPS-SPEC §7): a kind's icon and word, a place's name or its kind,
// what the search file knows of it ("right · diesel, 95, LPG · 24/7"), a detour's minutes.

import type { IconName } from "@/components/ui/icon";
import type { Strings } from "@/i18n/en";
import { detourMinutes } from "@/nav/routing/detour";
import type { RoadSide } from "@/nav/routing/router";
import { openAt, weekMinute } from "@/nav/search/places";
import { PlaceFlag, type PlaceCategory, type StopPlace } from "@/nav/search/search-index";

type T = (key: keyof Strings) => string;

/** The kinds in the order the route page and the list offer them. */
export const STOP_CATEGORIES: readonly PlaceCategory[] = ["fuel", "charging", "cafe", "food", "pharmacy", "parking"];

export const CATEGORY_ICON: Record<PlaceCategory, IconName> = {
  fuel: "local_gas_station",
  charging: "ev_station",
  cafe: "local_cafe",
  food: "restaurant",
  pharmacy: "local_pharmacy",
  parking: "local_parking",
};

/** The kind's word on a chip or a tile ("Fuel", "Pharmacies"). */
export const CATEGORY_LABEL: Record<PlaceCategory, keyof Strings> = {
  fuel: "catFuel",
  charging: "catCharging",
  cafe: "catCafe",
  food: "catFood",
  pharmacy: "catPharmacy",
  parking: "catParking",
};

/** One place of the kind, for one without a name ("Fuel station", "Pharmacy"). */
const PLACE_WORD: Record<PlaceCategory, keyof Strings> = {
  fuel: "poiFuel",
  charging: "poiCharging",
  cafe: "poiCafe",
  food: "placeFood",
  pharmacy: "poiPharmacy",
  parking: "poiParking",
};

export const placeName = (p: Pick<StopPlace, "name" | "category">, t: T) => p.name ?? t(PLACE_WORD[p.category]);

/**
 * The side of the road, the fuels sold, and 24/7 or whether it is open at `nowMs` and till when, as far as the map
 * knows them.
 */
export function placeDetail(
  p: Pick<StopPlace, "flags" | "category"> & { hours?: StopPlace["hours"] },
  side: RoadSide | null,
  t: T,
  nowMs: number,
): string {
  const parts: string[] = [];
  if (side) parts.push(t(side === "left" ? "sideLeft" : "sideRight"));
  if (p.category === "fuel") {
    const fuels = [
      p.flags & PlaceFlag.diesel ? t("fuelDiesel") : null,
      p.flags & PlaceFlag.octane92 ? "92" : null,
      p.flags & PlaceFlag.octane95 ? "95" : null,
      p.flags & PlaceFlag.octane98 ? "98" : null,
      p.flags & PlaceFlag.lpg ? t("fuelLpg") : null,
    ].filter((x): x is string => x !== null);
    if (fuels.length) parts.push(fuels.join(", "));
  }
  if (p.flags & PlaceFlag.open24h) parts.push(t("open24h"));
  else if (p.hours && nowMs > 0) parts.push(hoursText(p.hours, new Date(nowMs), t));
  return parts.join(" · ");
}

/**
 * "open till 22:00", "closed till 8:00"; with the day ("closed till Mon 8:00") when that is a day or more away.
 * `hours`: minutes of the week (`StopPlace.hours`), in the phone's local time.
 */
export function hoursText(hours: readonly number[], now: Date, t: T): string {
  const minute = weekMinute(now);
  const { open, until } = openAt(hours, minute);
  if (until === null) return open ? t("open24h") : t("closedAlways");
  const inDay = until % 1440;
  const clock = `${Math.floor(inDay / 60)}:${String(inDay % 60).padStart(2, "0")}`;
  const away = (until - minute + 7 * 1440) % (7 * 1440);
  const time = away >= 1440 ? `${t("weekdaysShort").split(" ")[Math.floor(until / 1440)]} ${clock}` : clock;
  return t(open ? "openUntil" : "closedUntil").replace("{time}", time);
}

/** "on the way", "+4 min"; "…" while it is worked out. */
export function detourText(detourS: number | null | undefined, t: T): string {
  if (detourS === undefined) return t("alongCounting");
  if (detourS === null) return t("detourNone");
  const n = detourMinutes(detourS);
  return n === 0 ? t("alongOnTheWay") : t("alongDetour").replace("{n}", String(n));
}
