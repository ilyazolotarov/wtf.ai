import type { ImuSample } from "../../../types";
import type { CanSpeedSample } from "../can-speed";
import { WHEEL_LAG_US, WheelYawSource } from "../wheel-yaw-source";

const wheels = (tUs: number, yaw: number, speed = 10, tyre = 0, reverse = false): CanSpeedSample => {
  const diff = 1.6 * yaw + tyre * speed;
  return { tUs, speedMps: speed, wheelsMps: [speed, speed, speed - diff / 2, speed + diff / 2], gear: reverse ? "R" : "D", reverse };
};
// A phone lying on its back, tilted: "up" is its +z turned a little about x.
const tilt = 0.3;
const gravity: [number, number, number] = [0, 9.81 * Math.sin(tilt), -9.81 * Math.cos(tilt)];
const imu = (tUs: number, gyroYaw: number): ImuSample => {
  const up = [0, -Math.sin(tilt), Math.cos(tilt)];
  return { tUs, gyro: [up[0] * gyroYaw, up[1] * gyroYaw, up[2] * gyroYaw], gravity, userAccel: [0, 0, 0] };
};

describe("turning from the wheels (NAVIGATOR-SPEC §5.4)", () => {
  test("the IMU sample as the car's: the wheels' yaw about a vertical up, whatever the phone does; none where no wheel sample is near", () => {
    const src = new WheelYawSource();
    for (let t = 0; t <= 2_000_000; t += 100_000) src.addWheels(wheels(t + WHEEL_LAG_US, 0.2));
    // The phone tilted and turning on its own (a pocket): 1 rad/s that the car doesn't.
    const out = src.substitute(imu(1_000_000, 1))!;
    expect(WheelYawSource.gyroYaw(out)).toBeCloseTo(0.2, 6);
    // Its tilt left out: its movements don't read as handling.
    expect(out.gravity).toEqual([0, 0, -9.81]);
    // A break in listening: still the car's frame (no gravity jump to read as handling), the phone's own turning.
    const gap = new WheelYawSource();
    gap.addWheels(wheels(0, 0.2));
    gap.addWheels(wheels(900_000, 0.2));
    const inGap = gap.substitute(imu(450_000, 1))!;
    expect(inGap.gravity).toEqual([0, 0, -9.81]);
    expect(WheelYawSource.gyroYaw(inGap)).toBeCloseTo(1, 6);
    // No wheel sample within a second: the phone's sample as it is.
    expect(src.substitute(imu(5_000_000, 1))).toBeNull();
  });

  test("in reverse the wheels' difference turns the car the other way", () => {
    const src = new WheelYawSource();
    for (let t = 0; t <= 1_000_000; t += 100_000) src.addWheels(wheels(t, 0.2, 2, 0, true));
    expect(src.yawAt(500_000)).toBeCloseTo(-0.2, 6);
  });

  test("learns the tyres' difference from the gyro in time order, and the wheels read the car's turning with it", () => {
    const src = new WheelYawSource();
    const tyre = -0.001;
    for (let k = 0; k < 6000; k++) {
      const t = k * 100_000;
      const yaw = 0.15 * Math.sin(t / 7e6);
      for (let j = 0; j < 10; j++) src.addGyro(t - WHEEL_LAG_US + j * 10_000, yaw);
      const s = wheels(t, yaw, 12, tyre);
      src.addWheels(s);
      src.learn(s);
    }
    expect(src.calibration.tyre).toBeCloseTo(tyre, 4);
    // Straight at 12 m/s: the tyres alone read 0.0075 rad/s; learned, the wheels say straight.
    src.addWheels(wheels(700_000_000, 0, 12, tyre));
    expect(Math.abs(src.yawAt(700_000_000 - WHEEL_LAG_US)!)).toBeLessThan(0.001);
  });
});

describe("at a crawl, the phone's turning while it sits in its mount", () => {
  // At speed for a while: wheels and gyro both 0.1 rad/s (mounted), or the gyro 0.3 rad/s off them (a pocket).
  const drive = (src: WheelYawSource, gyroOff: number) => {
    for (let t = 0; t < 30_000_000; t += 100_000) {
      src.addGyro(t - WHEEL_LAG_US, 0.1 + gyroOff * Math.sin(t / 1e6));
      const w = wheels(t, 0.1);
      src.addWheels(w);
      src.learn(w);
    }
  };
  // Then pulling out of a space at 1 m/s: the wheels read no turning, the car (and phone) turns 0.4 rad/s.
  const crawl = (src: WheelYawSource) => {
    const t = 31_000_000;
    src.addWheels({ ...wheels(t + WHEEL_LAG_US, 0, 1) });
    src.addGyro(t, 0.4);
    return WheelYawSource.gyroYaw(src.substitute(imu(t, 0.4))!);
  };

  test("mounted: the gyro's turning, not the wheels' nothing", () => {
    const src = new WheelYawSource(null, undefined, false);
    drive(src, 0);
    expect(crawl(src)).toBeCloseTo(0.4, 6);
  });

  test("in a pocket (the gyro didn't turn with the wheels): still the wheels", () => {
    const src = new WheelYawSource(null, undefined, false);
    drive(src, 0.3);
    expect(crawl(src)).toBeCloseTo(0, 6);
  });

  test("what was learned at speed carries over to a new source (the wheels lost and back)", () => {
    const before = new WheelYawSource(null, undefined, false);
    drive(before, 0);
    const after = new WheelYawSource(null, undefined, false, before.agreement);
    expect(crawl(after)).toBeCloseTo(0.4, 6);
  });
});
