// The active region's road graph for map matching (MAPMATCH-SPEC §5, §11): the downloaded
// `<region>.graph.bin`, read by random access through an expo-file-system FileHandle.

import type { File } from "expo-file-system";

import { LocalFrame } from "@/nav/geo/local-frame";
import type { ByteSource } from "@/nav/mapmatch/graph/byte-source";
import { TiledRoadGraph } from "@/nav/mapmatch/graph/road-graph";
import { activeGraphFile, getMapPacks, subscribeMapPacks } from "@/services/offline-map/map-packs";

export interface ActiveRoadGraph {
  /** Changes when the region or its graph file does. */
  key: string;
  region: string;
  graph: TiledRoadGraph;
}

/** Where the navigator gets its road graph; the app's is `activeRoadGraph`, tests pass their own. */
export interface RoadGraphSource {
  /** The active region's graph; null when it has none. */
  current(): ActiveRoadGraph | null;
  subscribe(listener: () => void): () => void;
}

/** Synchronous seek + read: a tile is a few kB, read on the JS thread when the filter needs it. */
export function fileHandleByteSource(file: File): ByteSource & { close(): void } {
  const handle = file.open();
  const size = handle.size ?? file.size;
  return {
    size,
    read(offset, length) {
      handle.offset = offset;
      const bytes = handle.readBytes(length);
      if (bytes.byteLength !== length) throw new Error(`short read at ${offset}: ${bytes.byteLength} of ${length}`);
      return bytes;
    },
    close: () => handle.close(),
  };
}

let open: (ActiveRoadGraph & { close(): void }) | null = null;
/** A file that failed to open isn't retried until the installed graph changes. */
let failedKey: string | null = null;

function current(): ActiveRoadGraph | null {
  const { installed } = getMapPacks();
  const active = activeGraphFile(installed);
  const key = active ? `${active.region}:${active.md5}` : null;
  if (open?.key === key) return open;
  open?.close();
  open = null;
  if (!active || !key || key === failedKey) return null;
  try {
    const source = fileHandleByteSource(active.file);
    // The navigator moves the graph into its own frame; until then, the region's centre.
    const [w, s, e, n] = installed.regions[active.region].bounds;
    const graph = new TiledRoadGraph(source, new LocalFrame({ lat: (s + n) / 2, lon: (w + e) / 2 }));
    open = { key, region: active.region, graph, close: source.close };
    failedKey = null;
    return open;
  } catch (e) {
    failedKey = key;
    console.warn(`road graph ${active.region}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export const activeRoadGraph: RoadGraphSource = { current, subscribe: subscribeMapPacks };
