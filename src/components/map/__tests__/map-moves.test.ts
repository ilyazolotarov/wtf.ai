import { fittedPadding, FOLLOW_ZOOM_SHIFT, pannedCenter, shiftedFollowZoom, zoomedCenter } from "../map-moves";

const KYIV = { lat: 50.45, lon: 30.52 };

describe("map moves", () => {
  test("framing keeps 40 % of the map for what it frames, the panels' room shrunk alike when they take more", () => {
    const phone = { top: 120, bottom: 200, left: 24, right: 24 };
    expect(fittedPadding(phone, 390, 844)).toEqual(phone);
    // CarPlay's 400×240 screen with its guidance card on the left and buttons on the right.
    const car = fittedPadding({ top: 72, bottom: 32, left: 262, right: 92 }, 400, 240);
    expect(car.left + car.right).toBeCloseTo(240, 9);
    expect(car.left / car.right).toBeCloseTo(262 / 92, 9);
    expect(car.top).toBe(72);
    // Before the map is laid out: as asked.
    expect(fittedPadding(phone, 0, 0)).toEqual(phone);
  });

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
