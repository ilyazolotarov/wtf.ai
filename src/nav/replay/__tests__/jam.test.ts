import { syntheticDrive } from "@/nav/__fixtures__/synthetic-drive";
import { haversineM } from "@/nav/geo";
import { jamFixes, MEASURED_JAM_ARRIVALS } from "@/nav/replay/jam";
import { isSatelliteFix } from "@/nav/types";

describe("jamFixes (simulated jamming for replay)", () => {
  const drive = syntheticDrive({
    segments: [
      { durationS: 5, speedMps: 10, yawRateDegS: 0 },
      { durationS: 600, speedMps: 10, yawRateDegS: 2 },
    ],
    gnss: "clean",
  });
  const { gnss, startUs } = drive.trip;
  const jammed = jamFixes(gnss, startUs, [{ fromS: 100, toS: 400 }]);
  const tS = (tUs: number) => (tUs - startUs) / 1e6;

  test("outside the window the fixes are untouched", () => {
    expect(jammed.filter((f) => tS(f.tUs) < 100)).toEqual(gnss.filter((f) => tS(f.tUs) < 100));
    expect(jammed.filter((f) => tS(f.tUs) >= 400)).toEqual(gnss.filter((f) => tS(f.tUs) >= 400));
  });

  test("inside it: Wi-Fi-like fixes every 5–10 s, some repeated, tens of metres off", () => {
    const inside = jammed.filter((f) => tS(f.tUs) >= 100 && tS(f.tUs) < 400);
    expect(inside.every((f) => !isSatelliteFix(f) && f.speedMps === undefined && f.courseRad === undefined && f.hAccM === 65)).toBe(true);
    const gaps = inside.slice(1).map((f, k) => tS(f.tUs) - tS(inside[k].tUs));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(5);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(11);
    const repeats = inside.slice(1).filter((f, k) => f.lat === inside[k].lat && f.lon === inside[k].lon).length;
    expect(repeats).toBeGreaterThan(0);
    const errors = inside.map((f) => haversineM(f, drive.truthAt(f.tUs))).sort((a, b) => a - b);
    const median = errors[Math.floor(errors.length / 2)];
    expect(median).toBeGreaterThan(20);
    expect(median).toBeLessThan(150);
  });

  test("the same seed gives the same fixes", () => {
    expect(jamFixes(gnss, startUs, [{ fromS: 100, toS: 400 }])).toEqual(jammed);
  });

  test("measured arrivals: Wi-Fi fixes in bursts with long gaps, and cell fixes kilometres wide besides", () => {
    const long = syntheticDrive({ segments: [{ durationS: 3605, speedMps: 10, yawRateDegS: 1 }], gnss: "clean" });
    const fixes = jamFixes(long.trip.gnss, long.trip.startUs, [{ fromS: 0, toS: Infinity }], MEASURED_JAM_ARRIVALS);
    const wifi = fixes.filter((f) => f.hAccM <= 100);
    const cells = fixes.filter((f) => f.hAccM > 100);
    // 1.85 and 4.06 a minute on the real jammed drives.
    expect(wifi.length / 60).toBeGreaterThan(1);
    expect(wifi.length / 60).toBeLessThan(3.5);
    expect(cells.length / 60).toBeGreaterThan(3);
    expect(cells.length / 60).toBeLessThan(5.5);
    const gaps = wifi.slice(1).map((f, k) => (f.tUs - wifi[k].tUs) / 1e6).sort((a, b) => a - b);
    expect(gaps[Math.floor(gaps.length / 2)]).toBeLessThan(10);
    expect(gaps.at(-1)!).toBeGreaterThan(60);
    const cellErrors = cells.map((f) => haversineM(f, long.truthAt(f.tUs)) / f.hAccM).sort((a, b) => a - b);
    expect(cellErrors[Math.floor(cellErrors.length / 2)]).toBeLessThan(0.5);
    expect(fixes.every((f) => !isSatelliteFix(f))).toBe(true);
  });
});
