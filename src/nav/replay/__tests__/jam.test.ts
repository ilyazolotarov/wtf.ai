import { syntheticDrive } from "@/nav/__fixtures__/synthetic-drive";
import { haversineM } from "@/nav/geo";
import { jamFixes } from "@/nav/replay/jam";
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
});
