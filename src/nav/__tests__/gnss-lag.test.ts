import { syntheticDrive, type DriveSegment } from "@/nav/__fixtures__/synthetic-drive";
import { similarityResidual } from "@/nav/calibration/gnss-lag";
import { replayTrip } from "@/nav/replay/replay";

/** City driving: straights and 90° turns, alternating left and right. */
function cityDrive(turns: number): DriveSegment[] {
  const segments: DriveSegment[] = [{ durationS: 10, speedMps: 12, yawRateDegS: 0 }];
  for (let i = 0; i < turns; i++) {
    segments.push({ durationS: 15, speedMps: 12, yawRateDegS: 0 });
    segments.push({ durationS: 6, speedMps: 8, yawRateDegS: i % 2 ? -15 : 15 });
    segments.push({ durationS: 4, speedMps: 12, yawRateDegS: 0 });
  }
  segments.push({ durationS: 20, speedMps: 12, yawRateDegS: 0 });
  return segments;
}

describe("GNSS lag estimate", () => {
  test.each([0, 0.6])("finds a %s s CoreLocation lag from turns", (lag) => {
    const drive = syntheticDrive({ segments: cityDrive(6), gnss: "clean", gnssLagS: lag, seed: 3 });
    const { gnssLag } = replayTrip(drive.trip).summary;
    expect(gnssLag).not.toBeNull();
    expect(gnssLag!.windows).toBeGreaterThanOrEqual(6);
    expect(Math.abs(gnssLag!.lagS - lag)).toBeLessThanOrEqual(0.1);
  });

  test("a straight road says nothing about the lag", () => {
    const drive = syntheticDrive({ segments: [{ durationS: 300, speedMps: 15, yawRateDegS: 0 }], gnss: "clean" });
    expect(replayTrip(drive.trip).summary.gnssLag).toBeNull();
  });

  test("coarse (Wi-Fi) fixes are not used", () => {
    const drive = syntheticDrive({ segments: cityDrive(6), gnss: "coarse" });
    expect(replayTrip(drive.trip).summary.gnssLag).toBeNull();
  });

  test("the measured lag is used, and a fixed one can switch it off", () => {
    const drive = syntheticDrive({ segments: cityDrive(10), gnss: "clean", gnssLagS: 0.6, seed: 5 });
    const opts = { cuts: [{ fromS: 180, toS: 240 }], truthLagS: 0.6 };
    const fixed = replayTrip(drive.trip, { ...opts, nav: { gnssLagS: 0, estimateGnssLag: false } }).summary;
    const online = replayTrip(drive.trip, { ...opts, nav: { gnssLagS: 0 } }).summary;
    expect(fixed.gnssLag).not.toBeNull(); // still measured and reported…
    // …but only used when estimation is on: a 0.6 s error at 12 m/s puts the DR start ~7 m behind.
    expect(online.cuts[0].maxErrorM!).toBeLessThan(fixed.cuts[0].maxErrorM! - 3);
  });

  test("similarity fit ignores rotation, translation and scale", () => {
    const a: [number, number][] = [[0, 0], [10, 0], [10, 5], [3, 8]];
    const th = 1.1;
    const b = a.map(([x, y]): [number, number] => [1.02 * (Math.cos(th) * x - Math.sin(th) * y) + 40, 1.02 * (Math.sin(th) * x + Math.cos(th) * y) - 7]);
    expect(similarityResidual(a, b)).toBeCloseTo(0, 6);
    expect(similarityResidual(a, [[0, 0], [10, 0], [10, 5], [3, 9]])).toBeGreaterThan(0.1);
  });
});
