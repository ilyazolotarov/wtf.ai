import { LocalFrame } from "@/nav/geo/local-frame";
import type { Coordinate } from "@/nav/geo";
import { RoadClass } from "@/nav/mapmatch/graph/format";
import { MemoryRoadGraph } from "@/nav/mapmatch/graph/memory-graph";
import type { PositionEstimate } from "@/nav/position/types";
import { RouteLine } from "@/nav/routing/along";
import type { StopPlace } from "@/nav/search/search-index";
import { RouteService, type RouteSnapshot } from "@/services/navigation/route-service";
import type { NavRouteStopRecord } from "@/triplog/schema";

// A main road east, 0–3000 m; at 1500 m a side road south to a fuel station's forecourt (1500, −150); a cul-de-sac
// north at 2400 m to a pharmacy (2400, 200); a road no other reaches north of the end. Metres east, north of the origin.
const frame = new LocalFrame({ lat: 50.45, lon: 30.52 });
const at = (e: number, n: number) => frame.toCoordinate(e, n);
const network = () =>
  new MemoryRoadGraph(frame, [
    { cls: RoadClass.primary, points: [at(0, 0), at(1500, 0)] },
    { cls: RoadClass.primary, points: [at(1500, 0), at(2400, 0)] },
    { cls: RoadClass.primary, points: [at(2400, 0), at(3000, 0)] },
    { cls: RoadClass.service, points: [at(1500, 0), at(1500, -150)] },
    { cls: RoadClass.residential, points: [at(2400, 0), at(2400, 200)] },
    { cls: RoadClass.residential, points: [at(1500, 0), at(1500, 900)] },
    { cls: RoadClass.residential, points: [at(2600, 700), at(2800, 700)] },
  ]);
const STATION = at(1500, -150);
const DESTINATION = { ...at(3000, 0), name: "End" };

const places: StopPlace[] = [
  { key: "p1", category: "fuel", name: "Station", ...at(1500, -150), flags: 2, hours: null },
  { key: "p2", category: "pharmacy", name: null, ...at(2400, 200), flags: 0, hours: null },
  { key: "p3", category: "fuel", name: "Behind", ...at(100, 50), flags: 0, hours: null },
  // Parking: two a walk from the end, one at the start, one by the pharmacy.
  { key: "k1", category: "parking", name: null, ...at(2600, 40), flags: 0, hours: null },
  { key: "k2", category: "parking", name: "Square", ...at(2950, 60), flags: 0, hours: null },
  { key: "k3", category: "parking", name: null, ...at(150, -30), flags: 0, hours: null },
  { key: "k4", category: "parking", name: null, ...at(2350, 260), flags: 0, hours: null },
];

function harness() {
  let position: PositionEstimate | null = null;
  const listeners = new Set<() => void>();
  let clock = 1_000_000;
  const deferred: (() => void)[] = [];
  const notes: string[] = [];
  const stops: NavRouteStopRecord[] = [];
  const store = new Map<string, unknown>();
  const service = new RouteService({
    position: { getSnapshot: () => position, subscribe: (l) => (listeners.add(l), () => listeners.delete(l)) },
    openGraph: () => ({ key: "net", graph: Object.assign(network(), { setFrame: () => {} }), close: () => {} }),
    nowUs: () => clock * 1000,
    now: () => clock,
    note: (t) => notes.push(t),
    log: { route: () => {}, point: () => {}, maneuver: () => {}, progress: () => {}, stop: (r) => stops.push(r) },
    store: { getJson: <T,>(key: string) => (store.get(key) ?? null) as T | null, setJson: (key, value) => void store.set(key, value) },
    defer: (fn) => {
      deferred.push(fn);
      return () => deferred.splice(deferred.indexOf(fn) >>> 0, 1);
    },
    places: () => ({
      hasPlaces: true,
      placesIn: (box, categories) =>
        places.filter((p) => (!categories || categories.has(p.category)) && p.lat >= box.south && p.lat <= box.north && p.lon >= box.west && p.lon <= box.east),
    }),
  });
  const flush = () => {
    while (deferred.length) deferred.shift()!();
  };
  const moveTo = (c: Coordinate, more: Partial<PositionEstimate> = {}) => {
    clock += 1000;
    position = { ...c, accuracyM: 5, source: "fused", trust: "TRUSTED", timestamp: clock, headingRad: Math.PI / 2, speedMps: 10, ...more };
    listeners.forEach((l) => l());
  };
  const snap = () => service.getSnapshot() as RouteSnapshot;
  /** Drive the current plan from `fromM` to `toM` (its metres), a position every `stepM`. */
  const follow = (fromM: number, toM: number, stepM = 10) => {
    const line = new RouteLine(snap().plan!);
    for (let m = fromM; m <= toM; m += stepM) {
      const p = line.at(m);
      moveTo(p.point, { headingRad: p.headingRad });
    }
  };
  const tick = (ms: number) => (clock += ms);
  return { service, flush, moveTo, snap, follow, notes, stops, store, tick };
}

describe("RouteService with stops (STOPS-SPEC §4–5)", () => {
  test("a trip through a stop: planned through it, logged, kept for a restart", () => {
    const h = harness();
    h.moveTo(at(100, 0));
    h.service.start(DESTINATION, { stops: [{ ...STATION, name: "Station", category: "fuel" }] });
    h.flush();
    const s = h.snap();
    expect(s.status).toBe("active");
    expect(s.stops).toHaveLength(1);
    expect(s.plan!.stops).toHaveLength(1);
    expect(s.plan!.lengthM).toBeGreaterThan(2900 + 300 - 100);
    expect(s.maneuvers!.filter((m) => m.kind === "stop")).toHaveLength(1);
    expect(h.stops).toMatchObject([{ index: 0, category: "fuel" }]);
    expect(h.notes.some((n) => n.includes("via Station"))).toBe(true);
    expect(h.store.get("route.active")).toMatchObject({ destination: DESTINATION, stops: [{ name: "Station", category: "fuel" }] });
  });

  test("at the stop the route waits; it goes on once the car follows the next leg; the destination still arrives", () => {
    const h = harness();
    h.moveTo(at(100, 0));
    h.service.start(DESTINATION, { stops: [{ ...STATION, name: "Station", category: "fuel" }] });
    h.flush();
    const stopAt = h.snap().plan!.stops![0].atM;
    h.follow(0, stopAt);
    expect(h.snap().atStop?.stop.name).toBe("Station");
    expect(h.snap().stops).toEqual([]);
    expect(h.notes.some((n) => n.startsWith("route stop reached: Station"))).toBe(true);
    // Standing on the forecourt, then walking off with the phone: off the route, but no re-plan.
    const plans = h.snap().planId;
    for (let i = 0; i < 30; i++) h.moveTo(at(1530 + i, -170), { speedMps: 0, headingRad: 0 });
    h.tick(60_000);
    h.moveTo(at(1560, -200), { speedMps: 1.2 });
    h.flush();
    expect(h.snap().planId).toBe(plans);
    expect(h.snap().atStop).toBeDefined();
    // Back on the next leg (the parked turnaround, north, then east): the wait is over.
    h.follow(stopAt, stopAt + 300);
    expect(h.snap().atStop).toBeUndefined();
    expect(h.notes.some((n) => n.startsWith("route stop left: Station"))).toBe(true);
    h.follow(stopAt + 300, h.snap().plan!.lengthM);
    expect(h.snap().guidance?.state).toBe("arrived");
  });

  test("a stop added while standing at one: the wait ends once the car follows the new route, not the old one's", () => {
    const h = harness();
    h.moveTo(at(100, 0));
    h.service.start(DESTINATION, { stops: [{ ...STATION, name: "Station" }] });
    h.flush();
    h.follow(0, h.snap().plan!.stops![0].atM);
    expect(h.snap().atStop).toBeDefined();
    h.moveTo(STATION, { speedMps: 0, headingRad: 0 });
    expect(h.service.addStop({ ...at(2400, 200), name: "Pharmacy" })).toBe(true);
    h.flush();
    expect(h.snap()).toMatchObject({ planReason: "stops", atStop: { stop: { name: "Station" }, atM: 0 } });
    // The new route starts at the pump, 1950 m long; 300 m along it the car has gone on.
    h.follow(0, 300);
    expect(h.snap().atStop).toBeUndefined();
    expect(h.notes.some((n) => n.startsWith("route stop left: Station"))).toBe(true);
  });

  test("leaving a stop another way with no speed known (GNSS alone): planned on from there", () => {
    const h = harness();
    h.moveTo(at(100, 0));
    h.service.start(DESTINATION, { stops: [{ ...STATION, name: "Station" }] });
    h.flush();
    h.follow(0, h.snap().plan!.stops![0].atM);
    const plans = h.snap().planId;
    h.tick(60_000);
    // Up the road north instead, positions without a speed.
    for (let n = 300; n <= 500; n += 20) h.moveTo(at(1500, n), { speedMps: undefined, headingRad: 0 });
    h.flush();
    expect(h.snap().atStop).toBeUndefined();
    expect(h.snap().planId).toBeGreaterThan(plans);
    expect(h.snap().planReason).toBe("off-route");
  });

  test("'go on' at a stop ends the wait at once", () => {
    const h = harness();
    h.moveTo(at(100, 0));
    h.service.start(DESTINATION, { stops: [{ ...STATION, name: "Station" }] });
    h.flush();
    h.follow(0, h.snap().plan!.stops![0].atM);
    expect(h.snap().atStop).toBeDefined();
    h.service.goOn();
    expect(h.snap().atStop).toBeUndefined();
  });

  test("driving past a stop on the route: left behind, nothing planned, offered back", () => {
    const h = harness();
    h.moveTo(at(100, 0));
    h.service.start(DESTINATION, { stops: [{ ...STATION, name: "Station" }] });
    h.flush();
    const planId = h.snap().planId;
    // Straight on at 1500 m instead of down the side road and back: the route goes on along the same road.
    for (let e = 100; e <= 2000; e += 10) h.moveTo(at(e, 0));
    h.flush();
    const s = h.snap();
    expect(s.stops).toEqual([]);
    expect(s.passedStop?.stop.name).toBe("Station");
    expect(s.planId).toBe(planId);
    expect(s.guidance).toMatchObject({ state: "on", nextStop: null });
    // The way back worked out: some minutes more.
    expect(s.passedStop?.backDeltaS).toBeGreaterThan(0);
    expect(h.notes.some((n) => n.startsWith("route stop passed: Station"))).toBe(true);
    h.service.backToPassed();
    h.flush();
    expect(h.snap()).toMatchObject({ planReason: "stop-back", passedStop: undefined });
    expect(h.snap().stops.map((x) => x.name)).toEqual(["Station"]);
  });

  test("leaving the route near a stop and driving away from it: planned on without it, not back to it", () => {
    const h = harness();
    h.moveTo(at(100, 0));
    h.service.start(DESTINATION, { stops: [{ ...STATION, name: "Station" }] });
    h.flush();
    for (let e = 100; e <= 1490; e += 10) h.moveTo(at(e, 0));
    // North at the junction instead (the position lost a while, back 400 m up that road).
    for (let n = 400; n <= 600; n += 10) h.moveTo(at(1500, n), { headingRad: 0 });
    h.flush();
    const s = h.snap();
    expect(s.passedStop?.stop.name).toBe("Station");
    expect(s.stops).toEqual([]);
    expect(s.planReason).toBe("off-route");
    expect(s.plan!.stops ?? []).toEqual([]);
    expect(h.notes.some((n) => /route stop passed: Station.*at the closest/.test(n))).toBe(true);
  });

  test("leaving the route before reaching a stop's turn plans through it again, as before", () => {
    const h = harness();
    h.moveTo(at(100, 0));
    h.service.start(DESTINATION, { stops: [{ ...STATION, name: "Station" }] });
    h.flush();
    // A detour well before it.
    for (let e = 100; e <= 600; e += 10) h.moveTo(at(e, 0));
    for (let n = 30; n <= 200; n += 10) h.moveTo(at(600, n), { headingRad: 0 });
    h.tick(20_000);
    h.moveTo(at(600, 210), { headingRad: 0 });
    h.flush();
    expect(h.snap().planReason).toBe("off-route");
    expect(h.snap().passedStop).toBeUndefined();
    expect(h.snap().stops.map((x) => x.name)).toEqual(["Station"]);
  });

  test("the card of a stop left behind goes after 2 km", () => {
    const h = harness();
    h.moveTo(at(100, 0));
    h.service.start({ ...at(3000, 0) }, { stops: [{ ...STATION, name: "Station" }] });
    h.flush();
    for (let e = 100; e <= 2000; e += 10) h.moveTo(at(e, 0));
    h.flush();
    expect(h.snap().passedStop).toBeDefined();
    for (let i = 0; i < 25; i++) h.moveTo(at(2000 + i * 20, 0), { speedMps: 100 });
    expect(h.snap().passedStop).toBeUndefined();
  });

  test("adding, moving and removing stops plans again from the car (reason stops)", () => {
    const h = harness();
    h.moveTo(at(100, 0));
    h.service.start(DESTINATION);
    h.flush();
    h.follow(0, 200);
    expect(h.service.addStop({ ...at(2400, 200), name: "Pharmacy" })).toBe(true);
    h.flush();
    expect(h.snap().planReason).toBe("stops");
    // Placed by where it is along the route.
    expect(h.service.addStop({ ...STATION, name: "Station" })).toBe(true);
    h.flush();
    expect(h.snap().stops.map((x) => x.name)).toEqual(["Station", "Pharmacy"]);
    expect(h.snap().plan!.stops!.map((x) => x.key)).toEqual(h.snap().stops.map((x) => x.key));
    h.service.moveStop(h.snap().stops[1].key, -1);
    h.flush();
    expect(h.snap().stops.map((x) => x.name)).toEqual(["Pharmacy", "Station"]);
    h.service.removeStop(h.snap().stops[0].key);
    h.flush();
    expect(h.snap().stops.map((x) => x.name)).toEqual(["Station"]);
    expect(h.snap().plan!.stops).toHaveLength(1);
  });

  test("a stop added that no road reaches: said, taken out again, the route going on without it", () => {
    const h = harness();
    h.moveTo(at(100, 0));
    h.service.start(DESTINATION);
    h.flush();
    h.follow(0, 200);
    const planId = h.snap().planId;
    expect(h.service.addStop({ ...at(2700, 700), name: "Island" })).toBe(true);
    h.flush();
    const s = h.snap();
    expect(s.noRouteTo).toMatchObject({ stop: { name: "Island" }, dropped: true });
    expect(s.stops).toEqual([]);
    expect(s.planId).toBe(planId);
    expect(h.store.get("route.active")).toMatchObject({ stops: [] });
    expect(h.notes.some((n) => n.startsWith("route stop dropped: Island"))).toBe(true);
    // The next change plans as before, and the message goes.
    expect(h.service.addStop({ ...STATION, name: "Station" })).toBe(true);
    h.flush();
    expect(h.snap()).toMatchObject({ planReason: "stops", noRouteTo: undefined });
  });

  test("at most five stops", () => {
    const h = harness();
    h.moveTo(at(100, 0));
    h.service.start(DESTINATION, { stops: Array.from({ length: 7 }, (_, i) => ({ ...at(500 + i * 100, 0) })) });
    expect(h.snap().stops).toHaveLength(5);
    expect(h.service.addStop({ ...STATION })).toBe(false);
  });

  test("a stop left behind is not put back into a trip of five stops (none dropped for it)", () => {
    const h = harness();
    h.moveTo(at(100, 0));
    h.service.start(DESTINATION, { stops: [{ ...STATION, name: "Station" }, { ...at(2600, 0), name: "S1" }] });
    h.flush();
    for (let e = 100; e <= 2000; e += 10) h.moveTo(at(e, 0));
    h.flush();
    expect(h.snap().passedStop?.stop.name).toBe("Station");
    for (const [e, name] of [[2700, "S2"], [2800, "S3"], [2900, "S4"]] as const) {
      expect(h.service.addStop({ ...at(e, 0), name })).toBe(true);
      h.flush();
    }
    expect(h.service.addStop({ ...at(2400, 200), name: "Pharmacy" })).toBe(true);
    h.flush();
    expect(h.snap().stops).toHaveLength(5);
    expect(h.service.backToPassed()).toBe(false);
    expect(h.snap().stops.map((x) => x.name)).toEqual(["Pharmacy", "S1", "S2", "S3", "S4"]);
    expect(h.snap().passedStop?.stop.name).toBe("Station");
  });

  test("a restarted app goes on through the stops not yet reached", () => {
    const h = harness();
    h.moveTo(at(100, 0));
    h.service.start(DESTINATION, { stops: [{ ...STATION, name: "Station" }, { ...at(2400, 200), name: "Pharmacy" }] });
    h.flush();
    h.follow(0, h.snap().plan!.stops![0].atM);
    const saved = h.store.get("route.active");
    const h2 = harness();
    h2.store.set("route.active", saved);
    h2.moveTo(at(100, 0), { speedMps: 0 }); // the test graph keeps its own frame: start near its origin
    h2.service.resume();
    h2.flush();
    expect(h2.snap().stops.map((x) => x.name)).toEqual(["Pharmacy"]);
    expect(h2.snap().failure).toBeUndefined();
    expect(h2.snap().status).toBe("active");
  });

  test("places along the way: ahead only, by distance along, then their detours", () => {
    const h = harness();
    h.moveTo(at(100, 0));
    h.service.start(DESTINATION);
    h.flush();
    h.follow(0, 300);
    h.service.findAlong("fuel");
    expect(h.snap().along).toMatchObject({ category: "fuel", status: "searching" });
    expect(h.snap().along!.items.map((x) => x.place.key)).toEqual(["p1"]);
    h.flush();
    const item = h.snap().along!.items[0];
    expect(h.snap().along!.status).toBe("done");
    expect(item.side).toBe("right");
    // Down the side road and back: about 300 m on a service road and the turns.
    expect(item.detourS).toBeGreaterThan(30);
    h.service.findAlong("pharmacy");
    h.flush();
    expect(h.snap().along!.items.map((x) => x.place.key)).toEqual(["p2"]);
    expect(h.snap().along!.items[0].side).toBe("left");
    h.service.closeAlong();
    expect(h.snap().along).toBeUndefined();
  });

  test("parking: near the destination, the nearest first, then near the stops; not along the route from the start", () => {
    const h = harness();
    h.moveTo(at(100, 0));
    h.service.start(DESTINATION, { stops: [{ ...at(2400, 200), name: "Pharmacy", key: "ph" }] });
    h.flush();
    h.service.findAlong("parking");
    const along = h.snap().along!;
    expect(along.status).toBe("done");
    expect(along.items.map((x) => [x.place.key, x.parkFor])).toEqual([["k2", "destination"], ["k1", "destination"], ["k4", "ph"]]);
    expect(along.items[0].walkM).toBeGreaterThan(70);
    expect(along.items[0].walkM).toBeLessThan(85);
  });

  test("parking picked: the car goes there instead of the destination, or of the stop, the rest of the trip kept", () => {
    const h = harness();
    h.moveTo(at(100, 0));
    h.service.start(DESTINATION, { stops: [{ ...STATION, name: "Station", key: "st" }, { ...at(2400, 200), name: "Pharmacy", key: "ph" }] });
    h.flush();
    h.service.parkAt({ ...at(2950, 60), name: "Square" }, "destination");
    h.flush();
    expect(h.snap()).toMatchObject({ planReason: "stops", destination: { name: "Square" } });
    expect(h.snap().stops.map((x) => x.key)).toEqual(["st", "ph"]);
    expect(h.store.get("route.active")).toMatchObject({ destination: { name: "Square" } });
    h.service.parkAt({ ...at(2350, 260), name: "By the pharmacy", key: "k4" }, "ph");
    h.flush();
    expect(h.snap().stops.map((x) => x.name)).toEqual(["Station", "By the pharmacy"]);
    expect(h.snap().plan!.stops!.map((x) => x.key)).toEqual(["st", "k4"]);
  });

  test("detours of search results, for the add-a-stop search", () => {
    const h = harness();
    h.moveTo(at(100, 0));
    h.service.start(DESTINATION);
    h.flush();
    h.follow(0, 300);
    h.service.estimateDetours([
      { key: "a", ...at(2400, 200) },
      { key: "b", ...at(2000, 0) },
    ]);
    expect(h.snap().estimates).toEqual({});
    h.flush();
    const e = h.snap().estimates!;
    expect(e.b).toBeLessThan(30);
    expect(e.a).toBeGreaterThan(e.b!);
  });
});
