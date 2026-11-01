// How stops and places along the route read (STOPS-SPEC §7): a kind's icon and word, a place's name or its kind,
// what the search file knows of it ("right · diesel, 95, LPG · 24/7"), a detour's minutes.

import type { IconName } from "@/components/ui/icon";
import type { Strings } from "@/i18n/en";
import { detourMinutes } from "@/nav/routing/detour";
import type { RoadSide } from "@/nav/routing/router";
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

/** The side of the road, the fuels sold and 24/7, as far as the map knows them. */
export function placeDetail(p: Pick<StopPlace, "flags" | "category">, side: RoadSide | null, t: T): string {
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
  return parts.join(" · ");
}

/** "on the way", "+4 min"; "…" while it is worked out. */
export function detourText(detourS: number | null | undefined, t: T): string {
  if (detourS === undefined) return t("alongCounting");
  if (detourS === null) return t("detourNone");
  const n = detourMinutes(detourS);
  return n === 0 ? t("alongOnTheWay") : t("alongDetour").replace("{n}", String(n));
}
