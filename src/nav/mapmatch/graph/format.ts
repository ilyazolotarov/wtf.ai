// Road graph file, format 1 (MAPMATCH-SPEC §4.5). Written by tools/tiles/tiles/graph.py;
// keep both in step. Little-endian; every record is a multiple of 4 bytes. Speed attributes (2026-10-10) went into
// spare bits and a padding byte, so older readers read newer files and newer readers older files.

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
  // Speed attributes (ROUTING-SPEC §4.1): meaningful only with `attributes`, which graphs built before 2026-10-10 lack.
  unpaved: 64,
  /** In a settlement: in a place area, near built-up landuse or a place point. */
  urban: 128,
  /** A traffic light along the edge, away from its junctions (a signalled crossing). */
  signals: 256,
  /** Built with speed attributes: `maxspeedKph`, `unpaved`, `urban`, `signals`, `city`, `bigCity`, node controls. */
  attributes: 512,
  /** In a city (a place=city area, or near its point: 4 km for 300 000 people, wider for bigger ones). Also `urban`. */
  city: 1024,
  /** In a city of 500 000 people or more, where rush hours slow the main roads (ROUTING-SPEC §4.3). Also `city`. */
  bigCity: 2048,
} as const;

export const NodeFlag = {
  /** Outside the region polygon: the way continues beyond the extract, it isn't a real dead end. */
  boundary: 1,
  deadEnd: 2,
  /** A junction with traffic lights (on the node or at a stop line within 40 m of it). */
  signals: 4,
  /** A stop or give-way sign at the junction. */
  stop: 8,
} as const;

export const RestrictionKind = { no: 1, only: 2 } as const;

/** Edge and node ids: tile index · 65536 + local index (exact in a JS number). */
export const graphId = (tile: number, index: number) => tile * 65536 + index;
export const idTile = (id: number) => Math.floor(id / 65536);
export const idIndex = (id: number) => id % 65536;
