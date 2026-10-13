import { WheelYawCalibrator } from "../wheel-yaw-calibration";

/** 10 Hz samples of a car with this track and tyre difference, at these speeds and yaw rates (a gentle weave). */
function drive(cal: WheelYawCalibrator, trackM: number, tyre: number, seconds: number, gyro: (t: number, yaw: number) => number | null = (_t, y) => y) {
  const verdicts: boolean[] = [];
  for (let i = 0; i < seconds * 10; i++) {
    const t = i / 10;
    const speed = 8 + 6 * Math.sin(t / 40);
    const yaw = 0.15 * Math.sin(t / 7);
    const diff = trackM * yaw + tyre * speed;
    const v = cal.push(t * 1e6, speed - diff / 2, speed + diff / 2, gyro(t, yaw), false);
    if (v !== null) verdicts.push(v);
  }
  return verdicts;
}

describe("wheel yaw calibration", () => {
  // 2026-10-13: the right rear read slow by 0.025–0.119 % over two days; 0.55 °/s of turning that isn't at 46 km/h.
  test("learns the tyres' difference over 5 s stretches while the gyro agrees; the track stays the car's", () => {
    const cal = new WheelYawCalibrator();
    const verdicts = drive(cal, 1.6, -0.0008, 1200);
    expect(verdicts.length).toBeGreaterThan(200);
    expect(verdicts.every(Boolean)).toBe(true);
    const c = cal.calibration;
    expect(c.tyre).toBeCloseTo(-0.0008, 4);
    expect(c.trackM).toBeCloseTo(1.6, 2);
    // The wheels then read the yaw itself: 0.1 rad/s at 15 m/s.
    expect(cal.yaw(1.6 * 0.1 - 0.0008 * 15, 15)).toBeCloseTo(0.1, 3);
  });

  test("a gyro that turns on its own (the phone moves) is out of step over a stretch: nothing learned", () => {
    const cal = new WheelYawCalibrator();
    const before = cal.calibration;
    const verdicts = drive(cal, 1.6, -0.0008, 120, (t, yaw) => yaw + 0.5 * Math.sin(t * 0.7));
    expect(verdicts.filter((v) => !v).length).toBeGreaterThan(verdicts.length / 2);
    expect(Math.abs(cal.calibration.tyre - before.tyre)).toBeLessThan(0.0003);
  });

  test("standing, reversing or without a gyro: no stretch", () => {
    const cal = new WheelYawCalibrator();
    for (let i = 0; i < 100; i++) {
      expect(cal.push(i * 100_000, 0, 0, 0, false)).toBeNull();
      expect(cal.push(i * 100_000, 5, 5.1, 0.06, true)).toBeNull();
      expect(cal.push(i * 100_000, 5, 5.1, null, false)).toBeNull();
    }
  });
});
