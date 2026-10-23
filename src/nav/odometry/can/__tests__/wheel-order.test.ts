import { CAN_SPEED_PERIOD_US } from "../can-speed";
import { WheelOrderFinder, type WheelOrderVerdict } from "../wheel-order";
import { WHEEL_LAG_US } from "../wheel-yaw-source";

const TRACK = 1.6;
const WHEELBASE = 2.7;

/**
 * A town drive, 60 s a lap: straight at 50 km/h, a left turn at 20 km/h (radius 15 m), straight, a tight right one at
 * 14 km/h (radius 8 m); with `reversing` 30 s more of turns both ways reversing at 7 km/h, more turning than forwards.
 * Speed at the rear axle (negative reversing) and yaw rate (left positive).
 */
function drive(tS: number, reversing = false): { v: number; yaw: number } {
  const c = tS % (reversing ? 90 : 60);
  if (c >= 60) return { v: -2, yaw: c < 75 ? 0.5 : -0.5 };
  if (c < 20) return { v: 14, yaw: 0 };
  if (c < 30) return { v: 5.5, yaw: 5.5 / 15 };
  if (c < 50) return { v: 14, yaw: 0 };
  return { v: 4, yaw: -4 / 8 };
}

/** The four wheels' speeds (unsigned, as a car without direction bits sends them): [fl, fr, rl, rr]. */
function wheels({ v, yaw }: { v: number; yaw: number }): number[] {
  const side = (yaw * TRACK) / 2;
  const front = yaw * WHEELBASE;
  return [Math.hypot(v - side, front), Math.hypot(v + side, front), Math.abs(v - side), Math.abs(v + side)];
}

interface Run {
  /** The find's fields, as wheels: `fields[i]` is the wheel (index in [fl, fr, rl, rr]) field i reads. */
  fields?: number[];
  seconds?: number;
  reversing?: boolean;
  /** The phone in a hand: its gyro turning on its own, read handled (null) by the IMU's processor. */
  handledFrom?: number;
  finder?: WheelOrderFinder;
}

/** IMU at 100 Hz with noise and a bias, wheel samples every 0.1 s placed `WHEEL_LAG_US` after the gyro, quantised. */
function run({ fields = [0, 1, 2, 3], seconds = 600, reversing = false, handledFrom = Infinity, finder = new WheelOrderFinder() }: Run = {}) {
  let seed = 7;
  const noise = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647 - 0.5;
  };
  let verdict: WheelOrderVerdict | null = null;
  let verdictS: number | null = null;
  for (let ms = 0; ms <= seconds * 1000; ms += 10) {
    const tUs = ms * 1000;
    const tS = ms / 1000;
    const car = drive(tS, reversing);
    const handled = tS >= handledFrom;
    finder.addGyro(tUs, handled ? null : car.yaw + 0.002 + 0.02 * noise());
    if (tUs % CAN_SPEED_PERIOD_US === 0 && tUs >= WHEEL_LAG_US) {
      const w = wheels(drive((tUs - WHEEL_LAG_US) / 1e6, reversing));
      finder.addFields(
        tUs,
        fields.map((i) => Math.round((w[i] * 3.6) / 0.01) * (0.01 / 3.6)),
      );
    }
    if (!verdict) {
      verdict = finder.verdict();
      if (verdict) verdictS = tS;
    }
  }
  return { finder, verdict, verdictS };
}

describe("which wheel is which, from the gyro (VEHICLE-LINK-SPEC §16.6)", () => {
  test("the outer wheels lead in a turn, the front ones in every turn: each field's wheel, the car's shape", () => {
    // The fields in another order than the wheels': rr, fl, rl, fr.
    const { verdict, verdictS } = run({ fields: [3, 0, 2, 1] });
    expect(verdict?.order).toEqual([1, 3, 2, 0]);
    if (!verdict?.order) throw new Error("no order");
    expect(verdict.trackM).toBeCloseTo(TRACK, 1);
    expect(verdict.frontTrackM).toBeCloseTo(TRACK, 1);
    expect(verdict.wheelbaseM).toBeCloseTo(WHEELBASE, 1);
    // A few minutes of town driving (the minimum and a turn each way first).
    expect(verdictS).toBeLessThan(240);
  });

  test("reversing, which unsigned wheels read turning the other way, is slower than the fit looks at", () => {
    expect(run({ reversing: true, seconds: 900 }).verdict?.order).toEqual([0, 1, 2, 3]);
    // Looked at, its turning the other way muddles every side: no verdict in the time.
    const all = new WheelOrderFinder(null, { minSpeedMps: 0 });
    expect(run({ reversing: true, seconds: 900, finder: all }).verdict).toBeNull();
  });

  test("a gyro read handled teaches nothing", () => {
    const { finder, verdict } = run({ handledFrom: 0 });
    expect(verdict).toBeNull();
    expect(finder.stretches).toBe(0);
  });

  test("what a short drive learned carries on to the next", () => {
    const first = run({ seconds: 100 });
    expect(first.verdict).toBeNull();
    const next = run({ seconds: 300, finder: new WheelOrderFinder(first.finder.sums) });
    expect(next.verdict?.order).toEqual([0, 1, 2, 3]);
    expect(next.verdictS).toBeLessThan(run().verdictS!);
  });

  test("fields that aren't four wheels: two of one side say so; one speed four times never decides", () => {
    expect(run({ fields: [0, 0, 2, 3] }).verdict).toEqual({ order: null, reason: "not two wheels a side" });
    const same = run({ fields: [2, 2, 2, 2], seconds: 1200 });
    expect(same.verdict).toBeNull();
    expect(same.finder.stretches).toBeGreaterThan(100);
  });
});
