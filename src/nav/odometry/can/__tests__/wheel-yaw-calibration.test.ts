import { WheelYawCalibrator } from "../wheel-yaw-calibration";

/** 10 Hz samples of a car with this track and tyre difference, at these speeds and yaw rates (a gentle weave). */
function drive(cal: WheelYawCalibrator, trackM: number, tyre: number, seconds: number, gyro: (t: number, yaw: number) => number | null = (_t, y) => y) {
  const verdicts: (boolean | null)[] = [];
  for (let i = 0; i < seconds * 10; i++) {
    const t = i / 10;
    const speed = 8 + 6 * Math.sin(t / 40);
    const yaw = 0.15 * Math.sin(t / 7);
    const diff = trackM * yaw + tyre * speed;
    verdicts.push(cal.push(t * 1e6, speed - diff / 2, speed + diff / 2, gyro(t, yaw), false));
  }
  return verdicts;
}

describe("wheel yaw calibration", () => {
  test("learns the track and the tyres' difference while the gyro agrees", () => {
    const cal = new WheelYawCalibrator();
    drive(cal, 1.62, 0.0004, 1200);
    const c = cal.calibration;
    expect(c.trackM).toBeCloseTo(1.62, 2);
    expect(c.tyre).toBeCloseTo(0.0004, 4);
    // The wheels then read the yaw itself: 0.1 rad/s at 15 m/s.
    expect(cal.yaw(1.62 * 0.1 + 0.0004 * 15, 15)).toBeCloseTo(0.1, 3);
  });

  test("a gyro that turns on its own (the phone moves) teaches nothing and says so", () => {
    const cal = new WheelYawCalibrator();
    const before = cal.calibration;
    const verdicts = drive(cal, 1.62, 0, 60, (t, yaw) => yaw + 0.5 * Math.sin(t * 3));
    expect(verdicts.filter((v) => v === false).length).toBeGreaterThan(verdicts.length / 2);
    expect(Math.abs(cal.calibration.trackM - before.trackM)).toBeLessThan(0.02);
  });

  test("standing, reversing or without a gyro: no verdict", () => {
    const cal = new WheelYawCalibrator();
    expect(cal.push(0, 0, 0, 0, false)).toBeNull();
    expect(cal.push(0, 5, 5.1, 0.06, true)).toBeNull();
    expect(cal.push(0, 5, 5.1, null, false)).toBeNull();
  });
});
