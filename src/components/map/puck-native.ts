// The native puck's look and place (UI-SPEC §6.2): the wrapper draws MapLibre's user location as the app's dot
// (puck-style.ts, theme.ts) from this JSON, and puts it at the anchor the follow camera keeps it at.
import { Colors } from "@/constants/theme";

import { CONE, CONE_FILL_OPACITY, CONE_OUTLINE, PUCK, PUCK_HALO } from "./puck-style";

/** A theme colour (`#RRGGBB`, `#RRGGBBAA` or `rgba(r,g,b,a)`) as 0xAARRGGBB, the form both platforms take. */
export function argb(color: string): number {
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color);
  if (hex) return ((hex[2] ? parseInt(hex[2], 16) : 255) * 2 ** 24 + parseInt(hex[1], 16)) >>> 0;
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(color);
  if (rgba) {
    const a = rgba[4] === undefined ? 1 : Number(rgba[4]);
    return (Math.round(a * 255) * 2 ** 24 + (Number(rgba[1]) << 16) + (Number(rgba[2]) << 8) + Number(rgba[3])) >>> 0;
  }
  return 0xff000000;
}

/** The style JSON the wrapper's `setUserLocationSource` takes. */
export function nativePuckStyle(scheme: "light" | "dark"): string {
  const palette = Colors[scheme];
  const halo = PUCK_HALO[scheme];
  const outline = CONE_OUTLINE[scheme];
  return JSON.stringify({
    dot: argb(palette.puck),
    doubt: argb(palette.puckDoubt),
    bg: argb(palette.bg),
    ring: argb(palette.puckRing),
    edge: argb(palette.puckEdge),
    halo: argb(palette.puck),
    haloOpacity: halo.opacity,
    r: PUCK.r,
    ringWidth: PUCK.ring,
    edgeWidth: PUCK.edge,
    haloR: halo.opacity > 0 ? halo.r : 0,
    coneR: CONE.r,
    coneHalfDeg: (CONE.halfAngleRad * 180) / Math.PI,
    coneOpacity: CONE_FILL_OPACITY,
    coneEdge: outline.edge,
    coneRing: outline.ring,
  });
}

/**
 * Where the dot sits on the map (fractions of its size): in the part of the map no one else's panels cover, `dotAt`
 * of the way down (0.5 the middle). The same spot the follow camera's padding put it at.
 */
export function dotAnchor(
  mapWidth: number,
  mapHeight: number,
  insets: { top: number; bottom: number; left: number; right: number },
  dotAt: number,
): { x: number; y: number } {
  if (mapWidth <= 0 || mapHeight <= 0) return { x: 0.5, y: 0.5 };
  const visibleW = Math.max(0, mapWidth - insets.left - insets.right);
  const visibleH = Math.max(0, mapHeight - insets.top - insets.bottom);
  return {
    x: Math.min(1, Math.max(0, (insets.left + 0.5 * visibleW) / mapWidth)),
    y: Math.min(1, Math.max(0, (insets.top + dotAt * visibleH) / mapHeight)),
  };
}
