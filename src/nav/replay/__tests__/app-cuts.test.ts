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

  test("an outage already on when the log began runs from its start", () => {
    const cuts = appOutageCuts(
      trip([
        [2, "nav storage {}"],
        [148, "sim gnss outage off: 179 s, 0.94 km, dot 118766 m from GPS (max 118802 m)"],
        [200, "sim gnss outage on"],
      ]),
    );
    expect(cuts).toEqual([
      { fromS: 0, toS: 148 },
      { fromS: 200, toS: Infinity },
    ]);
  });

  test("the outage noted again at a trip's start is one cut", () => {
    expect(appOutageCuts(trip([[2, "sim gnss outage on"]]))).toEqual([{ fromS: 2, toS: Infinity }]);
  });

  test("no notes, no cuts", () => {
    expect(appOutageCuts(trip([[5, "gnss trust TRUSTED (±5 m)"]]))).toEqual([]);
  });
});
