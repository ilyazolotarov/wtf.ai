import type { Strings } from "@/i18n/en";
import type { SearchResult } from "@/nav/search/search-index";

type T = (key: keyof Strings) => string;

const PLACE_KEYS: Record<string, keyof Strings> = {
  "place=city": "placeCity",
  "place=town": "placeTown",
  "place=village": "placeVillage",
  "place=hamlet": "placeVillage",
  "place=suburb": "placeArea",
  "place=quarter": "placeArea",
  "place=neighbourhood": "placeArea",
  "place=isolated_dwelling": "placeArea",
  "place=locality": "placeArea",
};

const POI_KEYS: Record<string, keyof Strings> = {
  "amenity=fuel": "poiFuel",
  "amenity=charging_station": "poiCharging",
  "amenity=parking": "poiParking",
  "amenity=cafe": "poiCafe",
  "amenity=restaurant": "poiRestaurant",
  "amenity=fast_food": "poiRestaurant",
  "amenity=pharmacy": "poiPharmacy",
  "amenity=hospital": "poiHospital",
  "amenity=clinic": "poiHospital",
  "amenity=school": "poiSchool",
  "amenity=bank": "poiBank",
  "shop=supermarket": "poiShop",
  "shop=convenience": "poiShop",
  "shop=mall": "poiShop",
  "shop=car_repair": "poiCarService",
  "amenity=car_wash": "poiCarService",
  "tourism=hotel": "poiHotel",
  "railway=station": "poiStation",
  "railway=halt": "poiStation",
  "aeroway=aerodrome": "poiAirport",
};

const localName = (r: { name: string; nameEn: string | null }, language: "en" | "uk") =>
  language === "en" && r.nameEn ? r.nameEn : r.name;

/** "вулиця Шевченка, 10", "Сільпо", "Чернігів". */
export function resultTitle(r: SearchResult, language: "en" | "uk"): string {
  const name = localName(r, language);
  return r.house ? `${name}, ${r.house}` : name;
}

/** What it is and where: "Village", "Chernihiv", "Fuel · Chernihiv". */
export function resultDetail(r: SearchResult, language: "en" | "uk", t: T): string {
  const settlement = r.settlement ? localName(r.settlement, language) : null;
  if (r.kind === "place") {
    const kind = t(PLACE_KEYS[r.tag] ?? "placeArea");
    return settlement ? `${kind} · ${settlement}` : kind;
  }
  if (r.kind === "poi") {
    const key = POI_KEYS[r.tag];
    const kind = key ? t(key) : (r.tag.split("=")[1] ?? "").replace(/_/g, " ");
    return [kind, settlement].filter(Boolean).join(" · ");
  }
  return settlement ?? t(r.kind === "address" ? "searchAddress" : "searchStreet");
}
