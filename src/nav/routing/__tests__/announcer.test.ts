import { Announcer, spokenDistanceM, type AnnouncerInput } from "@/nav/routing/announcer";
import type { GuidanceStep } from "@/nav/routing/guidance";
import type { Maneuver } from "@/nav/routing/maneuvers";

const m = (kind: Maneuver["kind"], atM: number): Maneuver => ({ kind, atM, lat: 51, lon: 31, turnRad: 0 });
const MANEUVERS = [m("depart", 0), m("left", 1000), m("right", 1080), m("arrive", 2000)];

/** The car at `alongM` at 10 m/s, on the route. */
function at(alongM: number, more: Partial<GuidanceStep> = {}, planId = 1): AnnouncerInput {
  const nextIndex = MANEUVERS.findIndex((x, i) => i > 0 && x.atM > alongM - 10);
  const next = MANEUVERS[nextIndex];
  const following = MANEUVERS[nextIndex + 1];
  return {
    planId,
    maneuvers: MANEUVERS,
    speedMps: 10,
    guidance: {
      state: "on",
      alongM,
      offM: 2,
      remainingM: 2000 - alongM,
      remainingS: 200 - alongM / 10,
      nextIndex,
      toNextM: Math.max(0, next.atM - alongM),
      thenIndex: following && following.atM - next.atM <= 120 ? nextIndex + 1 : null,
      passedIndex: 0,
      progressAt: { lat: 51, lon: 31 },
      ...more,
    },
  };
}

describe("Announcer", () => {
  test("each maneuver once ahead (at a spoken distance) and once at it, with the one that follows closely", () => {
    const a = new Announcer();
    const said = [];
    for (let along = 0; along <= 1100; along += 10) said.push(...a.update(at(along)));
    expect(said.map((s) => (s.kind === "maneuver" ? `${s.stage} ${s.maneuver.kind}` : s.kind))).toEqual(["prepare left", "now left", "now right"]);
    expect(said[0]).toMatchObject({ distanceM: 300 }); // max(250 m, 15 s at 10 m/s), up to the next spoken distance
    expect(said[1]).toMatchObject({ then: expect.objectContaining({ kind: "right" }) });
  });

  test("ahead of a maneuver at speed, earlier; too close to say both, only 'at it'", () => {
    const fast = new Announcer();
    // At 30 m/s, 15 s ahead is 450 m, said at 500 m: nothing at 510 m, then "in 500 m".
    expect(fast.update({ ...at(490), speedMps: 30 })).toEqual([]);
    expect(fast.update({ ...at(500), speedMps: 30 })).toEqual([expect.objectContaining({ stage: "prepare", distanceM: 500 })]);
    // The second maneuver comes 80 m after the first: no "ahead" for it, only "at it".
    const a = new Announcer();
    const said = [];
    for (let along = 1010; along <= 1080; along += 10) said.push(...a.update(at(along)));
    expect(said.map((s) => s.kind === "maneuver" && s.stage)).toEqual(["now"]);
  });

  test("a new plan says the route was planned again; arrival once; nothing while off the route", () => {
    const a = new Announcer();
    expect(a.update(at(0))).toEqual([]);
    expect(a.update(at(800, { state: "off" }))).toEqual([]);
    expect(a.update(at(0, {}, 2))).toEqual([{ kind: "replanned" }]);
    expect(a.update(at(2000, { state: "arrived" }, 2))).toEqual([{ kind: "arrived" }]);
    expect(a.update(at(2000, { state: "arrived" }, 2))).toEqual([]);
  });

  test("a maneuver already closer than the spoken distance (a route starting near it): the nearest", () => {
    const a = new Announcer();
    expect(a.update({ ...at(780), planId: 3 })).toEqual([expect.objectContaining({ stage: "prepare", distanceM: 200 })]);
  });

  test("spoken distances: the nearest step", () => {
    expect([43, 96, 260, 612, 720, 1300, 5000].map(spokenDistanceM)).toEqual([50, 100, 300, 600, 800, 1500, 2000]);
  });
});
