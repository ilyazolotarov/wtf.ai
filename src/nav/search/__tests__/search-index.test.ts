import { readFileSync } from "node:fs";
import path from "node:path";

import { bufferByteSource } from "@/nav/mapmatch/graph/byte-source";
import { fold, foldHouse, parseQuery } from "@/nav/search/fold";
import { SearchIndex, type SearchResult } from "@/nav/search/search-index";

import foldCases from "../__fixtures__/fold-cases.json";

// town.search.bin is written by tools/tiles (tests/test_search.py): Chernihiv (city), Ivanivka
// (village ~12 km south-west), "вулиця Шевченка" in both, "проспект Миру" (old name проспект
// Леніна), the address-only "вулиця Нова", an `addr:place` house in the village, WOG and Сільпо.
const FIXTURE = readFileSync(path.join(__dirname, "../__fixtures__/town.search.bin"));
const CITY = { lat: 51.4939, lon: 31.2947 };
const VILLAGE = { lat: 51.41, lon: 31.15 };

const open = () => new SearchIndex(bufferByteSource(new Uint8Array(FIXTURE)));
const label = (r: SearchResult) =>
  `${r.kind}:${r.name}${r.house ? ` ${r.house}` : ""}${r.settlement ? ` @${r.settlement.name}` : ""}`;
const search = (q: string, near: { lat: number; lon: number } | null = CITY) =>
  open().search(q, { near }).map(label);

describe("fold", () => {
  it("matches the index builder (shared cases)", () => {
    for (const [text, tokens] of foldCases.tokens as [string, string[]][]) expect([text, fold(text)]).toEqual([text, tokens]);
    for (const [text, house] of foldCases.houses as [string, string][]) expect([text, foldHouse(text)]).toEqual([text, house]);
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
