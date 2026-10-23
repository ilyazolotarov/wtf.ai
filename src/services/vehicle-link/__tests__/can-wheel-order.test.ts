import { tidy, type DiscoveredSpeed } from "@/nav/odometry/can/discovery";
import type { WheelOrderVerdict } from "@/nav/odometry/can/wheel-order";
import type { ImuSample } from "@/nav/types";
import type { CanFrame } from "@/obd/can-monitor";
import { CAN_WHEEL_ORDER_KEY, CanWheelOrder } from "@/services/vehicle-link/can-wheel-order";

const VIN = "XXXAAAAAA00000000";
const ID = 0x4b0;
/** The find: four big-endian 16-bit fields, 0.01 km/h, zero at 10 000. */
const FIND: DiscoveredSpeed = {
  id: ID,
  len: 8,
  fields: tidy([0, 2, 4, 6].map((byte) => ({ byte, endian: "be" as const, shift: 0, bits: 16, kphPerCount: 0.01, offset: 10000, r: 0.999 }))),
  pairs: 200,
  rangeKph: 60,
};

/** A town lap of 60 s: straight, a left turn at 20 km/h, straight, a tight right one at 14 km/h. */
function car(tS: number): { v: number; yaw: number } {
  const c = tS % 60;
  if (c < 20 || (c >= 30 && c < 50)) return { v: 14, yaw: 0 };
  return c < 30 ? { v: 5.5, yaw: 5.5 / 15 } : { v: 4, yaw: -0.5 };
}

/** The car's wheels [fl, fr, rl, rr] (track 1.6 m, wheelbase 2.7 m) in a frame, the fields in `fieldOf` order. */
function frame(tS: number, fieldOf: number[]): number[] {
  const { v, yaw } = car(tS);
  const side = yaw * 0.8;
  const w = [Math.hypot(v - side, yaw * 2.7), Math.hypot(v + side, yaw * 2.7), v - side, v + side];
  const data = new Array<number>(8).fill(0);
  fieldOf.forEach((wheel, i) => {
    const raw = Math.round((w[wheel] * 3.6) / 0.01) + 10000;
    data[2 * i] = raw >> 8;
    data[2 * i + 1] = raw & 0xff;
  });
  return data;
}

function memoryStore() {
  const m = new Map<string, unknown>();
  return { getJson: <T>(k: string) => (m.get(k) as T) ?? null, setJson: (k: string, v: unknown) => void m.set(k, v) };
}

function harness(store = memoryStore(), find: DiscoveredSpeed | null = FIND) {
  let now = 0;
  const frames = new Set<(f: CanFrame[]) => void>();
  const windows = new Set<() => void>();
  const imu = new Set<(s: ImuSample[]) => void>();
  const notes: string[] = [];
  const decided: WheelOrderVerdict[] = [];
  let current = find;
  const o = new CanWheelOrder({
    vin: () => VIN,
    find: () => current,
    onFrames: (l) => (frames.add(l), () => frames.delete(l)),
    onWindow: (l) => (windows.add(l), () => windows.delete(l)),
    onImu: (l) => (imu.add(l), () => imu.delete(l)),
    decided: (_find, v) => decided.push(v),
    store,
    note: (t) => notes.push(t),
  });
  /**
   * Drive `seconds`: the phone's motion in batches of 0.1 s (lying flat in its mount), the find's frames at 50 Hz the
   * way the link brings them, the wheels 0.1 s behind the gyro.
   */
  const drive = (seconds: number, fieldOf = [0, 1, 2, 3]) => {
    const end = now + seconds * 1e6;
    let batch: ImuSample[] = [];
    for (; now < end; now += 10_000) {
      const tS = now / 1e6;
      batch.push({ tUs: now, gyro: [0, 0, car(tS).yaw], gravity: [0, 0, -9.81], userAccel: [0, 0, 0] });
      if (now % 100_000 === 0) {
        imu.forEach((l) => l(batch));
        batch = [];
      }
      if (now % 20_000 === 0) frames.forEach((l) => l([{ id: ID, data: frame(tS - 0.1, fieldOf), rxUs: now }]));
    }
  };
  return {
    o,
    store,
    notes,
    decided,
    drive,
    setFind: (f: DiscoveredSpeed | null) => {
      current = f;
      o.refresh();
    },
  };
}

describe("which wheel is which in a find (VEHICLE-LINK-SPEC §16.6)", () => {
  test("a find of four wheels: learned from the gyro while the car drives on it, the order handed on, nothing more kept", () => {
    const h = harness();
    h.o.start();
    expect(h.o.active).toBe(true);
    expect(h.notes).toEqual(["can discovery: learning which wheel is which in 4B0 from the gyro"]);
    // The fields: rr, fl, rl, fr.
    h.drive(600, [3, 0, 2, 1]);
    expect(h.decided).toHaveLength(1);
    expect(h.decided[0].order).toEqual([1, 3, 2, 0]);
    expect(h.o.active).toBe(false);
    expect(h.notes.at(-1)).toMatch(/^can discovery: wheels of 4B0 by the gyro: fl b2be16s0x0\.01o10000, fr b6be16s0x0\.01o10000, rl b4.*, rr b0.* \(track 1\.6\d m, wheelbase 2\.\d\d m, from \d\.\d min\); turns from them from the next drive$/);
    expect(h.store.getJson<Record<string, unknown>>(CAN_WHEEL_ORDER_KEY)).toEqual({});
  });

  test("a short drive's learning is kept for the car's next", () => {
    const h = harness();
    h.o.start();
    h.drive(90);
    expect(h.decided).toHaveLength(0);
    h.o.stop();
    const next = harness(h.store);
    next.o.start();
    expect(next.notes[0]).toMatch(/^can discovery: learning which wheel is which in 4B0 from the gyro \(\d\.\d min so far\)$/);
    next.drive(240);
    expect(next.decided.map((v) => v.order)).toEqual([[0, 1, 2, 3]]);
  });

  test("no find, one with an order already, or one of a single field: nothing to learn", () => {
    const learns = (find: DiscoveredSpeed | null): boolean => {
      const x = harness(memoryStore(), find);
      x.o.start();
      return x.o.active;
    };
    expect([learns(null), learns({ ...FIND, order: [0, 1, 2, 3] }), learns({ ...FIND, fields: FIND.fields.slice(0, 1) })]).toEqual([false, false, false]);
  });

  test("fields that aren't four wheels: kept so, learned no more until the driver turns the wheels' speed on again", () => {
    const h = harness();
    h.o.start();
    // Two fields of the front left wheel.
    h.drive(600, [0, 0, 2, 3]);
    expect(h.decided).toEqual([{ order: null, reason: "not two wheels a side" }]);
    expect(h.notes.at(-1)).toMatch(/^can discovery: 4B0's fields aren't four wheels by the gyro \(not two wheels a side, from .* min\); turns stay on the phone's gyro$/);
    const next = harness(h.store);
    next.o.start();
    expect(next.o.active).toBe(false);
    next.o.forgetNotWheels();
    next.setFind(null);
    next.setFind(FIND);
    expect(next.o.active).toBe(true);
  });
});
