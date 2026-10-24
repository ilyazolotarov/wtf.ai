/**
 * The car's dot (UI-SPEC §6.1), points: a fill, a ring (white while GPS is trusted; amber, round a light centre, while
 * it isn't) and a thin dark edge outside it. Every surface it sits on meets one band that stands out: the dark edge
 * against yellow roads and light land, the ring against the blue route and the dark ground. The map and the lessons'
 * drawn maps (`mini-map.tsx`) both draw it from these.
 */
export const PUCK = { r: 8, ring: 3.5, edge: 1.5 } as const;

/** The whole dot, edge included. */
export const PUCK_OUTER = PUCK.r + PUCK.ring + PUCK.edge;

/**
 * The heading cone, part of the dot's symbol: the same size on screen at every zoom (the map turns it into metres at
 * the current zoom), and the same on the lessons' drawn maps. Points; half its angle each side of the heading.
 */
export const CONE = { r: 34, halfAngleRad: (28 * Math.PI) / 180 } as const;

/**
 * The heading cone lies along the road the car drives, so its outline does what the dot's bands do, per theme, points:
 * light, a dark edge alone (a white line inside it read as a double stroke on light land); dark, the ring's colour on
 * a black edge (the edge alone vanishes on the dark ground).
 */
export const CONE_OUTLINE = {
  light: { edge: 1.5, ring: 0 },
  dark: { edge: 3, ring: 1.5 },
} as const;

/** The cone's fill opacity: the road under it still shows. */
export const CONE_FILL_OPACITY = 0.32;

/** A dropped pin on the map (ROUTING-SPEC §8), banded as the dot: fill, white ring, dark edge, a faint halo; points. */
export const PIN_DOT = { r: 7, ring: 3, halo: 16 } as const;

/**
 * The trusted dot's glow, points, opacity: dark only. Night Drive's ground is near black and its main roads amber,
 * and the dot alone read small there; a halo of its own blue sets it off. Light has none (opacity 0, the layer kept
 * so the order holds across a theme change).
 */
export const PUCK_HALO = {
  light: { r: PUCK_OUTER, opacity: 0 },
  dark: { r: PUCK_OUTER + 10, opacity: 0.45 },
} as const;

/**
 * The lessons' car (`CarGlyph`): the map's car image (`MAP_CAR`) drawn `length` units long on a lesson's drawn map
 * (inside the placing lesson's target circle, 28 units in radius), and the colour of its trail, dark on light ground
 * and light on dark.
 */
export const CAR_GLYPH = {
  length: 52,
  color: { light: "#1D1C1A", dark: "#F2F0EC" },
} as const;

/**
 * The car on the map (UI-SPEC §6.1): a car seen from straight above, shaded to read as 3D, drawn by
 * `scripts/map-car.py` into `assets/images/map-car-{light,dark}` (1x/2x/3x, and the `near` images). Its body dark on light ground and white on
 * dark, the windscreen and windows in the trusted dot's blue (theme.ts `puck`, held equal by a
 * test), banded as the dot, a soft shadow. The colours here are the image's, for the
 * contrast test: change both together. Facing the screen when the map tilts (seen from above whatever the camera).
 */
export const MAP_CAR = {
  image: { light: "map-car-light", dark: "map-car-dark" },
  /** The style's sprite its images are in (car-sprite.ts): `car:map-car-dark`. */
  sprite: "car",
  body: { light: "#24272C", dark: "#F3F5F8" },
  glass: { light: "#0A84FF", dark: "#3D6BFF" },
  /** Banded as the dot: a white ring round the body, a dark edge outside it (0.7 and 0.6 pt in the image). */
  ring: "#FFFFFF",
  edge: { light: "#1C1F24", dark: "#000000" },
  /** The car's footprint in the image at 1x, points (26 × 56), drawn at `size`. */
  footprint: { w: 13, h: 28 },
  /** The whole image at 1x, points: the car centred on it, room round it for the mirrors and the shadow. */
  canvas: { w: 40, h: 68 },
  /**
   * The near images' densities, pixels per point (`map-car-{light,dark}-x6`, `-x12`): drawn instead of the car's own
   * once the map is zoomed in so far that a 3x screen would stretch it (the car is drawn as long as it is on the ground,
   * over seven times its own size at zoom 22). Densest last.
   */
  near: [6, 12],
  /**
   * How many times the footprint's points it is drawn: `size` at `atZoom` (the image's own 56 pt), growing as the map is
   * zoomed in, at `growth` of the map's rate (half: twice as large every two zoom levels); zoomed out, never below
   * `minSize`. Never shorter on the ground than `minLengthM` either.
   */
  size: 2,
  atZoom: 17,
  growth: 0.5,
  minSize: 1,
  minLengthM: 5,
} as const;

/** The route's destination: the route's colour in its casing; points. */
export const DESTINATION_DOT = { r: 8, ring: 3 } as const;

/**
 * The route line and its casing, points, and the dashed stretch the car is on (dash and gap, points; `underlay`: the
 * route's opacity in the gaps, over the solid casing). Wider than the main roads, so the route covers the road and the
 * casing edges it (6 pt read as a thin stripe inside them), and the dashed stretch is a dim bar of the route with
 * bright dashes (with plain gaps the road showed through every one).
 */
export const ROUTE_LINE = { line: 9, casing: 13, dash: 18, gap: 8, underlay: 0.35 } as const;
