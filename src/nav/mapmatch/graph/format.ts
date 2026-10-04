// Road graph file, format 1 (MAPMATCH-SPEC §4.5). Written by tools/tiles/tiles/graph.py;
// keep both in step. Little-endian; every record is a multiple of 4 bytes.

export const GRAPH_MAGIC = "WTFG";
export const GRAPH_FORMAT = 1;
export const HEADER_BYTES = 64;
export const TILE_HEADER_BYTES = 24;

/** Record sizes in bytes. */
export const NODE_BYTES = 16;
export const REF_BYTES = 8;
export const EDGE_BYTES = 28;
export const VERTEX_BYTES = 8;
export const RESTRICTION_BYTES = 20;

/** Coordinates are integers in 1e-6°. */
export const COORD_SCALE = 1e-6;

export const RoadClass = {
  motorway: 0,
  trunk: 1,
  primary: 2,
  secondary: 3,
  tertiary: 4,
  unclassified: 5,
  residential: 6,
  livingStreet: 7,
  service: 8,
  track: 9,
  road: 10,
} as const;

export const ROAD_CLASS_NAMES = [
  "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified",
  "residential", "living_street", "service", "track", "road",
] as const;

/** One-way relative to the edge's geometry (OSM way) direction. */
export const Oneway = { none: 0, forward: 1, backward: 2 } as const;

export const EdgeFlag = {
  link: 1,
  roundabout: 2,
  tunnel: 4,
  bridge: 8,
  /** Access other than open (private, agricultural, delivery, …). */
  private: 16,
  /** service = driveway / parking_aisle / drive-through / emergency_access. */
  minorService: 32,
} as const;

export const NodeFlag = {
  /** Outside the region polygon: the way continues beyond the extract, it isn't a real dead end. */
  boundary: 1,
  deadEnd: 2,
} as const;

export const RestrictionKind = { no: 1, only: 2 } as const;

/** Edge and node ids: tile index · 65536 + local index (exact in a JS number). */
export const graphId = (tile: number, index: number) => tile * 65536 + index;
export const idTile = (id: number) => Math.floor(id / 65536);
export const idIndex = (id: number) => id % 65536;
