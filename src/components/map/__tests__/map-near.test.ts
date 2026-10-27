import type { SearchIndex } from "@/nav/search/search-index";

import { NEAR_NUMBERS_M, NEAR_STEP_M, nearFilter, nearHouses, nearPoint } from "../map-near";

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

  test("filters by distance from the point, keeping the layer's own filter", () => {
    const point = { type: "Point", coordinates: [CAR.lon, CAR.lat] };
    expect(nearFilter(CAR, 250)).toEqual(["<", ["distance", point], 250]);
    expect(nearFilter(CAR, 250, ["==", ["get", "r"], ""])).toEqual(["all", ["==", ["get", "r"], ""], ["<", ["distance", point], 250]]);
  });

  test("what matches `always` stays wherever it is", () => {
    const point = { type: "Point", coordinates: [CAR.lon, CAR.lat] };
    const fuel = ["==", ["get", "class"], "fuel"];
    expect(nearFilter(CAR, 250, ["has", "name"], fuel)).toEqual(["all", ["has", "name"], ["any", fuel, ["<", ["distance", point], 250]]]);
    expect(nearFilter(null, 250, ["has", "name"], fuel)).toEqual(["has", "name"]);
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
    expect(index.housesNear).toHaveBeenCalledWith(CAR, NEAR_NUMBERS_M);
    expect(fc?.features).toEqual([{ type: "Feature", geometry: { type: "Point", coordinates: [CAR.lon, CAR.lat] }, properties: { n: "12" } }]);
    expect(nearHouses(index as unknown as SearchIndex, null)).toBeNull();
    expect(nearHouses(null, CAR)).toBeNull();
  });
});
