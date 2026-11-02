import type { TripLog } from "../../../src/triplog/trip-log-reader";
import { tripStopsAt } from "../app-chain";

const S = 1e6;
type Plan = TripLog["navRoute"][number];
type Stop = NonNullable<TripLog["navRouteStops"]>[number];

const plan = (planId: number, tS: number, status: Plan["status"] = "done") =>
  ({ tUs: tS * S, planId, reason: "new", status, toLatDeg: 50.5, toLonDeg: 30.6 }) as Plan;
const stop = (planId: number, tS: number, index: number, lat: number, lon: number) =>
  ({ tUs: tS * S, planId, index, latDeg: lat, lonDeg: lon, atM: 0, atS: 0, side: "none", category: "none" }) as Stop;
const note = (tS: number, text: string) => ({ tUs: tS * S, tag: "app", text });

function trip(over: Partial<TripLog>): TripLog {
  return {
    startUs: 0, info: {}, imu: [], mag: [], obdSpeed: [], gnss: [], engine: [], rpm: [], events: [], timeSync: [], messages: [], navEstimate: [], navMapMatch: [], navRoute: [], navRoutePoints: [], navRouteManeuvers: [], navRouteProgress: [], truncated: false,
    ...over,
  };
}

const where = (s: { lat: number; lon: number }) => [s.lat, s.lon];

describe("tripStopsAt", () => {
  // A reached and X passed before the first logged plan (#3, made when C was added); B reached after it.
  const log = trip({
    navRoute: [plan(2, 95, "no-route"), plan(3, 100), plan(4, 300)],
    navRouteStops: [stop(3, 100, 1, 50.47, 30.57), stop(3, 100, 0, 50.46, 30.56), stop(4, 300, 0, 50.47, 30.57)],
    messages: [
      note(5, "route stop reached: A (50.44000,30.54000) at 1.20 km"),
      note(20, "route plan #1 (new): 9.00 km, 15 min, 12 maneuvers, 3 stops"),
      note(50, "route stop passed: Pharmacy (24/7) (50.45000,30.55000), 140 m from it at the closest"),
      note(90, "route stop added: C (50.47000,30.57000), 2 of 2, +3 min"),
      note(150, "route stop reached: B (50.46000,30.56000) at 3.40 km"),
      note(200, "route stop left: B (50.46000,30.56000), next leg"),
    ],
  });

  test("in a plan's time: its stops in order, less those reached or passed since", () => {
    expect(tripStopsAt(log, 120 * S).map(where)).toEqual([[50.46, 30.56], [50.47, 30.57]]);
    expect(tripStopsAt(log, 150 * S).map(where)).toEqual([[50.47, 30.57]]);
    expect(tripStopsAt(log, 400 * S).map(where)).toEqual([[50.47, 30.57]]);
  });

  test("before the first plan: those reached or passed until it in front, in order, without those added", () => {
    expect(tripStopsAt(log, 0).map(where)).toEqual([[50.44, 30.54], [50.45, 30.55], [50.46, 30.56]]);
    expect(tripStopsAt(log, 30 * S).map(where)).toEqual([[50.45, 30.55], [50.46, 30.56]]);
    expect(tripStopsAt(log, 60 * S).map(where)).toEqual([[50.46, 30.56]]);
  });

  test("a stop's key is its point, as the notes name it", () => {
    expect(tripStopsAt(log, 0).map((s) => s.key)).toEqual(["50.44000,30.54000", "50.45000,30.55000", "50.46000,30.56000"]);
  });

  test("removed and moved before the first plan: back where they were; after a plan: as the notes say", () => {
    const changed = trip({
      navRoute: [plan(3, 100)],
      navRouteStops: [stop(3, 100, 0, 50.46, 30.56), stop(3, 100, 1, 50.45, 30.55)],
      messages: [
        note(10, "route stop removed: X (50.44000,30.54000), 2 of 3"),
        note(20, "route stop moved: A (50.45000,30.55000), 2 of 2 (was 1)"),
        note(150, "route stop moved: A (50.45000,30.55000), 1 of 2 (was 2)"),
        note(160, "route stop added: C (50.47000,30.57000), 3 of 3"),
        note(170, "route stop removed: B (50.46000,30.56000), 2 of 3"),
      ],
    });
    expect(tripStopsAt(changed, 0).map(where)).toEqual([[50.45, 30.55], [50.44, 30.54], [50.46, 30.56]]);
    expect(tripStopsAt(changed, 15 * S).map(where)).toEqual([[50.45, 30.55], [50.46, 30.56]]);
    expect(tripStopsAt(changed, 155 * S).map(where)).toEqual([[50.45, 30.55], [50.46, 30.56]]);
    expect(tripStopsAt(changed, 200 * S).map(where)).toEqual([[50.45, 30.55], [50.47, 30.57]]);
  });

  test("two stops at one point: one reached, the other still ahead, with keys of their own", () => {
    const twice = trip({
      navRoute: [plan(1, 10)],
      navRouteStops: [stop(1, 10, 0, 50.46, 30.56), stop(1, 10, 1, 50.47, 30.57), stop(1, 10, 2, 50.46, 30.56)],
      messages: [note(50, "route stop reached: B (50.46000,30.56000) at 2.00 km")],
    });
    expect(tripStopsAt(twice, 20 * S).map((s) => s.key)).toEqual(["50.46000,30.56000", "50.47000,30.57000", "50.46000,30.56000#2"]);
    expect(tripStopsAt(twice, 60 * S).map(where)).toEqual([[50.47, 30.57], [50.46, 30.56]]);
  });

  test("no stops without them in the log, or without a plan", () => {
    expect(tripStopsAt(trip({ navRoute: [plan(1, 10)] }), 0)).toEqual([]);
    expect(tripStopsAt(trip({ messages: log.messages }), 0)).toEqual([]);
  });
});
