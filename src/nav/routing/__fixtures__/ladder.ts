// Test network for alternative routes (ROUTING-SPEC §8.7).

import { LocalFrame } from "@/nav/geo/local-frame";
import { RoadClass } from "@/nav/mapmatch/graph/format";
import { MemoryRoadGraph } from "@/nav/mapmatch/graph/memory-graph";

// A ladder (metres east, north of the origin): the start road west of A (100, 0), the end road east of B (2100, 0).
// Between them a north branch (2.6 km), a south branch (2.8 km) and a far south one (5.0 km, slower than 1.3×). The
// north branch has a 200 m bypass beside it, a parallel street: a different road, but not a different route.
export const frame = new LocalFrame({ lat: 50.45, lon: 30.52 });
export const at = (e: number, n: number) => frame.toCoordinate(e, n);
export const ladder = () =>
  new MemoryRoadGraph(frame, [
    { cls: RoadClass.primary, points: [at(-100, 0), at(0, 0), at(100, 0)] },
    { cls: RoadClass.primary, points: [at(100, 0), at(100, 300), at(1000, 300), at(1200, 300), at(2100, 300), at(2100, 0)] },
    { cls: RoadClass.secondary, points: [at(1000, 300), at(1000, 330), at(1200, 330), at(1200, 300)] },
    { cls: RoadClass.primary, points: [at(100, 0), at(100, -400), at(2100, -400), at(2100, 0)] },
    { cls: RoadClass.primary, points: [at(100, -400), at(100, -1500), at(2100, -1500), at(2100, -400)] },
    { cls: RoadClass.primary, points: [at(2100, 0), at(2200, 0), at(2300, 0)] },
  ]);
