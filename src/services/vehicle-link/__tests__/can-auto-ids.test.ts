import { allProfiles, makeForVin, type Profile } from "@/nav/odometry/can/profile";
import type { CanFrame } from "@/obd/can-monitor";
import { CAN_AUTO_IDS_KEY, CanAutoIds, candidateIds, navigationIds, type CanAutoStatus } from "@/services/vehicle-link/can-auto-ids";

// Made-up VINs: only the maker prefix (WMI) matters.
const MAZDA = "JM1AAAAAA00000000";
const VW = "WVWAAAAAA00000000";

function harness(vin: string | null, stored: Record<string, unknown> = {}) {
  let listener: ((frames: CanFrame[]) => void) | null = null;
  const store = new Map<string, unknown>(Object.entries(stored));
  const listens: (number[] | null)[] = [];
  const notes: string[] = [];
  let currentVin = vin;
  const auto = new CanAutoIds({
    vin: () => currentVin,
    listen: (ids) => listens.push(ids),
    onFrames: (l) => ((listener = l), () => (listener = null)),
    store: { getJson: <T,>(k: string) => (store.get(k) ?? null) as T | null, setJson: (k, v) => void store.set(k, v) },
    note: (t) => notes.push(t),
  });
  /** `seconds` of the car's frames of these ids (the DBC's lengths), 50 Hz each. */
  const car = (p: Profile, fromUs: number, seconds: number) => {
    const frames: CanFrame[] = [];
    for (let i = 0; i < seconds * 50; i++) for (const id of navigationIds(p)) frames.push({ id, data: new Array(p.ids.get(id)!.size).fill(0), rxUs: fromUs + i * 20_000 });
    for (let i = 0; i < frames.length; i += 20) listener?.(frames.slice(i, i + 20));
  };
  return { auto, listens, notes, store, car, setVin: (v: string | null) => (currentVin = v) };
}

const status = (a: CanAutoIds): CanAutoStatus => a.status;

describe("CAN ids picked for the car (VEHICLE-LINK-SPEC §16.4)", () => {
  test("a make with two candidates: listened to at once, kept, remembered for the VIN", () => {
    const mazda = allProfiles().find((p) => p.make === "mazda" && p.wheels)!;
    const h = harness(MAZDA);
    h.auto.start();
    expect(h.listens).toEqual([candidateIds(MAZDA)]);
    h.car(mazda, 0, 3);
    expect(status(h.auto)).toMatchObject({ state: "chosen", profile: expect.stringMatching(/^mazda\//) });
    // The shadow carries on with what it listens to: no second setup.
    expect(h.listens).toHaveLength(1);
    expect((h.store.get(CAN_AUTO_IDS_KEY) as Record<string, number[]>)[MAZDA].sort()).toEqual(candidateIds(MAZDA).sort());
    expect(h.notes).toEqual([expect.stringMatching(/^can auto: mazda\/.*, ids 215 228$/i)]);
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

  test("a make without a CAN profile: said once, nothing listened to", () => {
    const h = harness("ZZZAAAAAA00000000");
    h.auto.start();
    expect(status(h.auto)).toEqual({ state: "unknown-make" });
    expect(h.listens).toEqual([null]);
    expect(h.notes).toHaveLength(1);
  });
});
