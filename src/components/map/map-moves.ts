// The map moved by gestures the map view doesn't see itself (the car's screen, ANDROID-AUTO-SPEC §4): a drag's
// shift, a pinch about a point, the zoom buttons. Pure camera arithmetic in Web Mercator, where the map is linear.

import type { Coordinate } from "@/nav/geo";

const mercatorY = (latDeg: number) => Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI) / 360));
const latOf = (y: number) => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90;

/** The camera's centre moved as far as from `from` to `to` (the ground under two screen points a drag apart). */
export function pannedCenter(center: Coordinate, from: Coordinate, to: Coordinate): Coordinate {
  return { lat: latOf(mercatorY(center.lat) + mercatorY(to.lat) - mercatorY(from.lat)), lon: center.lon + to.lon - from.lon };
}

/** The camera's centre after zooming `factor` times about `focus`, which stays where it is on the screen (null: the centre). */
export function zoomedCenter(center: Coordinate, focus: Coordinate | null, factor: number): Coordinate {
  if (!focus || factor <= 0) return center;
  const y = mercatorY(focus.lat) + (mercatorY(center.lat) - mercatorY(focus.lat)) / factor;
  return { lat: latOf(y), lon: focus.lon + (center.lon - focus.lon) / factor };
}

/** How far the follow zoom may be moved from its own by the car's zoom buttons and pinches, in zoom levels. */
export const FOLLOW_ZOOM_SHIFT = { min: -4, max: 2 } as const;

export function shiftedFollowZoom(shift: number, by: number): number {
  return Math.min(FOLLOW_ZOOM_SHIFT.max, Math.max(FOLLOW_ZOOM_SHIFT.min, shift + by));
}

/** Framing keeps at least this share of the map's width and of its height for what it frames. */
export const FRAME_KEEPS = 0.4;

/**
 * Room around what is framed, `padding` as asked unless it leaves less than `FRAME_KEEPS` of the map's `width` or
 * `height` (points): then that side's two shrink alike. A small car screen's panels (CarPlay's guidance card, bar and
 * buttons) cover most of its width: the routes were framed into a sliver, zoomed into an empty block.
 */
export function fittedPadding(
  padding: { top: number; bottom: number; left: number; right: number },
  width: number,
  height: number,
): { top: number; bottom: number; left: number; right: number } {
  const fit = (a: number, b: number, size: number): [number, number] => {
    const most = size * (1 - FRAME_KEEPS);
    if (size <= 0 || a + b <= most) return [a, b];
    const k = most / (a + b);
    return [a * k, b * k];
  };
  const [left, right] = fit(padding.left, padding.right, width);
  const [top, bottom] = fit(padding.top, padding.bottom, height);
  return { top, bottom, left, right };
}

/** A fling carries the map on as far as the finger's speed would in this long, eased out. */
export const FLING_S = 0.3;
export const FLING_EASE_MS = 600;
