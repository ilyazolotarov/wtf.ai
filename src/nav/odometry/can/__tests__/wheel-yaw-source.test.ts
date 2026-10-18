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

describe("the car's tyre term known late (its VIN after the wheels)", () => {
  test("taken while nothing is learned yet, applied to the wheels; not once the drive has learned", () => {
    const src = new WheelYawSource();
    const car = { trackM: 1.6, tyre: -0.001, trackSigmaM: 0.003, tyreSigma: 0.0005, learnedS: 0 };
    expect(src.seed(car)).toBe(true);
    // Straight at 10 m/s, the right rear reading 0.1 % slow: no turning.
    src.addWheels(wheels(WHEEL_LAG_US, 0, 10, -0.001));
    expect(src.yawAt(0)).toBeCloseTo(0, 6);

    const learned = new WheelYawSource();
    for (let k = 0; k < 200; k++) {
      const t = k * 100_000;
      for (let j = 0; j < 10; j++) learned.addGyro(t - WHEEL_LAG_US + j * 10_000, 0);
      const w = wheels(t, 0, 12);
      learned.addWheels(w);
      learned.learn(w);
    }
    expect(learned.calibration.learnedS).toBeGreaterThan(0);
    expect(learned.seed(car)).toBe(false);
  });
});

describe("standing, the phone's turning is never the car's", () => {
  // The car stands (wheels at 0) and the phone turns 1 rad/s in the driver's hand.
  test("in a break in listening between two standing samples: no turning, still the car's frame", () => {
    const src = new WheelYawSource();
    src.addWheels(wheels(WHEEL_LAG_US, 0, 0));
    src.addWheels(wheels(900_000 + WHEEL_LAG_US, 0, 0));
    const out = src.substitute(imu(450_000, 1))!;
    expect(out.gravity).toEqual([0, 0, -9.81]);
    expect(WheelYawSource.gyroYaw(out)).toBe(0);
  });

  test("as the wheels go silent (ignition off), for the second the car's frame lasts", () => {
    const src = new WheelYawSource();
    for (let t = 0; t <= 1_000_000; t += 100_000) src.addWheels(wheels(t + WHEEL_LAG_US, 0, 0));
    expect(WheelYawSource.gyroYaw(src.substitute(imu(1_600_000, 1))!)).toBe(0);
    // Then the phone's sample as it is.
    expect(src.substitute(imu(2_200_000, 1))).toBeNull();
  });

  test("the car setting off in the break: the phone's turning", () => {
    const src = new WheelYawSource();
    src.addWheels(wheels(WHEEL_LAG_US, 0, 0));
    src.addWheels(wheels(900_000 + WHEEL_LAG_US, 0, 2));
    expect(WheelYawSource.gyroYaw(src.substitute(imu(450_000, 1))!)).toBeCloseTo(1, 6);
  });
});
