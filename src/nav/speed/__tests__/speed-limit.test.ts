import { LocalFrame } from "@/nav/geo/local-frame";
import { EdgeFlag, Oneway, RoadClass } from "@/nav/mapmatch/graph/format";
import { MemoryRoadGraph } from "@/nav/mapmatch/graph/memory-graph";
import type { RoadEdge } from "@/nav/mapmatch/graph/road-graph";
import { agreedLimit, DEFAULT_LIMITS, edgeLimit, LimitHold, snapCandidates } from "@/nav/speed/speed-limit";

const A = EdgeFlag.attributes;
const DEG = Math.PI / 180;

const road = (cls: number, flags: number, maxspeedKph = 0, oneway: number = Oneway.none): RoadEdge => ({
  id: Math.floor(Math.random() * 1e9), wayId: 1, from: 0, to: 1, lengthM: 100, cls, oneway, flags, maxspeedKph,
  lonLat: new Float64Array(4), xy: new Float64Array(4), cum: new Float64Array([0, 100]),
});

describe("edgeLimit", () => {
  test("the OSM tag wins", () => {
    expect(edgeLimit(road(RoadClass.primary, A | EdgeFlag.urban, 70))).toEqual({ kph: 70, tagged: true });
  });

  test("untagged: Ukraine's default for the road and where it is", () => {
    const kph = (e: RoadEdge) => edgeLimit(e)?.kph;
    expect(kph(road(RoadClass.residential, A | EdgeFlag.urban))).toBe(DEFAULT_LIMITS.urban);
    expect(kph(road(RoadClass.primary, A | EdgeFlag.urban, 0, Oneway.forward))).toBe(DEFAULT_LIMITS.urban);
    expect(kph(road(RoadClass.livingStreet, A | EdgeFlag.urban))).toBe(DEFAULT_LIMITS.livingStreet);
    expect(kph(road(RoadClass.motorway, A))).toBe(DEFAULT_LIMITS.motorway);
    expect(kph(road(RoadClass.tertiary, A))).toBe(DEFAULT_LIMITS.rural);
    expect(kph(road(RoadClass.trunk, A))).toBe(DEFAULT_LIMITS.rural);
    expect(kph(road(RoadClass.trunk, A | EdgeFlag.link, 0, Oneway.forward))).toBe(DEFAULT_LIMITS.rural);
    expect(edgeLimit(road(RoadClass.residential, A | EdgeFlag.urban))?.tagged).toBe(false);
  });

  test("none on a graph without speed attributes, on driveways and parking aisles", () => {
    expect(edgeLimit(road(RoadClass.primary, 0, 50))).toBeNull();
    expect(edgeLimit(road(RoadClass.service, A | EdgeFlag.minorService | EdgeFlag.urban))).toBeNull();
  });

  test("none on an untagged one-way main road outside settlements: a dual carriageway (110) or a split (90, 50)", () => {
    expect(edgeLimit(road(RoadClass.trunk, A, 0, Oneway.forward))).toBeNull();
    expect(edgeLimit(road(RoadClass.primary, A, 0, Oneway.backward))).toBeNull();
    expect(edgeLimit(road(RoadClass.trunk, A, 110, Oneway.forward))).toEqual({ kph: 110, tagged: true });
  });
});

describe("agreedLimit", () => {
  const fifty = road(RoadClass.primary, A | EdgeFlag.urban, 50);
  const fiftyToo = road(RoadClass.residential, A | EdgeFlag.urban);
  const ninety = road(RoadClass.primary, A, 90);

  test("roads with the same limit add up, whether tagged or by default", () => {
    expect(agreedLimit([{ edge: fifty, weight: 0.5 }, { edge: fiftyToo, weight: 0.45 }, { edge: ninety, weight: 0.05 }])?.kph).toBe(50);
  });

  test("no sign while the weight is split between limits, or partly off the roads", () => {
    expect(agreedLimit([{ edge: fifty, weight: 0.7 }, { edge: ninety, weight: 0.3 }])).toBeNull();
    expect(agreedLimit([{ edge: fifty, weight: 0.7 }, { edge: null, weight: 0.3 }])).toBeNull();
    expect(agreedLimit([])).toBeNull();
  });
});

describe("snapCandidates", () => {
  // A junction: a 50 primary road north–south, a 30 residential street west–east, a one-way 90 road east of it.
  const frame = new LocalFrame({ lat: 50.45, lon: 30.52 });
  const at = (e: number, n: number) => frame.toCoordinate(e, n);
  const g = new MemoryRoadGraph(frame, [
    { cls: RoadClass.primary, flags: A | EdgeFlag.urban, maxspeedKph: 50, points: [at(0, -300), at(0, 0), at(0, 300)] },
    { cls: RoadClass.residential, flags: A | EdgeFlag.urban, maxspeedKph: 30, points: [at(-300, 0), at(0, 0), at(300, 0)] },
    { cls: RoadClass.primary, flags: A, maxspeedKph: 90, oneway: Oneway.forward, points: [at(30, 300), at(30, -300)] },
  ]);
  const limitAt = (e: number, n: number, accuracyM: number, headingRad?: number, speedMps?: number) =>
    agreedLimit(snapCandidates(g.edgesNear(e, n, 60), accuracyM, headingRad, speedMps))?.kph ?? null;

  test("driving north through the junction: the street across drops out by the course", () => {
    expect(limitAt(2, 3, 5, 0, 12)).toBe(50);
    // Standing, the course says nothing: the junction's roads disagree.
    expect(limitAt(2, 3, 5)).toBeNull();
  });

  test("the one-way road beside it, driven against its way, is not a candidate", () => {
    // 15 m from both; driving north, the one-way goes south.
    expect(limitAt(15, 150, 5, 0, 12)).toBe(50);
    // Driving south, both fit: no sign.
    expect(limitAt(15, 150, 5, Math.PI, 12)).toBeNull();
  });

  test("far from every road: nothing", () => {
    expect(limitAt(-150, -150, 5, 45 * DEG, 12)).toBeNull();
  });
});

describe("snapCandidates along an avenue", () => {
  // A 70 avenue north–south, a service road along it 15 m east (a town's 50 by default), a residential street 15 m west.
  const frame = new LocalFrame({ lat: 50.45, lon: 30.52 });
  const at = (e: number, n: number) => frame.toCoordinate(e, n);
  const U = A | EdgeFlag.urban;
  const avenue = { cls: RoadClass.primary, flags: U, maxspeedKph: 70, points: [at(0, -300), at(0, 300)] };
  const service = { cls: RoadClass.service, flags: U, points: [at(15, -300), at(15, 300)] };
  const street = { cls: RoadClass.residential, flags: U, points: [at(-15, -300), at(-15, 300)] };
  const limitAt = (g: MemoryRoadGraph, speedMps: number) =>
    agreedLimit(snapCandidates(g.edgesNear(0, 0, 60), 5, 0, speedMps))?.kph ?? null;

  test("fast, the service road beside it is no candidate: the avenue's sign", () => {
    const g = new MemoryRoadGraph(frame, [avenue, service]);
    expect(limitAt(g, 15)).toBe(70);
    // Slow, it may be where the car is: no sign.
    expect(limitAt(g, 5)).toBeNull();
  });

  test("a residential street as close, with another limit: no sign, at any speed", () => {
    expect(limitAt(new MemoryRoadGraph(frame, [avenue, street]), 15)).toBeNull();
  });
});

describe("LimitHold", () => {
  const fifty = { kph: 50, tagged: true };
  const ninety = { kph: 90, tagged: true };

  test("a limit shows after a second, another replaces it after two, a moment's flicker is ignored", () => {
    const h = new LimitHold();
    expect(h.update(fifty, 0)).toBeNull();
    expect(h.update(fifty, 1000)).toEqual(fifty);
    expect(h.update(ninety, 1500)).toEqual(fifty);
    expect(h.update(fifty, 2000)).toEqual(fifty); // came back: the change is off
    expect(h.update(ninety, 2500)).toEqual(fifty);
    expect(h.update(ninety, 4500)).toEqual(ninety);
    expect(h.update(null, 5000)).toEqual(ninety);
    expect(h.update(null, 7000)).toBeNull();
  });
});
