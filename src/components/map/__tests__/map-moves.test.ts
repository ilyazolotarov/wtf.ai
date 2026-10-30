import { fittedPadding, FOLLOW_ZOOM_SHIFT, FRAME_MAX_ZOOM, framedCamera, pannedCenter, shiftedFollowZoom, zoomedCenter } from "../map-moves";

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

  test("framing a route fits its wider side between the panels, centred in Mercator; a point at most FRAME_MAX_ZOOM", () => {
    const none = { top: 0, bottom: 0, left: 0, right: 0 };
    // The whole world's width across 512 points is zoom 0; 1/1024 of it across 512 points is zoom 10.
    expect(framedCamera([-180, -10, 180, 10], none, 512, 2000).zoom).toBeCloseTo(0, 9);
    const box: [number, number, number, number] = [30, 50, 30 + 360 / 1024, 50.0001];
    expect(framedCamera(box, none, 512, 2000).zoom).toBeCloseTo(10, 9);
    // Panels take 256 of the 512 points: one zoom level out.
    expect(framedCamera(box, { top: 0, bottom: 0, left: 200, right: 56 }, 512, 2000).zoom).toBeCloseTo(9, 9);
    // A tall box is fitted by its height; the centre is the Mercator middle, north of the latitudes' mean.
    const tall = framedCamera([30, 45, 30.001, 55], none, 1000, 400);
    expect(tall.center.lat).toBeGreaterThan(50);
    expect(tall.center.lon).toBeCloseTo(30.0005, 9);
    expect(tall.zoom).toBeLessThan(framedCamera([30, 45, 30.001, 46], none, 1000, 400).zoom);
    // The ghost on the position: one point, shown close in.
    expect(framedCamera([30.52, 50.45, 30.52, 50.45], none, 390, 844)).toEqual({ center: { lat: expect.closeTo(50.45, 9), lon: 30.52 }, zoom: FRAME_MAX_ZOOM });
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
