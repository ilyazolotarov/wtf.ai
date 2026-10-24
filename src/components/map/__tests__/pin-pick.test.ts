import { nearestStreet, pinLevel } from "@/components/map/pin-pick";

describe("dropped pin", () => {
  test("names a building or street where the map draws buildings (z13), the settlement down to z9, then nothing", () => {
    expect([18, 13, 12.9, 9, 8.9].map(pinLevel)).toEqual(["building", "building", "settlement", "settlement", null]);
  });

  test("of the streets under the finger, the named one whose line passes nearest", () => {
    const at = { lat: 50.45, lon: 30.52 };
    const line = (name: string | undefined, dLat: number, extra: Record<string, string> = {}): GeoJSON.Feature => ({
      type: "Feature",
      properties: { ...(name ? { name } : {}), ...extra },
      geometry: { type: "LineString", coordinates: [[30.519, 50.45 + dLat], [30.521, 50.45 + dLat]] },
    });
    const street = nearestStreet(
      [line("вулиця Далека", 0.0004), line("вулиця Близька", 0.0001, { name_en: "Blyzka Street" }), line(undefined, 0)],
      at,
    );
    expect(street).toEqual({ name: "вулиця Близька", nameEn: "Blyzka Street" });
    expect(nearestStreet([], at)).toBeNull();
  });
});
