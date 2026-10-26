import { readFileSync } from "node:fs";
import path from "node:path";

import { bufferByteSource } from "@/nav/mapmatch/graph/byte-source";
import { fold, foldHouse, parseQuery, splitEntrance } from "@/nav/search/fold";
import { SearchIndex, typoBudget, withoutRepeats, type SearchResult } from "@/nav/search/search-index";

import foldCases from "../__fixtures__/fold-cases.json";

// town.search.bin is written by tools/tiles (tests/test_search.py): Chernihiv (city), Ivanivka
// (village ~12 km south-west), "вулиця Шевченка" in both, "проспект Миру" (old name проспект
// Леніна), the address-only "вулиця Нова", an `addr:place` house in the village, WOG and Сільпо;
// Шевченка 1 has entrances 1 and 2 (and a garage door, left out), and one entrance of no address stands apart;
// Шевченка 10 is mapped four times side by side.
const FIXTURE = readFileSync(path.join(__dirname, "../__fixtures__/town.search.bin"));
const CITY = { lat: 51.4939, lon: 31.2947 };
const VILLAGE = { lat: 51.41, lon: 31.15 };

const AREAS = readFileSync(path.join(__dirname, "../__fixtures__/areas.search.bin"));
/** A point dx km east and dy km north of the city's point (as the fixture is drawn). */
const km = (dx: number, dy: number) => ({ lat: CITY.lat + dy / 111.32, lon: CITY.lon + dx / (111.32 * 0.6225) });

const open = () => new SearchIndex(bufferByteSource(new Uint8Array(FIXTURE)));
const label = (r: SearchResult) =>
  `${r.kind}:${r.name}${r.house ? ` ${r.house}` : ""}${r.entrance ? ` entrance ${r.entrance}` : ""}${r.settlement ? ` @${r.settlement.name}` : ""}`;
const search = (q: string, near: { lat: number; lon: number } | null = CITY) =>
  open().search(q, { near }).map(label);

describe("fold", () => {
  it("matches the index builder (shared cases)", () => {
    for (const [text, tokens] of foldCases.tokens as [string, string[]][]) expect([text, fold(text)]).toEqual([text, tokens]);
    for (const [text, house] of foldCases.houses as [string, string][]) expect([text, foldHouse(text)]).toEqual([text, house]);
  });

  it("reads an entrance at the end of a query only after a house number", () => {
    expect(splitEntrance("Оболонський 16 під'їзд 3")).toEqual({ rest: "Оболонський 16", entrance: "3" });
    expect(splitEntrance("Оболонський 16-А, п. 12")).toEqual({ rest: "Оболонський 16-А,", entrance: "12" });
    expect(splitEntrance("8 Березня п 3")).toEqual({ rest: "8 Березня", entrance: "3" });
    expect(splitEntrance("Пирогова п 3")).toEqual({ rest: "Пирогова п 3", entrance: null });
    expect(splitEntrance("Оболонський 16 під")).toEqual({ rest: "Оболонський 16 ", entrance: null });
    expect(splitEntrance("Підвальна")).toEqual({ rest: "Підвальна", entrance: null });
    expect(splitEntrance("Оболонський проспект 16 3 під'їзд")).toEqual({ rest: "Оболонський проспект 16", entrance: "3" });
    expect(splitEntrance("Оболонський 16 3-й під'їзд")).toEqual({ rest: "Оболонський 16", entrance: "3" });
    expect(splitEntrance("Оболонський проспект 16 3")).toEqual({ rest: "Оболонський проспект 16", entrance: "3" });
    expect(splitEntrance("Оболонський 16-А, 3")).toEqual({ rest: "Оболонський 16-А", entrance: "3" });
    expect(splitEntrance("8 Березня 3")).toEqual({ rest: "8 Березня 3", entrance: null });
    expect(splitEntrance("Оболонский 16 подъезд 3").entrance).toBe("3");
    expect(splitEntrance("Оболонский 16 подезд 3").entrance).toBe("3");
    expect(splitEntrance("Оболонский 16 подьезд 3").entrance).toBe("3");
  });

  it("parses a house number and the word being typed", () => {
    const q = parseQuery("вул. Шевченка 10");
    expect(q.house).toBe("10");
    expect(q.tokens.map((t) => [t.text, t.optional, t.prefix, t.house])).toEqual([
      ["vul", true, false, false],
      ["shevchenka", false, false, false],
      ["10", false, true, true],
    ]);
    expect(parseQuery("Шевч").tokens[0]).toMatchObject({ text: "shevch", prefix: true });
    expect(parseQuery("Шевченка ").tokens[0].prefix).toBe(false);
    expect(parseQuery("вули").tokens[0].optional).toBe(true); // "вулиця" being typed
    expect(parseQuery("10").house).toBeNull(); // a number alone isn't an address
    expect(parseQuery("Шевченка 12/2-А").house).toBe("12/2a");
  });
});

describe("SearchIndex", () => {
  it("reads the header", () => {
    const index = open();
    expect(index.header.osmDate).toBe("2026-10-01");
    expect(index.header.settlements).toBe(2);
  });

  it("lists the region's cities and towns, largest first", () => {
    // The village isn't a major settlement.
    expect(open().majorSettlements().map(label)).toEqual(["place:Чернігів"]);
    expect(open().majorSettlements(0)).toEqual([]);
  });

  it("finds a city by name in either script, while typing", () => {
    expect(search("Чернігів")[0]).toBe("place:Чернігів");
    expect(search("cherniHIV")[0]).toBe("place:Чернігів");
    expect(search("черні")[0]).toBe("place:Чернігів");
  });

  it("ranks the nearer of two same-named streets first", () => {
    expect(search("Шевченка", CITY).slice(0, 2)).toEqual([
      "street:вулиця Шевченка @Чернігів",
      "street:вулиця Шевченка @Іванівка",
    ]);
    expect(search("Шевченка", VILLAGE)[0]).toBe("street:вулиця Шевченка @Іванівка");
  });

  it("narrows a street by its settlement's name", () => {
    const r = search("Шевченка Іванівка", CITY);
    expect(r[0]).toBe("street:вулиця Шевченка @Іванівка");
    expect(r).not.toContain("street:вулиця Шевченка @Чернігів");
  });

  it("finds a house: the exact number first, then numbers it starts", () => {
    const r = search("вул. Шевченка 10, Чернігів");
    expect(r.slice(0, 3)).toEqual([
      "address:вулиця Шевченка 10 @Чернігів",
      "address:вулиця Шевченка 10А @Чернігів",
      "street:вулиця Шевченка @Чернігів",
    ]);
    expect(r).not.toContain("address:вулиця Шевченка 10 @Іванівка");
    expect(search("Шевченка 10а")[0]).toBe("address:вулиця Шевченка 10А @Чернігів");
    expect(search("Шевченка 10", VILLAGE)[0]).toBe("address:вулиця Шевченка 10 @Іванівка");
    expect(search("shevchenka 12/2")[0]).toBe("address:вулиця Шевченка 12/2 @Чернігів");
  });

  it("gives a house its numbered entrances for its card, and finds the one typed", () => {
    // Not listed as results of their own: the card offers them.
    expect(search("Шевченка 1").filter((r) => r.includes("entrance"))).toEqual([]);
    const [house] = open().search("Шевченка 1", { near: CITY });
    expect(house).toMatchObject({ house: "1", entrance: null });
    expect(house.entrances.map((e) => e.ref)).toEqual(["1", "2"]);
    for (const q of ["Шевченка 1 під'їзд 2", "Шевченка 1, п. 2", "shevchenka 1 entrance 2", "Шевченка 1 п2", "Шевченка 1 2 під'їзд", "Шевченка 1 2"]) {
      expect([q, search(q)[0]]).toEqual([q, "address:вулиця Шевченка 1 entrance 2 @Чернігів"]);
    }
    // The entrance word being typed: the house and its entrances meanwhile.
    expect(search("Шевченка 1 під")[0]).toBe("address:вулиця Шевченка 1 @Чернігів");
    const [door] = open().search("Шевченка 1 під'їзд 1", { near: CITY });
    expect(door).toMatchObject({ house: "1", entrance: "1" });
    expect(door.lat).toBeCloseTo(51.4939 + 0.0012, 5); // at the door, not the building's centre
    expect(door.lon).toBeCloseTo(31.2947 + 0.0012, 5);
  });

  it("names the address nearest a dropped pin, and nothing away from houses", () => {
    const index = open();
    // On the building of Шевченка 1 (its centre is 0.0011° E, 0.0013° N of the city's point).
    const house = index.nearestAddress({ lat: 51.4939 + 0.00125, lon: 31.2947 + 0.00105 });
    expect(house && label(house)).toBe("address:вулиця Шевченка 1 @Чернігів");
    expect(house?.entrances.map((e) => e.ref)).toEqual(["1", "2"]);
    // A village house addressed by its place.
    const village = index.nearestAddress({ lat: 51.41 - 0.0005, lon: 31.15 + 0.0005 });
    expect(village && label(village)).toBe("address:Іванівка 5");
    expect(index.nearestAddress({ lat: 51.4939 + 0.02, lon: 31.2947 + 0.02 })).toBeNull();
    // …but the settlement it is in: the city's reach is 15 km, the village's 2.5 km.
    expect(index.settlementAt({ lat: 51.4939 + 0.02, lon: 31.2947 + 0.02 })?.name).toBe("Чернігів");
    expect(index.settlementAt({ lat: 51.41 + 0.005, lon: 31.15 })?.name).toBe("Іванівка");
    expect(index.settlementAt({ lat: 52.5, lon: 33.5 })).toBeNull();
  });

  it("labels a street by the settlement whose area holds it, and finds a pin's house there past the kind's reach", () => {
    // areas.search.bin (tests/test_search.py, test_settlement_from_the_area_around_it): two "вулиця Садова",
    // each in a village's boundary but nearer another settlement's point. House 7-А is 3.7 km from its village's
    // point (a village reaches 2.5 km by its kind) and 3 km from a town's.
    const index = new SearchIndex(bufferByteSource(new Uint8Array(AREAS)));
    expect(index.search("Садова", { near: null }).map(label).sort()).toEqual([
      "street:вулиця Садова @Петрівка",
      "street:вулиця Садова @Степове",
    ]);
    const house = index.nearestAddress(km(0.1, 3.05));
    expect(house && label(house)).toBe("address:вулиця Садова 7-А @Петрівка");
    // 150 m from it no address, but the settlement is the house's, not the town 3 km away; far from houses, by kind.
    expect(index.nearestAddress(km(0.1, 3.2))).toBeNull();
    expect(index.settlementAt(km(0.1, 3.2))?.name).toBe("Петрівка");
    expect(index.settlementAt(km(2, -1))?.name).toBe("Залісся");
  });

  it("reads the region's entrances for the map, numbered or not", () => {
    const all = open().allEntrances();
    expect(all.map((e) => e.ref)).toEqual(["1", "2", null]);
  });

  it("counts a number mapped several times nearby once, so other numbers still fit", () => {
    // "10" four times: before, its copies took four of a street's five places and 10А, 12/2 were left out.
    expect(search("Шевченка 1").slice(0, 4)).toEqual([
      "address:вулиця Шевченка 1 @Чернігів",
      "address:вулиця Шевченка 10 @Чернігів",
      "address:вулиця Шевченка 10А @Чернігів",
      "address:вулиця Шевченка 12/2 @Чернігів",
    ]);
  });

  it("puts an address at its house, not at its street's middle", () => {
    const [house] = open().search("Шевченка 1 ", { near: CITY });
    expect(house).toMatchObject({ kind: "address", house: "1" });
    expect(house.lat).toBeCloseTo(51.4939 + 0.0013, 4); // the building's centroid
    expect(house.lon).toBeCloseTo(31.2947 + 0.0011, 4);
  });

  it("knows streets only from their houses, and village houses without a street", () => {
    expect(search("Нова 5")[0]).toBe("address:вулиця Нова 5 @Чернігів");
    expect(search("Іванівка 5")[0]).toBe("address:Іванівка 5");
  });

  it("matches English, old and alternative names", () => {
    expect(search("Myru avenue")[0]).toBe("street:проспект Миру @Чернігів");
    expect(search("проспект Леніна")[0]).toBe("street:проспект Миру @Чернігів");
    expect(search("Shevchenka Street")[0]).toBe("street:вулиця Шевченка @Чернігів");
  });

  it("finds POIs with their settlement", () => {
    const [silpo] = open().search("silpo", { near: CITY });
    expect(label(silpo)).toBe("poi:Сільпо @Чернігів");
    expect(silpo.tag).toBe("shop=supermarket");
    expect(silpo.nameEn).toBe("Silpo");
    expect(search("WOG")[0]).toBe("poi:WOG @Чернігів");
  });

  it("forgives typos: a letter missed, doubled, wrong or two swapped", () => {
    expect(search("Шевчнко")[0]).toBe("street:вулиця Шевченка @Чернігів"); // missed
    expect(search("Шевчекна 10, Чернігів")[0]).toBe("address:вулиця Шевченка 10 @Чернігів"); // swapped
    expect(search("Шеввченка Іванівка")[0]).toBe("street:вулиця Шевченка @Іванівка"); // doubled
    expect(search("Шевченка Іванівко")[0]).toBe("street:вулиця Шевченка @Іванівка"); // wrong, in the settlement
    expect(search("Чернигів")[0]).toBe("place:Чернігів");
    // While typing: a word that starts within a typo of what's typed.
    expect(search("Шевчнк")[0]).toBe("street:вулиця Шевченка @Чернігів");
    expect(search("Шевчнко Чернигів")[0]).toBe("street:вулиця Шевченка @Чернігів"); // a typo in each word
  });

  it("ranks an exact match above a typo, and forgives no typo in a short word or a number", () => {
    // "Шевченка" in the village is spelled right; "Шевченко" in the city would be a typo of it.
    expect(open().search("Шевченка", { near: CITY })[0].score).toBeGreaterThan(open().search("Шевченко", { near: CITY })[0].score);
    expect(typoBudget(parseQuery("Мир ").tokens[0])).toBe(0);
    expect(typoBudget(parseQuery("Миру ").tokens[0])).toBe(1);
    expect(typoBudget(parseQuery("Миру").tokens[0])).toBe(0); // being typed
    expect(typoBudget(parseQuery("Шевченка ").tokens[0])).toBe(2);
    expect(typoBudget(parseQuery("12345 ").tokens[0])).toBe(0);
    expect(search("Нва")).toEqual([]);
  });

  it("returns nothing for street kinds alone, single letters or unknown words", () => {
    expect(search("вулиця")).toEqual([]);
    expect(search("вули")).toEqual([]);
    expect(search("ш")).toEqual([]);
    expect(search("Хрещатик")).toEqual([]);
    expect(search("")).toEqual([]);
  });

  it("keeps the matching words of a settlement from matching all its streets", () => {
    // "Чернігів" alone: the city, not every street in it.
    expect(search("Чернігів").filter((r) => r.startsWith("street:"))).toEqual([]);
  });
});

describe("withoutRepeats", () => {
  const address = (key: string, lat: number, lon: number, score: number): SearchResult => ({
    key,
    kind: "address",
    name: "вулиця Хрещатик",
    nameEn: "Khreshchatyk Street",
    house: "22",
    entrance: null,
    entrances: [],
    tag: "addr:street",
    settlement: { name: "Київ", nameEn: "Kyiv" },
    lat,
    lon,
    score,
  });

  it("keeps the best of one address mapped several times, and the same address elsewhere", () => {
    // The building and its entrances, ~60 m apart (Kyiv, OSM 2026-10-12); a namesake 2 km away stays.
    const ranked = [
      address("a1", 50.44927, 30.52257, 30.7),
      address("a2", 50.44979, 30.52277, 30.6),
      address("a3", 50.44991, 30.52316, 30.6),
      address("a4", 50.4699, 30.5228, 20),
    ];
    expect(withoutRepeats(ranked).map((r) => r.key)).toEqual(["a1", "a4"]);
  });

  it("keeps different houses and kinds at the same spot", () => {
    const street: SearchResult = { ...address("e1", 50.44927, 30.52257, 14), kind: "street", house: null };
    const next = { ...address("a2", 50.44927, 30.52257, 29), house: "24" };
    expect(withoutRepeats([address("a1", 50.44927, 30.52257, 30), next, street]).map((r) => r.key)).toEqual(["a1", "a2", "e1"]);
  });
});
