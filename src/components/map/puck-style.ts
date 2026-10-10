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

/** The route's destination: the route's colour in its casing; points. */
export const DESTINATION_DOT = { r: 8, ring: 3 } as const;
