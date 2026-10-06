import { adviseRegion, regionContains, smallestRegionAt, type RegionShape } from "@/services/offline-map/region-check";

// Two neighbouring "oblasts" whose bounds overlap: an L-shaped west one and a square east one,
// and "ukraine" around both.
const west: RegionShape = {
  region: "west",
  bounds: [30, 50, 32, 52],
  outline: [[[30, 50], [32, 50], [32, 51], [31, 51], [31, 52], [30, 52], [30, 50]]],
};
const east: RegionShape = {
  region: "east",
  bounds: [31, 51, 33, 52],
  outline: [[[31, 51], [33, 51], [33, 52], [31, 52], [31, 51]]],
};
const ukraine: RegionShape = { region: "ukraine", bounds: [22, 44, 41, 53] }; // bounds only
const IN_WEST = { lat: 50.5, lon: 31.5 };
const IN_EAST = { lat: 51.5, lon: 31.5 }; // inside west's bounds, outside its outline
const JUST_OUT = { lat: 51.505, lon: 30.995 + 0.005 + 0.004 }; // ~280 m east of west's notch edge

describe("region check", () => {
  it("uses the outline, not the overlapping bounds", () => {
    expect(regionContains(west, IN_WEST)).toBe(true);
    expect(regionContains(west, IN_EAST)).toBe(false);
    expect(regionContains(east, IN_EAST)).toBe(true);
  });

  it("falls back to bounds without an outline, and counts the margin as inside", () => {
    expect(regionContains(ukraine, IN_EAST)).toBe(true);
    expect(regionContains(ukraine, { lat: 54, lon: 30 })).toBe(false);
    expect(regionContains(west, JUST_OUT)).toBe(false);
    expect(regionContains(west, JUST_OUT, 1_000)).toBe(true);
    expect(regionContains(west, { lat: 49.995, lon: 31 }, 1_000)).toBe(true); // 560 m south of the bounds
  });

  it("picks the smallest region that has the point", () => {
    expect(smallestRegionAt([ukraine, west, east], IN_EAST)?.region).toBe("east");
    expect(smallestRegionAt([ukraine, west], IN_EAST)?.region).toBe("ukraine");
    expect(smallestRegionAt([west, east], { lat: 47, lon: 35 })).toBeNull();
  });

  it("advises: nothing inside; switch to a downloaded region; else download one", () => {
    expect(adviseRegion(west, [west], [ukraine, west, east], IN_WEST)).toEqual({ kind: "inside" });
    expect(adviseRegion(west, [west, ukraine], [ukraine, west, east], IN_EAST)).toEqual({ kind: "switch", region: ukraine });
    expect(adviseRegion(west, [west], [ukraine, west, east], IN_EAST)).toEqual({ kind: "download", region: east });
    expect(adviseRegion(west, [west], [], IN_EAST)).toEqual({ kind: "outside" });
    expect(adviseRegion(west, [west], [west, east], { lat: 47, lon: 35 })).toEqual({ kind: "outside" });
  });
});
