import { appOutageCuts } from "@/nav/replay/replay";
import type { TripLog } from "@/triplog/trip-log-reader";

const START_US = 5_000_000;

function trip(notes: [number, string][]): TripLog {
  return {
    startUs: START_US,
    info: {},
    imu: [],
    mag: [],
    obdSpeed: [],
    gnss: [],
    engine: [],
    rpm: [],
    events: [],
    timeSync: [],
    messages: notes.map(([tS, text]) => ({ tUs: START_US + tS * 1e6, tag: "app", text })),
    navEstimate: [],
    navMapMatch: [],
    navRoute: [],
    navRoutePoints: [],
    navRouteManeuvers: [],
    navRouteProgress: [],
    truncated: false,
  };
}

describe("appOutageCuts", () => {
  test("pairs the app's outage notes into cuts; one still on runs to the end", () => {
    const cuts = appOutageCuts(
      trip([
        [10, "nav mode dr (course)"],
        [60, "sim gnss outage on"],
        [180, "sim gnss outage off: 120 s, 1.50 km, dot 12 m from GPS (max 20 m)"],
        [300, "sim gnss outage on"],
      ]),
    );
    expect(cuts).toEqual([
      { fromS: 60, toS: 180 },
      { fromS: 300, toS: Infinity },
    ]);
  });

  test("no notes, no cuts", () => {
    expect(appOutageCuts(trip([[5, "gnss trust TRUSTED (±5 m)"]]))).toEqual([]);
  });
});
