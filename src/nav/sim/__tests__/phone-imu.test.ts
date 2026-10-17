import { ImuProcessor } from "@/nav/odometry/imu/imu-processor";
import { PhoneImuModel } from "@/nav/sim/phone-imu";
import type { ImuSample, Vec3 } from "@/nav/types";

function rng(seed: number) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { uniform, gauss: () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform()) };
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3) => Math.sqrt(dot(a, a));

/** `seconds` of a car at a steady speed and yaw rate, at 100 Hz. */
function run(model: PhoneImuModel, seconds: number, speedMps: number, yawRateRadS: number): ImuSample[] {
  const out: ImuSample[] = [];
  let heading = 0.3;
  let distance = 0;
  for (let i = 0; i < seconds * 100; i++) {
    heading -= yawRateRadS * 0.01;
    distance += speedMps * 0.01;
    out.push(model.sample({ tUs: 1e9 + i * 1e4, speedMps, accelMS2: 0, headingRad: heading, yawRateRadS, distanceM: distance }));
  }
  return out;
}

describe("PhoneImuModel", () => {
  test("standing: gravity along the car's up in the phone, a phone as quiet as at a red light", () => {
    const model = new PhoneImuModel(rng(3), 100);
    const samples = run(model, 20, 0, 0);
    const up = model.mountUp;
    // The holder tilts the screen back ~20° from vertical: up is mostly along the phone's y axis.
    expect(Math.abs(up[1])).toBeGreaterThan(0.7);
    const total = (s: ImuSample): Vec3 => [s.gravity[0] + s.userAccel[0], s.gravity[1] + s.userAccel[1], s.gravity[2] + s.userAccel[2]];
    const avg = (i: number) => samples.reduce((a, s) => a + total(s)[i], 0) / samples.length;
    const mean: Vec3 = [avg(0), avg(1), avg(2)];
    expect(norm(mean)).toBeCloseTo(9.81, 0);
    expect(dot(mean, up) / norm(mean)).toBeLessThan(-0.99);
    // The stop detector's vibration (vertical user acceleration, RMS over 1 s) stays under its 0.25 m/s².
    const vert = samples.slice(-100).map((s) => dot(s.userAccel, up));
    const m = vert.reduce((a, x) => a + x, 0) / vert.length;
    expect(Math.sqrt(vert.reduce((a, x) => a + (x - m) ** 2, 0) / vert.length)).toBeLessThan(0.25);
    const proc = new ImuProcessor();
    const quiet = samples.map((s) => proc.process(s).quiet);
    expect(quiet.slice(-500).filter(Boolean).length).toBeGreaterThan(400);
  });

  test("driving: the yaw rate about CoreMotion's up is the car's, the holder shakes with speed", () => {
    const model = new PhoneImuModel(rng(5), 100);
    run(model, 5, 10, 0);
    const turning = run(model, 20, 10, 0.2);
    const proc = new ImuProcessor();
    const yaw = turning.map((s) => proc.process(s).yawRate);
    const mean = yaw.slice(200).reduce((a, x) => a + x, 0) / (yaw.length - 200);
    expect(mean).toBeGreaterThan(0.19);
    expect(mean).toBeLessThan(0.215);
    const shake = (samples: ImuSample[]) => Math.sqrt(samples.reduce((a, s) => a + dot(s.userAccel, s.userAccel), 0) / samples.length);
    const slow = run(new PhoneImuModel(rng(7), 100), 10, 3, 0);
    const fast = run(new PhoneImuModel(rng(7), 100), 10, 22, 0);
    expect(shake(fast)).toBeGreaterThan(2 * shake(slow));
  });

  test("is repeatable for a seed", () => {
    expect(run(new PhoneImuModel(rng(9), 100), 2, 8, 0.1)).toEqual(run(new PhoneImuModel(rng(9), 100), 2, 8, 0.1));
  });
});
