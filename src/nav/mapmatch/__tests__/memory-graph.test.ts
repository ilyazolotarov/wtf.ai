import { LocalFrame } from "@/nav/geo/local-frame";
import { RoadClass } from "@/nav/mapmatch/graph/format";
import { MemoryRoadGraph } from "@/nav/mapmatch/graph/memory-graph";
import { routeManeuvers } from "@/nav/routing/maneuvers";
import { planRoute } from "@/nav/routing/router";

// A plus-shaped junction, 200 m arms: a primary road north–south, a residential one west–east.
const frame = new LocalFrame({ lat: 50.45, lon: 30.52 });
const at = (e: number, n: number) => frame.toCoordinate(e, n);
const graph = () =>
  new MemoryRoadGraph(frame, [
    { cls: RoadClass.primary, points: [at(0, -200), at(0, 0), at(0, 200)] },
    { cls: RoadClass.residential, points: [at(-200, 0), at(0, 0), at(200, 0)] },
  ]);

describe("MemoryRoadGraph", () => {
  test("splits ways at shared vertices: four edges meet at the junction", () => {
    const g = graph();
    const near = g.edgesNear(0, -100, 10);
    expect(near).toHaveLength(1);
    const junction = g.node(near[0].edge.to);
    expect(junction.edges).toHaveLength(4);
    expect(near[0].edge.lengthM).toBeCloseTo(200, 0);
  });

  test("exits after driving north: right turn east is positive, left west negative, straight about 0", () => {
    const g = graph();
    const south = g.edgesNear(0, -100, 10)[0].edge;
    const exits = g.exits(south.id, 1);
    const turnTo = (e: number, n: number) => {
      const target = g.edgesNear(e, n, 10)[0].edge.id;
      return exits.find((x) => x.edge === target)!.turnRad;
    };
    expect(turnTo(100, 0)).toBeCloseTo(Math.PI / 2, 2);
    expect(turnTo(-100, 0)).toBeCloseTo(-Math.PI / 2, 2);
    expect(turnTo(0, 100)).toBeCloseTo(0, 2);
  });

  test("the real router plans on it, and the maneuvers say turn right", () => {
    const g = graph();
    const result = planRoute(g, frame, { ...at(0, -150), headingRad: 0 }, at(150, 5));
    if (result.status !== "done") throw new Error(`no route: ${result.reason}`);
    expect(result.plan.lengthM).toBeCloseTo(300, -1);
    const kinds = routeManeuvers(g, result.plan).map((m) => m.kind);
    expect(kinds).toEqual(["depart", "right", "arrive"]);
  });
});
