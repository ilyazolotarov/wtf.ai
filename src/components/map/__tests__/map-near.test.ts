import type { SearchIndex } from "@/nav/search/search-index";

import { NEAR_FADE_M, NEAR_NUMBERS_M, NEAR_STEP_M, nearFilter, nearHouses, nearOpacity, nearPoint } from "../map-near";

const CAR = { lat: 50.45, lon: 30.52 };
/** About `m` metres north of the car. */
const north = (m: number) => ({ lat: CAR.lat + m / 111_195, lon: CAR.lon });

describe("the near area in heading-up", () => {
  test("follows the car only once it has moved on a step", () => {
    expect(nearPoint(null, CAR)).toEqual(CAR);
    expect(nearPoint(CAR, north(NEAR_STEP_M - 5))).toBe(CAR);
    expect(nearPoint(CAR, north(NEAR_STEP_M + 5))).toEqual(north(NEAR_STEP_M + 5));
    expect(nearPoint(CAR, null)).toBeNull();
  });

  test("filters by distance from the point and the fade beyond, keeping the layer's own filter", () => {
    const point = { type: "Point", coordinates: [CAR.lon, CAR.lat] };
    const cut = 250 + NEAR_FADE_M;
    expect(nearFilter(CAR, 250)).toEqual(["<", ["distance", point], cut]);
    expect(nearFilter(CAR, 250, ["==", ["get", "r"], ""])).toEqual(["all", ["==", ["get", "r"], ""], ["<", ["distance", point], cut]]);
  });

  test("what matches `always` stays wherever it is, in full", () => {
    const point = { type: "Point", coordinates: [CAR.lon, CAR.lat] };
    const fuel = ["==", ["get", "class"], "fuel"];
    const fade = ["interpolate", ["linear"], ["distance", point], 250, 1, 250 + NEAR_FADE_M, 0];
    expect(nearFilter(CAR, 250, ["has", "name"], fuel)).toEqual(["all", ["has", "name"], ["any", fuel, ["<", ["distance", point], 250 + NEAR_FADE_M]]]);
    expect(nearFilter(null, 250, ["has", "name"], fuel)).toEqual(["has", "name"]);
    expect(nearOpacity(CAR, 250)).toEqual(fade);
    expect(nearOpacity(CAR, 250, fuel)).toEqual(["case", fuel, 1, fade]);
    expect(nearOpacity(null, 250, fuel)).toBe(1);
  });

  test("without a point nothing is cut", () => {
    expect(nearFilter(null, 250)).toEqual(["all"]);
    expect(nearFilter(null, 250, ["==", ["get", "r"], ""])).toEqual(["==", ["get", "r"], ""]);
  });
});

describe("house numbers near the car", () => {
  test("a point a house from the search file, none without a point or a file", () => {
    const index = { housesNear: jest.fn(() => [{ house: "12", lat: CAR.lat, lon: CAR.lon }]) };
    const fc = nearHouses(index as unknown as SearchIndex, CAR);
    expect(index.housesNear).toHaveBeenCalledWith(CAR, NEAR_NUMBERS_M + NEAR_FADE_M);
    expect(fc?.features).toEqual([{ type: "Feature", geometry: { type: "Point", coordinates: [CAR.lon, CAR.lat] }, properties: { n: "12", o: 1 } }]);
    expect(nearHouses(index as unknown as SearchIndex, null)).toBeNull();
    expect(nearHouses(null, CAR)).toBeNull();
  });

  test("past the near distance a number fades out", () => {
    const at = (m: number) => {
      const index = { housesNear: () => [{ house: "1", ...north(m) }] };
      return (nearHouses(index as unknown as SearchIndex, CAR)?.features[0] as { properties: { o: number } }).properties.o;
    };
    expect(at(NEAR_NUMBERS_M - 10)).toBe(1);
    expect(at(NEAR_NUMBERS_M + NEAR_FADE_M / 2)).toBeCloseTo(0.5, 1);
    expect(at(NEAR_NUMBERS_M + NEAR_FADE_M)).toBeCloseTo(0, 1);
  });
});
