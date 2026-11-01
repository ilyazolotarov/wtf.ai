import { entranceArea, entranceFeatures, type Box } from "../map-entrances";
import type { SearchIndex } from "@/nav/search/search-index";

// A phone's view at z16 in Kyiv: about 600 m by 1.3 km.
const view: Box = [30.52, 50.445, 30.5285, 50.457];

describe("entranceArea", () => {
  it("cuts the view grown by half its size on each side, and keeps it while it holds the view", () => {
    const area = entranceArea(null, view, 16)!;
    expect(area[0]).toBeCloseTo(30.52 - 0.00425, 6);
    expect(area[3]).toBeCloseTo(50.457 + 0.006, 6);
    // Moved less than the margin: the same object, so the map's state doesn't change.
    const nudged: Box = [view[0] + 0.003, view[1] + 0.004, view[2] + 0.003, view[3] + 0.004];
    expect(entranceArea(area, nudged, 16.5)).toBe(area);
    // Moved past it: a new area around the new view.
    const moved: Box = [view[0] + 0.01, view[1], view[2] + 0.01, view[3]];
    const next = entranceArea(area, moved, 16)!;
    expect(next).not.toBe(area);
    expect(next[0]).toBeLessThan(moved[0]);
    expect(next[2]).toBeGreaterThan(moved[2]);
  });

  it("isn't cut zoomed out past where the entrances show, nor from a broken view", () => {
    expect(entranceArea(null, view, 13)).toBeNull();
    const area = entranceArea(null, view, 16);
    expect(entranceArea(area, [0, 0, 60, 60], 12)).toBe(area);
    expect(entranceArea(area, null, 16)).toBe(area);
    expect(entranceArea(area, [NaN, 0, 1, 1], 16)).toBe(area);
  });

  it("counts a far-reaching tilted view as about 3 km about its middle", () => {
    const tilted: Box = [30.3, 50.3, 30.8, 50.6];
    const area = entranceArea(null, tilted, 16)!;
    expect(area[3] - area[1]).toBeCloseTo(0.03 * 2, 6);
    // The same view again: held, not cut on every camera frame.
    expect(entranceArea(area, tilted, 16)).toBe(area);
  });
});

describe("entranceFeatures", () => {
  it("asks the search file for the area's entrances, a number or \"\" each", () => {
    const entrancesIn = jest.fn(() => [
      { ref: "3", lat: 50.45, lon: 30.52 },
      { ref: null, lat: 50.451, lon: 30.521 },
    ]);
    const index = { entrancesIn } as unknown as SearchIndex;
    const area: Box = [30.5, 50.4, 30.6, 50.5];
    expect(entranceFeatures(index, area)).toEqual({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "Point", coordinates: [30.52, 50.45] }, properties: { r: "3" } },
        { type: "Feature", geometry: { type: "Point", coordinates: [30.521, 50.451] }, properties: { r: "" } },
      ],
    });
    expect(entrancesIn).toHaveBeenCalledWith(30.5, 50.4, 30.6, 50.5);
    expect(entranceFeatures(null, area)).toBeNull();
    expect(entranceFeatures(index, null)).toBeNull();
  });
});
