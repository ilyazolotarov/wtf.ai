import { at, frame, ladder } from "@/nav/routing/__fixtures__/ladder";
import { AlternativeSearch, edgeSet, labelPoint, planAlternatives, sharedM } from "@/nav/routing/alternatives";
import { planRoute, type RoutePlan } from "@/nav/routing/router";

const from = { ...at(0, 0), headingRad: Math.PI / 2 };
const to = at(2200, 0);

function plans() {
  const g = ladder();
  const main = planRoute(g, frame, from, to);
  if (main.status !== "done") throw new Error(main.status);
  return { g, main: main.plan, ...planAlternatives(g, frame, from, to, main.plan) };
}
const minNorth = (p: RoutePlan) => Math.min(...p.coordinates.map((c) => frame.toEnu(c)[1]));

describe("alternative routes", () => {
  test("the north branch first, the south one as the alternative; not the bypass, not the far loop", () => {
    const { g, main, alternatives, stats } = plans();
    expect(minNorth(main)).toBeGreaterThan(-1);
    expect(alternatives).toHaveLength(1);
    const alt = alternatives[0];
    expect(minNorth(alt)).toBeCloseTo(-400, -1);
    expect(alt.durationS).toBeGreaterThan(main.durationS);
    expect(alt.durationS).toBeLessThan(1.3 * main.durationS);
    expect(sharedM(g, alt, edgeSet(main)) / alt.lengthM).toBeLessThan(0.1);
    // The bypass and the far loop came up and were turned down, within the search budget.
    expect(stats.searches).toBeLessThanOrEqual(3);
  });

  test("an avoid factor slows those roads in the search, never in the plan's time", () => {
    const g = ladder();
    const main = planRoute(g, frame, from, to);
    if (main.status !== "done") throw new Error(main.status);
    const avoided = planRoute(g, frame, from, to, { avoid: new Map(main.plan.legs.map((l) => [l.edge, 1.01])) });
    if (avoided.status !== "done") throw new Error(avoided.status);
    // 1 % slower is not enough to leave the north branch, and the time reported is unchanged.
    expect(avoided.plan.legs.map((l) => l.edge)).toEqual(main.plan.legs.map((l) => l.edge));
    expect(avoided.plan.durationS).toBeCloseTo(main.plan.durationS, 6);
  });

  test("the label sits on the alternative's own stretch", () => {
    const { g, main, alternatives } = plans();
    const [e, n] = frame.toEnu(labelPoint(g, alternatives[0], [edgeSet(main)]));
    expect(n).toBeCloseTo(-400, -1);
    expect(e).toBeCloseTo(1100, -2);
  });

  test("slower than allowed: no alternative, and no search after it", () => {
    const g = ladder();
    const main = planRoute(g, frame, from, to);
    if (main.status !== "done") throw new Error(main.status);
    const r = planAlternatives(g, frame, from, to, main.plan, {}, { maxSlower: 1.05 });
    expect(r.alternatives).toEqual([]);
    expect(r.stats.searches).toBe(1);
  });

  test("a route turned down as too shared is slowed too: the next search goes elsewhere, not the same way again", () => {
    const g = ladder();
    const main = planRoute(g, frame, from, to);
    if (main.status !== "done") throw new Error(main.status);
    // 15 % slower, the north branch is still the fastest (the south one wins from ~21 %): the first search finds the
    // route itself again. Slowed twice, the south one.
    const r = planAlternatives(g, frame, from, to, main.plan, {}, { penalty: 1.15 });
    expect(r.alternatives.map((a) => Math.round(minNorth(a)))).toContain(-400);
    expect(r.stats.searches).toBeGreaterThanOrEqual(2);
  });

  test("each alternative is returned as soon as it is kept, the search going on", () => {
    const g = ladder();
    const main = planRoute(g, frame, from, to);
    if (main.status !== "done") throw new Error(main.status);
    const search = new AlternativeSearch(g, frame, from, to, main.plan);
    const first = search.run();
    expect(first.status).toBe("more");
    expect(first.alternatives).toHaveLength(1);
    const r = search.run();
    expect(r.status).toBe("done");
    expect(r.alternatives[0]).toBe(first.alternatives[0]);
  });

  test("runs in slices: a small budget returns `more` until it is done", () => {
    const g = ladder();
    const main = planRoute(g, frame, from, to);
    if (main.status !== "done") throw new Error(main.status);
    const search = new AlternativeSearch(g, frame, from, to, main.plan);
    let slices = 0;
    let r = search.run(3);
    while (r.status === "more") {
      slices++;
      r = search.run(3);
    }
    expect(slices).toBeGreaterThan(1);
    expect(r.alternatives).toHaveLength(1);
  });
});
