import type { RouteService, RouteSnapshot } from "@/services/navigation/route-service";

import { addStopWithUndo, offerRouteUndo, tripUndo } from "../trip-undo";

function fakeRoutes(full = false) {
  const calls: string[] = [];
  const routes = {
    addStop: (s: { key?: string; name?: string }) => (calls.push(`add ${s.name} ${s.key}`), !full),
    removeStop: (key: string) => void calls.push(`remove ${key}`),
    start: (d: { name?: string }, o: { stops: { name?: string }[] }) => void calls.push(`start ${d.name} via ${o.stops.map((s) => s.name).join(",")}`),
  } as unknown as RouteService;
  return { routes, calls };
}

const before = (status: RouteSnapshot["status"]) =>
  ({ status, destination: { lat: 50, lon: 30, name: "Old" }, stops: [{ key: "s1", lat: 50.1, lon: 30.1, name: "Fuel" }] }) as unknown as RouteSnapshot;

describe("a trip change in one tap, with Undo (STOPS-SPEC §7.4)", () => {
  afterEach(() => tripUndo.clear());

  test("a stop added at once; Undo takes that stop out again, and the offer goes", () => {
    const { routes, calls } = fakeRoutes();
    expect(addStopWithUndo(routes, { lat: 50, lon: 30, name: "Pin" })).toBe(true);
    const offer = tripUndo.getSnapshot()!;
    expect(offer).toMatchObject({ kind: "stop", name: "Pin" });
    const key = calls[0].split(" ")[2];
    tripUndo.take();
    expect(calls[1]).toBe(`remove ${key}`);
    expect(tripUndo.getSnapshot()).toBeNull();
  });

  test("no stop added (five already): nothing to undo", () => {
    const { routes } = fakeRoutes(true);
    expect(addStopWithUndo(routes, { lat: 50, lon: 30, name: "Pin" })).toBe(false);
    expect(tripUndo.getSnapshot()).toBeNull();
  });

  test("a route replaced: Undo plans the old trip again, with the stops it hadn't reached", () => {
    const { routes, calls } = fakeRoutes();
    offerRouteUndo(routes, before("active"), "New place");
    expect(tripUndo.getSnapshot()).toMatchObject({ kind: "route", name: "New place" });
    tripUndo.take();
    expect(calls).toEqual(["start Old via Fuel"]);
  });

  test("nothing replaced (no route, or a failed one): no offer; an old offer's timer doesn't end a newer one", () => {
    const { routes } = fakeRoutes();
    offerRouteUndo(routes, null, "A");
    offerRouteUndo(routes, before("failed"), "A");
    expect(tripUndo.getSnapshot()).toBeNull();
    offerRouteUndo(routes, before("active"), "A");
    const first = tripUndo.getSnapshot()!.id;
    offerRouteUndo(routes, before("active"), "B");
    tripUndo.clear(first);
    expect(tripUndo.getSnapshot()?.name).toBe("B");
  });
});
