// Speed cameras (UI-SPEC §6.5): the map release's shared `cameras.json` (tools/tiles/tiles/cameras.py), all of
// Ukraine, OSM's and the Interior Ministry's list's, found by place.

import type { Coordinate } from "../geo";

export interface SpeedCamera extends Coordinate {
  /** Its index in the file: its name in the trip log. */
  id: number;
  /** The traffic it checks, clockwise from north; absent: both ways. */
  bearingRad?: number;
  /** At the camera, km/h, from the list or OSM; absent: the road's (`edgeLimit`). */
  limitKph?: number;
  /** On the Interior Ministry's list of cameras in service; else OSM's alone (maybe switched off, kept anyway). */
  listed: boolean;
}

const FORMAT = 1;
const ON_LIST = 2;

/** The file's cameras; empty for a file of another format (a newer release than this app reads). */
export function parseCameras(text: string): SpeedCamera[] {
  const data = JSON.parse(text) as { format?: number; cameras?: [number, number, number, number, number][] };
  if (data.format !== FORMAT || !Array.isArray(data.cameras)) return [];
  return data.cameras.map(([lat, lon, bearing, limit, flags], id) => ({
    id,
    lat,
    lon,
    ...(bearing >= 0 ? { bearingRad: (bearing * Math.PI) / 180 } : {}),
    ...(limit > 0 ? { limitKph: limit } : {}),
    listed: (flags & ON_LIST) !== 0,
  }));
}

/** Grid cells, degrees: ~2.2 km north–south, ~1.4 km east–west in Ukraine. */
const CELL_DEG = 0.02;
const M_PER_DEG = 111_195;

/** The cameras by place, for those around the car. */
export class CameraIndex {
  private readonly cells = new Map<string, SpeedCamera[]>();

  constructor(readonly cameras: readonly SpeedCamera[]) {
    for (const c of cameras) {
      const key = `${Math.floor(c.lat / CELL_DEG)}:${Math.floor(c.lon / CELL_DEG)}`;
      const cell = this.cells.get(key);
      if (cell) cell.push(c);
      else this.cells.set(key, [c]);
    }
  }

  /** The cameras within `radiusM` of `p`. */
  near(p: Coordinate, radiusM: number): SpeedCamera[] {
    const dLat = radiusM / M_PER_DEG;
    const cos = Math.cos((p.lat * Math.PI) / 180);
    const dLon = dLat / Math.max(cos, 0.1);
    const out: SpeedCamera[] = [];
    for (let y = Math.floor((p.lat - dLat) / CELL_DEG); y <= Math.floor((p.lat + dLat) / CELL_DEG); y++) {
      for (let x = Math.floor((p.lon - dLon) / CELL_DEG); x <= Math.floor((p.lon + dLon) / CELL_DEG); x++) {
        for (const c of this.cells.get(`${y}:${x}`) ?? []) {
          const dy = (c.lat - p.lat) * M_PER_DEG;
          const dx = (c.lon - p.lon) * M_PER_DEG * cos;
          if (dx * dx + dy * dy <= radiusM * radiusM) out.push(c);
        }
      }
    }
    return out;
  }
}
