import { allProfiles, makeForVin, type Profile } from "@/nav/odometry/can/profile";
import type { CanFrame } from "@/obd/can-monitor";
import { CAN_AUTO_IDS_KEY, CAN_AUTO_NONE_KEY, CanAutoIds, candidateIds, idsAfterBufferFull, navigationIds, type CanAutoStatus } from "@/services/vehicle-link/can-auto-ids";

// Made-up VINs: only the maker prefix (WMI) matters.
const MAZDA = "JM1AAAAAA00000000";
const VW = "WVWAAAAAA00000000";

function harness(vin: string | null, stored: Record<string, unknown> = {}) {
  let listener: ((frames: CanFrame[]) => void) | null = null;
  let windowListener: ((w: { startUs: number; endUs: number }) => void) | null = null;
  const store = new Map<string, unknown>(Object.entries(stored));
  const listens: (number[] | null)[] = [];
  const notes: string[] = [];
  let moving = true;
  let currentVin = vin;
  const auto = new CanAutoIds({
    vin: () => currentVin,
    listen: (ids) => listens.push(ids),
    onFrames: (l) => ((listener = l), () => (listener = null)),
    onWindow: (l) => ((windowListener = l), () => (windowListener = null)),
    moving: () => moving,
    store: { getJson: <T,>(k: string) => (store.get(k) ?? null) as T | null, setJson: (k, v) => void store.set(k, v) },
    note: (t) => notes.push(t),
  });
  /** `seconds` of the car's frames of these ids (the DBC's lengths), 50 Hz each. */
  const car = (p: Profile, fromUs: number, seconds: number) => {
    const frames: CanFrame[] = [];
    for (let i = 0; i < seconds * 50; i++) for (const id of navigationIds(p)) frames.push({ id, data: new Array(p.ids.get(id)!.size).fill(0), rxUs: fromUs + i * 20_000 });
    for (let i = 0; i < frames.length; i += 20) listener?.(frames.slice(i, i + 20));
  };
  /** `seconds` of the monitor listening in 0.5 s windows, hearing nothing. */
  const silence = (seconds: number) => {
    for (let t = 0; t < seconds; t += 0.5) windowListener?.({ startUs: t * 1e6, endUs: (t + 0.5) * 1e6 });
  };
  return { auto, listens, notes, store, car, silence, setVin: (v: string | null) => (currentVin = v), setMoving: (m: boolean) => (moving = m) };
}

const status = (a: CanAutoIds): CanAutoStatus => a.status;

describe("CAN ids picked for the car (VEHICLE-LINK-SPEC §16.4)", () => {
  test("a make with two platforms: listened to at once, then the car's only, remembered for the VIN", () => {
    const mazda = allProfiles().find((p) => p.key === "mazda/mazda/mazda_2017")!;
    const h = harness(MAZDA);
    h.auto.start();
    expect(h.listens).toEqual([candidateIds(MAZDA)]);
    h.car(mazda, 0, 3);
    expect(status(h.auto)).toMatchObject({ state: "chosen", profile: "mazda/mazda/mazda_2017" });
    expect(h.listens).toHaveLength(2);
    expect([...h.listens[1]!].sort()).toEqual([0x215, 0x228]);
    expect((h.store.get(CAN_AUTO_IDS_KEY) as Record<string, number[]>)[MAZDA].sort()).toEqual([0x215, 0x228]);
    expect(h.notes).toEqual([expect.stringMatching(/^can auto: mazda\/.*, ids 215 228$/i)]);
  });

  test("a make whose one platform's ids are all its candidates: the shadow carries on, no second setup", () => {
    const BYD = "LGXAAAAAA00000000";
    const byd = allProfiles().find((p) => p.make === "byd")!;
    const h = harness(BYD);
    h.auto.start();
    expect(h.listens).toEqual([candidateIds(BYD)]);
    h.car(byd, 0, 3);
    expect(status(h.auto)).toMatchObject({ state: "chosen", profile: byd.key });
    expect(h.listens).toHaveLength(1);
  });

  test("many candidates: in batches until the car's are heard, then only the platform's", () => {
    expect(makeForVin(VW)).toBe("volkswagen");
    const all = candidateIds(VW);
    expect(all.length).toBeGreaterThan(8);
    // The platform whose wheel ids come in the second batch.
    const second = new Set(all.slice(8));
    const vw = allProfiles().find((p) => p.make === "volkswagen" && p.wheels && navigationIds(p).some((id) => second.has(id)))!;
    const h = harness(VW);
    h.auto.start();
    expect(h.listens[0]).toHaveLength(8);
    h.car(vw, 0, 3); // none of its wheel ids in the first batch: nothing matches
    expect(h.listens).toHaveLength(2);
    h.car(vw, 3_000_000, 3);
    const chosen = status(h.auto);
    expect(chosen).toMatchObject({ state: "chosen" });
    expect(h.listens.at(-1)).toEqual((chosen as { ids: number[] }).ids);
  });

  test("the ids remembered for the VIN are tried first", () => {
    const h = harness(MAZDA, { [CAN_AUTO_IDS_KEY]: { [MAZDA]: [0x228, 0x215] } });
    h.auto.start();
    expect(h.listens[0]).toEqual([0x228, 0x215]);
  });

  test("no VIN yet: nothing listened to until it is read", () => {
    const h = harness(null);
    h.auto.start();
    expect(status(h.auto)).toEqual({ state: "no-vin" });
    h.auto.refresh();
    expect(h.listens).toEqual([null]);
    h.setVin(MAZDA);
    h.auto.refresh();
    expect(status(h.auto)).toMatchObject({ state: "probing" });
  });

  // A gateway at the OBD port: none of the make's ids comes (the monitor's own backstop would blame its filter at 5 s).
  test("a batch not heard in 3 s of listening is passed over; none heard: OBD, and after two drives at once", () => {
    const h = harness(VW);
    h.auto.start();
    expect(h.listens[0]).toHaveLength(8);
    h.silence(2.5);
    expect(h.listens).toHaveLength(1);
    h.silence(0.5);
    expect(h.listens).toHaveLength(2);
    h.silence(3);
    expect(status(h.auto)).toEqual({ state: "none", heard: 0 });
    expect(h.listens.at(-1)).toBeNull();
    expect(h.notes.at(-1)).toMatch(/drive 1 of 2/);
    // The next drive tries again; after the second, the car is OBD only from the start.
    const next = harness(VW, Object.fromEntries(h.store));
    next.auto.start();
    expect(next.listens[0]).toHaveLength(8);
    next.silence(6);
    expect(status(next.auto)).toEqual({ state: "none", heard: 0 });
    const third = harness(VW, Object.fromEntries(next.store));
    third.auto.start();
    expect(third.listens).toEqual([null]);
    expect(third.notes).toEqual([expect.stringMatching(/none of the make's ids heard on 2 drives/)]);
    // The driver turning the wheels' speed on again tries again.
    third.auto.forgetNone();
    third.auto.stop();
    third.auto.start();
    expect(third.listens.at(-1)).toHaveLength(8);
  });

  // The main test car's ECU answers with the engine off: parked, the wheels may not be on the bus yet.
  test("none heard while the car stood: OBD for this drive, but not counted towards OBD only", () => {
    const h = harness(VW);
    h.setMoving(false);
    h.auto.start();
    h.silence(6);
    expect(status(h.auto)).toEqual({ state: "none", heard: 0 });
    expect(h.store.get(CAN_AUTO_NONE_KEY)).toBeUndefined();
    expect(h.notes.at(-1)).toMatch(/while the car stood.*not counted/);
    // Moving through some of the silence, the drive counts.
    const next = harness(VW, Object.fromEntries(h.store));
    next.setMoving(false);
    next.auto.start();
    next.silence(2);
    next.setMoving(true);
    next.silence(4);
    expect(next.notes.at(-1)).toMatch(/drive 1 of 2/);
  });

  test("a car once taken for OBD only whose ids are heard is forgotten as such; new candidates try again", () => {
    const mazda = allProfiles().find((p) => p.make === "mazda" && p.wheels)!;
    const stale = { [CAN_AUTO_NONE_KEY]: { [MAZDA]: { candidates: "1,2", drives: 5 } } };
    const h = harness(MAZDA, stale);
    h.auto.start();
    expect(status(h.auto)).toMatchObject({ state: "probing" });
    h.car(mazda, 0, 3);
    expect(status(h.auto)).toMatchObject({ state: "chosen" });
    expect(h.store.get(CAN_AUTO_NONE_KEY)).toEqual({});
  });

  test("a make without a CAN profile: said once, nothing listened to", () => {
    const h = harness("ZZZAAAAAA00000000");
    h.auto.start();
    expect(status(h.auto)).toEqual({ state: "unknown-make" });
    expect(h.listens).toEqual([null]);
    expect(h.notes).toHaveLength(1);
  });
});

describe("after BUFFER FULL (VEHICLE-LINK-SPEC §16.3)", () => {
  const mazda = () => allProfiles().find((p) => p.make === "mazda" && p.wheels)!;

  // 2026-10-13: five typed ids (wheels, gear, steering, accel, engine) outran the MX+'s link without the polls' breaks.
  test("more ids than navigation needs: down to its own", () => {
    expect(idsAfterBufferFull([0x215, 0x228, 0x82, 0x78, 0x202], mazda())?.sort()).toEqual([0x215, 0x228]);
  });

  test("already only those, or the car's profile not known yet: nothing to drop", () => {
    expect(idsAfterBufferFull([0x228, 0x215], mazda())).toBeNull();
    expect(idsAfterBufferFull([0x215, 0x228, 0x82], null)).toBeNull();
    expect(idsAfterBufferFull(null, mazda())).toBeNull();
  });
});
