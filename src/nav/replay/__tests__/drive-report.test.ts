import { driveOutages, noGpsWindows, scoreOutage, trackAt, type ShownPoint, type TruthFix } from "@/nav/replay/drive-report";
import type { GnssFix } from "@/nav/types";
import type { TripLog } from "@/triplog/trip-log-reader";

const START_US = 1_000_000;
const LAT = 51.5;
const LON = 30.75;
/** Metres north of the start → latitude. */
const north = (m: number) => LAT + m / 111_195;

// A car driving north at 10 m/s for 300 s; clean fixes every second except 100–160 s (jammed).
function trip(): TripLog {
  const gnss: GnssFix[] = [];
  const obdSpeed = [];
  for (let s = 0; s <= 300; s++) {
    if (s < 100 || s > 160) gnss.push({ tUs: START_US + s * 1e6, lat: north(10 * s), lon: LON, hAccM: 5, speedMps: 10 });
    obdSpeed.push({ tUs: START_US + s * 1e6, speedMps: 10, rawKph: 36 });
  }
  return {
    startUs: START_US, info: {}, imu: [], mag: [], obdSpeed, gnss, engine: [], rpm: [], events: [], timeSync: [],
    messages: [], navEstimate: [], navMapMatch: [], navRoute: [], navRoutePoints: [], navRouteManeuvers: [], navRouteProgress: [], truncated: false,
  };
}

/** A track along the true path, `offsetM` metres east from `fromS` on, with radius `acc`. */
function track(offsetM: number, fromS: number, acc: number): ShownPoint[] {
  return Array.from({ length: 601 }, (_, i) => {
    const t = i * 0.5;
    const east = t >= fromS ? offsetM : 0;
    return { t, lat: north(10 * t), lon: LON + east / (111_195 * Math.cos((LAT * Math.PI) / 180)), acc };
  });
}

describe("drive report", () => {
  test("a gap between clean fixes is a real outage; the first fix after it scores the dot", () => {
    const outages = driveOutages(trip(), 300, [], { phone: track(20, 100, 10) });
    expect(outages).toHaveLength(1);
    const o = outages[0];
    expect(o).toMatchObject({ kind: "no-gps", fromS: 99, toS: 161 });
    expect(o.distanceM).toBeCloseTo(620, -1);
    // No fix inside a real outage: only the one after it.
    expect(o.scores.phone).toMatchObject({ truthFixes: 0, maxErrorM: null, afterInside: false });
    // From the dot half a second before that fix (the track before it used it): 5 m behind, 20 m east.
    expect(o.scores.phone!.afterErrorM).toBeCloseTo(Math.hypot(20, 5), 1);
  });

  test("a cut window is scored on the fixes withheld in it, inside the circle or not", () => {
    const truth: TruthFix[] = Array.from({ length: 301 }, (_, s) => ({ t: s, lat: north(10 * s), lon: LON }));
    const score = scoreOutage(track(8, 50, 10), truth, { kind: "app-cut", fromS: 40, toS: 80 })!;
    expect(score.truthFixes).toBe(40);
    expect(score.maxErrorM).toBeCloseTo(8, 0);
    // 10 of the 40 fixes before the offset starts at 50 s are on the dot; all within its 10 m radius.
    expect(score.insideShare).toBe(1);
    const tight = scoreOutage(track(8, 50, 5), truth, { kind: "app-cut", fromS: 40, toS: 80 })!;
    expect(tight.insideShare).toBeCloseTo(10 / 40, 5);
  });

  test("short gaps, and outages where the car hardly moved, are left out", () => {
    const truth: TruthFix[] = [{ t: 0, lat: LAT, lon: LON }, { t: 10, lat: LAT, lon: LON }, { t: 100, lat: LAT, lon: LON }];
    expect(noGpsWindows(truth, 105)).toEqual([{ kind: "no-gps", fromS: 10, toS: 100 }]);
    const parked = trip();
    parked.obdSpeed = parked.obdSpeed.map((s) => ({ ...s, speedMps: 0, rawKph: 0 }));
    expect(driveOutages(parked, 300, [], {})).toEqual([]);
  });

  test("the track is interpolated, and missing across its own gaps", () => {
    const t: ShownPoint[] = [{ t: 0, lat: 0, lon: 0, acc: 4 }, { t: 1, lat: 0, lon: 1, acc: 6 }, { t: 10, lat: 0, lon: 2, acc: 6 }];
    expect(trackAt(t, 0.5)).toMatchObject({ lon: 0.5, acc: 5 });
    expect(trackAt(t, 5)).toBeNull();
    expect(trackAt(t, -1)).toBeNull();
  });
});
