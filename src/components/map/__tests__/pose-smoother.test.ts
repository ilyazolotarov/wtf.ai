import { haversineM } from "@/nav/geo";
import type { PositionEstimate } from "@/nav/position/types";

import { PoseSmoother } from "../pose-smoother";

const NORTH = 0;
const M_PER_DEG_LAT = 111_320;

/** A position `northM` metres north of a fixed point, driving north at `speedMps`. */
function pos(northM: number, speedMps = 16.7, extra: Partial<PositionEstimate> = {}): PositionEstimate {
  return {
    lat: 50.43 + northM / M_PER_DEG_LAT,
    lon: 30.516,
    headingRad: NORTH,
    speedMps,
    accuracyM: 5,
    source: "fused",
    trust: "TRUSTED",
    timestamp: 1_000_000 + northM,
    ...extra,
  };
}
const northOf = (p: { lat: number }) => (p.lat - 50.43) * M_PER_DEG_LAT;

describe("PoseSmoother", () => {
  it("goes on along the heading at the speed between positions", () => {
    const s = new PoseSmoother();
    s.update(pos(0), 0);
    expect(northOf(s.at(0)!)).toBeCloseTo(0, 1);
    expect(northOf(s.at(250)!)).toBeCloseTo(16.7 / 4, 1);
    expect(northOf(s.at(500)!)).toBeCloseTo(16.7 / 2, 1);
  });

  it("closes the gap to a new position smoothly, never jumping to it", () => {
    const s = new PoseSmoother();
    s.update(pos(0), 0);
    // The navigator says the car is 2 m behind where the dot was drawn at 500 ms.
    const shownBefore = northOf(s.at(500)!);
    s.update(pos(16.7 / 2 - 2), 500);
    expect(northOf(s.at(500)!)).toBeCloseTo(shownBefore, 3);
    // A quarter of a second on, most of the gap is gone; after a second, all of it.
    const quarter = northOf(s.at(750)!) - (16.7 / 2 - 2 + 16.7 / 4);
    expect(Math.abs(quarter)).toBeLessThan(2 * 0.4);
    expect(northOf(s.at(1500)!)).toBeCloseTo(16.7 / 2 - 2 + 16.7, 0);
  });

  it("shows a snapped position at once: a placing, GNSS back after an outage", () => {
    const s = new PoseSmoother();
    s.update(pos(0), 0);
    s.update(pos(500), 500);
    expect(northOf(s.at(500)!)).toBeCloseTo(500, 1);
  });

  it("shows a sharp turn of the heading at once", () => {
    const s = new PoseSmoother();
    s.update(pos(0), 0);
    s.update(pos(8, 16.7, { headingRad: Math.PI }), 500);
    expect(s.at(500)!.headingRad).toBeCloseTo(Math.PI, 3);
  });

  it("stops going on a second after the last position", () => {
    const s = new PoseSmoother();
    s.update(pos(0), 0);
    expect(haversineM(s.at(1000)!, s.at(5000)!)).toBeLessThan(0.01);
  });

  it("leaves standing, crawling and driver-set positions alone", () => {
    const s = new PoseSmoother();
    s.update(pos(0, 1), 0);
    expect(s.at(500)).toBeNull();
    s.update(pos(0, 16.7, { source: "manual" }), 600);
    expect(s.at(900)).toBeNull();
    s.update(pos(0, 16.7, { headingRad: undefined }), 1000);
    expect(s.at(1200)).toBeNull();
  });
});
