import { FOLLOW_ZOOM_SHIFT, pannedCenter, shiftedFollowZoom, zoomedCenter } from "../map-moves";

const KYIV = { lat: 50.45, lon: 30.52 };

describe("map moves", () => {
  test("a drag shifts the centre as it shifted the ground under the finger", () => {
    const from = { lat: 50.451, lon: 30.523 };
    const to = { lat: 50.452, lon: 30.521 };
    const c = pannedCenter(KYIV, from, to);
    expect(c.lon).toBeCloseTo(30.518, 9);
    expect(c.lat).toBeCloseTo(50.451, 4);
  });

  test("zooming in about a point keeps that point where it is and halves the rest's distance", () => {
    const focus = { lat: 50.46, lon: 30.54 };
    const c = zoomedCenter(KYIV, focus, 2);
    expect(c.lon).toBeCloseTo(30.53, 9);
    expect(c.lat).toBeCloseTo(50.455, 3);
    // Zoomed back out, the centre returns.
    const back = zoomedCenter(c, focus, 0.5);
    expect(back.lat).toBeCloseTo(KYIV.lat, 9);
    expect(back.lon).toBeCloseTo(KYIV.lon, 9);
  });

  test("without a focus the centre stays", () => {
    expect(zoomedCenter(KYIV, null, 2)).toEqual(KYIV);
  });

  test("the follow zoom moves within its bounds", () => {
    expect(shiftedFollowZoom(0, 1)).toBe(1);
    expect(shiftedFollowZoom(FOLLOW_ZOOM_SHIFT.max, 1)).toBe(FOLLOW_ZOOM_SHIFT.max);
    expect(shiftedFollowZoom(-3.5, -1)).toBe(FOLLOW_ZOOM_SHIFT.min);
  });
});
