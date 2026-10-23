import { inSlice, type CanFrame, type CanSurvey, type IdSlice } from "@/obd/can-monitor";
import type { SpeedSample } from "@/obd/types";
import type { CanAutoStatus } from "@/services/vehicle-link/can-auto-ids";
import { CAN_DISCOVERY_KEY, CanDiscovery, discoveryReportAttributes, linkCapacity, type CanDiscoveryReport } from "@/services/vehicle-link/can-discovery";
import type { Profile } from "@/nav/odometry/can/profile";
import { scrubLog } from "@/config/sentry-scrub";

// Made-up VIN of a make without a profile (no WMI in mappings.ts).
const VIN = "XXXAAAAAA00000000";
const WHEELS = 0x4b0;

function kphAt(tS: number): number {
  const c = tS % 60;
  if (c < 10) return 0;
  if (c < 20) return (c - 10) * 4;
  if (c < 45) return 40 + 25 * Math.sin(((c - 20) / 25) * Math.PI);
  if (c < 55) return 40 - (c - 45) * 4;
  return 0;
}

/** A car whose wheels (big-endian 16-bit, 0.01 km/h, −100 km/h) are at 0x4B0; other ids carry counters. */
function frameOf(id: number, kph: number, n: number): number[] {
  const d = new Array<number>(8).fill(0);
  if (id === WHEELS) {
    for (let w = 0; w < 4; w++) {
      const v = Math.round((kph + 100) / 0.01);
      d[2 * w] = (v >> 8) & 0xff;
      d[2 * w + 1] = v & 0xff;
    }
  } else d.forEach((_, i) => (d[i] = (n * (id & 0x3f) + i * 7) & 0xff));
  return d;
}

function memoryStore() {
  const m = new Map<string, unknown>();
  return { getJson: <T>(k: string) => (m.get(k) as T) ?? null, setJson: (k: string, v: unknown) => void m.set(k, v) };
}

interface Bus {
  busIds: number[];
  /** Frames per second by id (default 50). */
  hz?: Record<number, number>;
  /** Ids the survey hears that send nothing while the car drives. */
  silent?: number[];
  /** Ids that stop sending at this time of the drive (s). */
  silentFrom?: Record<number, number>;
  capacity?: number;
  store?: ReturnType<typeof memoryStore>;
  auto?: CanAutoStatus["state"];
  reportsOn?: () => boolean;
}

function harness(opts: Bus) {
  const store = opts.store ?? memoryStore();
  let now = 0;
  let engine = true;
  const frames = new Set<(f: CanFrame[]) => void>();
  const windows = new Set<(w: { startUs: number; endUs: number }) => void>();
  const speeds = new Set<(s: SpeedSample) => void>();
  const listens: (number[] | null)[] = [];
  const found: (Profile | null)[] = [];
  const reports: CanDiscoveryReport[] = [];
  const notes: string[] = [];
  const slices: IdSlice[] = [];
  const hzOf = (id: number) => (id === 0x7e8 ? 2 : (opts.hz?.[id] ?? 50));
  const survey = async (slice: IdSlice, durationMs: number): Promise<CanSurvey> => {
    slices.push(slice);
    // Only the slice's ids pass the adapter's filter; the diagnostic answer is on the bus too.
    const ids = [...opts.busIds, 0x7e8].filter((id) => inSlice(id, slice, 11));
    return {
      idDigits: 3,
      ids: ids.map((id) => ({ id, count: hzOf(id), hz: hzOf(id), lengths: [8], last: [] })),
      frames: 0,
      durationMs,
      chars: 0,
      bufferFull: 0,
      other: 0,
    };
  };
  const d = new CanDiscovery({
    vin: () => VIN,
    nowUs: () => now,
    canAuto: () => ({ state: opts.auto ?? "unknown-make" }) as CanAutoStatus,
    canMonitor: () => true,
    engineRunning: () => engine,
    survey,
    capacity: () => opts.capacity ?? 150,
    listen: (ids) => listens.push(ids),
    onFrames: (l) => (frames.add(l), () => frames.delete(l)),
    onWindow: (l) => (windows.add(l), () => windows.delete(l)),
    onSpeed: (l) => (speeds.add(l), () => speeds.delete(l)),
    setTrusted: () => {},
    found: (p) => found.push(p),
    reportScope: () => "stn2255|1.0.0",
    ...(opts.reportsOn ? { reportsOn: opts.reportsOn } : {}),
    report: (r) => reports.push(r),
    store,
    note: (t) => notes.push(t),
  });
  const poll = (kph: number) => speeds.forEach((l) => l({ txUs: now - 20_000, rxUs: now + 20_000, tUs: now, speedMps: kph / 3.6, raw: Math.round(kph) }));
  /** Stand `seconds`, the monitor not heard: polls at 2 Hz, each slice's survey answered before the next poll. */
  const stand = async (seconds: number) => {
    const end = now + seconds * 1e6;
    for (; now < end; now += 500_000) {
      poll(0);
      await flush();
    }
  };
  /** Polls at `kph` for `seconds`, nothing listened to. */
  const cruise = (seconds: number, kph = 50) => {
    const end = now + seconds * 1e6;
    for (; now < end; now += 500_000) poll(kph);
  };
  /**
   * Drive `seconds`: polls at 2 Hz (none in `lateAt` windows of 3 s), the monitor listening in their breaks (200–480 ms
   * of each half second) to the ids last asked for, their frames at 50 Hz, each listening window told at its end.
   */
  const drive = (seconds: number, lateAt: number[] = [], speed = kphAt) => {
    const end = now + seconds * 1e6;
    let n = 0;
    for (; now < end; now += 20_000) {
      const tS = now / 1e6;
      const kph = speed(tS);
      const listened = listens.at(-1) ?? null;
      const phase = now % 500_000;
      if (phase === 0 && !lateAt.some((t) => tS > t && tS < t + 3)) poll(kph);
      if (phase < 200_000 || !listened) continue;
      const sent = listened.filter((id) => opts.busIds.includes(id) && !opts.silent?.includes(id) && !(tS >= (opts.silentFrom?.[id] ?? Infinity)));
      const batch = sent.map((id) => ({ id, data: frameOf(id, kph, n++), rxUs: now }));
      if (batch.length) frames.forEach((l) => l(batch));
      if (phase === 480_000) windows.forEach((l) => l({ startUs: now - 280_000, endUs: now }));
    }
  };
  return {
    d,
    store,
    listens,
    found,
    reports,
    notes,
    slices,
    drive,
    stand,
    cruise,
    /** Time passes, no poll. */
    advance: (seconds: number) => void (now += seconds * 1e6),
    engine: (on: boolean) => void (engine = on),
    surveys: () => slices.length,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("CAN discovery (VEHICLE-LINK-SPEC §16.6)", () => {
  test("surveys the bus a slice at a time at stops, searches as many ids as the link carries, finds the wheels, keeps them", async () => {
    const h = harness({ busIds: [0x100, 0x120, 0x140, 0x160, WHEELS] });
    h.d.start();
    await flush();
    // No poll yet: whether the car stands isn't known.
    expect(h.d.status).toEqual({ state: "waiting" });
    expect(h.surveys()).toBe(0);
    // Standing before the car moved: the engine may not run (a frozen RPM), the bus may be quiet.
    await h.stand(2);
    expect(h.surveys()).toBe(0);
    h.cruise(1);
    // One slice, then a poll before the next: the polls keep their turn.
    await h.stand(0.5);
    expect(h.surveys()).toBe(1);
    await flush();
    expect(h.surveys()).toBe(1);
    await h.stand(10);
    // 0x100–0x1FF sends 200 frames/s, over what the link carries: split until its halves don't.
    expect(h.slices.slice(1, 4)).toEqual([
      { prefix: 1, bits: 3 },
      { prefix: 2, bits: 4 },
      { prefix: 4, bits: 5 },
    ]);
    expect(h.surveys()).toBe(12);
    // The diagnostic answer isn't a candidate; three ids at 50 Hz fill the link's 150.
    expect(h.listens[0]).toEqual([0x100, 0x120, 0x140]);
    expect(h.d.searching).toBe(true);
    // Each batch's ids in the log as it starts: replay's marker of a drive on OBD, ended mid-batch or not.
    expect(h.notes).toContain("can discovery: listening to 100 120 140 for a speed, 0 of 5 ids tried");
    h.drive(1500);
    expect(h.d.status).toMatchObject({ state: "found" });
    expect(h.found.at(-1)?.key).toBe("found/4b0/8/b0be16s0x0.01o10000+b2be16s0x0.01o10000+b4be16s0x0.01o10000+b6be16s0x0.01o10000");
    expect(h.d.searching).toBe(false);
    expect(h.reports.map((r) => r.outcome)).toEqual(["found"]);
    const attrs = discoveryReportAttributes(h.reports[0], "6", "stn2255");
    expect(attrs).toMatchObject({ outcome: "found", make: "unknown", id: "4B0", len: 8 });
    expect(scrubLog({ message: "m", attributes: attrs }).attributes).toEqual(attrs);
    // The next drive: no survey, no search, the find at once.
    const next = harness({ busIds: [WHEELS], store: h.store });
    next.d.start();
    await flush();
    expect(next.surveys()).toBe(0);
    expect(next.found.at(-1)?.key).toBe(h.found.at(-1)?.key);
    expect(next.reports).toHaveLength(0);
  });

  test("the survey goes on at the next stop where it left off", async () => {
    const h = harness({ busIds: [0x100, WHEELS] });
    h.d.start();
    h.cruise(1);
    await h.stand(1.5);
    expect(h.surveys()).toBe(3);
    // The link's own refresh after a slice, its poll before the slice too old to tell: the survey goes on.
    h.advance(2.5);
    h.d.refresh();
    expect(h.d.status).toEqual({ state: "surveying" });
    h.cruise(10);
    expect(h.d.status).toEqual({ state: "waiting" });
    expect(h.surveys()).toBe(3);
    await h.stand(5);
    expect(h.surveys()).toBe(8);
    expect(h.listens.at(-1)).toEqual([0x100, WHEELS]);
  });

  test("a batch sized by the survey's rates and the link: busiest first, at least one", async () => {
    const bus = { busIds: [0x100, 0x120, 0x200, WHEELS], hz: { [WHEELS]: 100, 0x200: 100 } };
    const ble = harness({ ...bus, capacity: linkCapacity("ble") });
    ble.d.start();
    ble.cruise(1);
    await ble.stand(5);
    expect(ble.listens[0]).toEqual([0x200, 0x100]);
    const mfi = harness({ ...bus, capacity: linkCapacity("mfi") });
    mfi.d.start();
    mfi.cruise(1);
    await mfi.stand(5);
    expect(mfi.listens[0]).toEqual([0x200, WHEELS, 0x100, 0x120]);
    // An id busier than the link alone still gets its batch.
    const one = harness({ busIds: [0x100, WHEELS], hz: { [WHEELS]: 200 }, capacity: linkCapacity("ble") });
    one.d.start();
    one.cruise(1);
    await one.stand(8);
    expect(one.listens[0]).toEqual([WHEELS]);
  });

  test("a batch none of whose ids is heard: passed over after 3 s of listening, under the monitor's own 5 s", async () => {
    const h = harness({ busIds: [0x100, 0x120, 0x140, WHEELS], silent: [0x100, 0x120, 0x140] });
    h.d.start();
    h.cruise(1);
    await h.stand(10);
    expect(h.listens.at(-1)).toEqual([0x100, 0x120, 0x140]);
    // 0.28 s of listening each half second: 3 s of it in 5.5 s.
    h.drive(5);
    expect(h.listens.at(-1)).toEqual([0x100, 0x120, 0x140]);
    h.drive(1);
    expect(h.listens.at(-1)).toEqual([WHEELS]);
    expect(h.notes.some((n) => /not heard in 3\.\d s of listening/.test(n))).toBe(true);
  });

  test("a batch heard, then silent while driving: passed over after 3 s of listening without it", async () => {
    const h = harness({ busIds: [0x100, 0x120, 0x140, WHEELS], silentFrom: { 0x100: 31, 0x120: 31, 0x140: 31 } });
    h.d.start();
    h.cruise(1);
    await h.stand(10);
    expect(h.listens.at(-1)).toEqual([0x100, 0x120, 0x140]);
    h.drive(25);
    expect(h.listens.at(-1)).toEqual([0x100, 0x120, 0x140]);
    h.drive(6);
    expect(h.listens.at(-1)).toEqual([WHEELS]);
    expect(h.notes.some((n) => /100 120 140 silent for 3\.\d s of listening after being heard/.test(n))).toBe(true);
  });

  test("a silent batch at a stop with the engine off isn't passed over: some cars' ABS is quiet then", async () => {
    const h = harness({ busIds: [0x100, 0x120, 0x140, WHEELS], silent: [0x100, 0x120, 0x140] });
    h.d.start();
    h.cruise(1);
    await h.stand(10);
    h.engine(false);
    h.drive(20, [], () => 0);
    expect(h.listens.at(-1)).toEqual([0x100, 0x120, 0x140]);
    // The engine running, standing still: a speed is sent, the silence counts.
    h.engine(true);
    h.drive(6, [], () => 0);
    expect(h.listens.at(-1)).toEqual([WHEELS]);
  });

  test("a bus without a speed among its ids: none after every batch, the monitor off, reported once", async () => {
    const h = harness({ busIds: [0x100, 0x120, 0x140, 0x160] });
    h.d.start();
    h.cruise(1);
    await h.stand(10);
    h.drive(1500);
    expect(h.d.status).toEqual({ state: "none" });
    expect(h.listens.at(-1)).toBeNull();
    expect(h.reports.map((r) => r.outcome)).toEqual(["none"]);
    const again = harness({ busIds: [0x100], store: h.store });
    again.d.start();
    await flush();
    expect(again.d.status).toEqual({ state: "none" });
    expect(again.surveys()).toBe(0);
  });

  test("a survey that heard no id is a quiet bus: surveyed again once the car has driven; two such, a gateway", async () => {
    // Only the diagnostic answers at the port.
    const h = harness({ busIds: [] });
    h.d.start();
    h.cruise(1);
    await h.stand(10);
    expect(h.notes).toContain("can discovery: the survey heard no id at the port (a quiet bus), surveyed again once the car has driven");
    expect(h.d.status).toEqual({ state: "waiting" });
    expect(h.reports).toHaveLength(0);
    // Standing on: not again until the car has driven.
    const surveys = h.surveys();
    await h.stand(10);
    expect(h.surveys()).toBe(surveys);
    h.cruise(1);
    await h.stand(10);
    expect(h.notes).toContain("can discovery: no id heard at the port in 2 surveys (a gateway)");
    expect(h.d.status).toEqual({ state: "none" });
    expect(h.reports.map((r) => r.outcome)).toEqual(["none"]);
  });

  test("none concluded from a survey before ids heard were counted: surveyed again", async () => {
    const store = memoryStore();
    store.setJson(CAN_DISCOVERY_KEY, { [VIN]: { slices: [], hz: {}, candidates: [], tried: [], found: null, done: true } });
    const h = harness({ busIds: [WHEELS], store });
    h.d.start();
    h.cruise(1);
    await h.stand(10);
    expect(h.surveys()).toBeGreaterThan(0);
    h.drive(600);
    expect(h.d.status.state).toBe("found");
  });

  test("a find the car's OBD speed refutes in probation: the search goes on with the ids left", async () => {
    // Ranked by id at equal rates: the wheels in the first batch, two ids left after it.
    const h = harness({ busIds: [0x100, 0x120, WHEELS, 0x500, 0x520] });
    h.d.start();
    h.cruise(1);
    await h.stand(10);
    h.drive(600);
    expect(h.d.status.state).toBe("found");
    h.d.rejectFound();
    expect(h.d.searching).toBe(true);
    expect(h.listens.at(-1)).toEqual([0x500, 0x520]);
    expect((h.store.getJson(CAN_DISCOVERY_KEY) as Record<string, { found: unknown }>)[VIN].found).toBeNull();
  });

  test("the gyro's order of the find's wheels: kept with it, reported once, its wheels from the next drive", async () => {
    const h = harness({ busIds: [WHEELS] });
    h.d.start();
    h.cruise(1);
    await h.stand(5);
    h.drive(600);
    expect(h.d.status.state).toBe("found");
    const find = h.d.find!;
    const key = h.found.at(-1)!.key;
    expect(find.order).toBeUndefined();
    h.d.setOrder(find, { order: [1, 0, 3, 2], trackM: 1.6, frontTrackM: 1.58, wheelbaseM: 2.7 }, 300);
    // Not mid-drive: a drive replays on the one profile its notes name.
    expect(h.found.at(-1)!.key).toBe(key);
    expect(h.d.find!.order).toEqual([1, 0, 3, 2]);
    expect(h.reports.map((r) => r.outcome)).toEqual(["found", "wheels"]);
    const attrs = discoveryReportAttributes(h.reports[1], "6", "stn2255");
    expect(attrs).toMatchObject({ outcome: "wheels", wheels: "fl:1 fr:0 rl:3 rr:2", wheels_reason: "", track_cm: 160, wheelbase_cm: 270, duration_s: 300 });
    expect(scrubLog({ message: "m", attributes: attrs }).attributes).toEqual(attrs);
    // Ignition off: the next drive turns from them.
    h.d.nextDrive();
    expect(h.found.at(-1)!.key).toBe(`${key}/w1032`);
    expect(h.found.at(-1)!.wheels).toHaveLength(4);
    // As after the app starts again.
    const next = harness({ busIds: [WHEELS], store: h.store });
    next.d.start();
    await flush();
    expect(next.found.at(-1)!.key).toBe(`${key}/w1032`);
    expect(next.reports).toHaveLength(0);
  });

  test("fields the gyro says aren't four wheels: reported, the find kept as it is", async () => {
    const h = harness({ busIds: [WHEELS] });
    h.d.start();
    h.cruise(1);
    await h.stand(5);
    h.drive(600);
    const key = h.found.at(-1)!.key;
    h.d.setOrder(h.d.find!, { order: null, reason: "not two wheels a side" }, 600);
    h.d.nextDrive();
    expect(h.found.at(-1)!.key).toBe(key);
    expect(discoveryReportAttributes(h.reports.at(-1)!, "6", "stn2255")).toMatchObject({ outcome: "wheels", wheels: "", wheels_reason: "not two wheels a side" });
  });

  test("polls held up while moving: stopped for the drive", async () => {
    const h = harness({ busIds: [0x100, 0x120, WHEELS] });
    h.d.start();
    h.cruise(1);
    await h.stand(5);
    h.drive(60, [25, 35]);
    expect(h.d.status).toEqual({ state: "aborted" });
    expect(h.listens.at(-1)).toBeNull();
  });

  test("with the reports off, a find isn't reported, nor taken for reported", async () => {
    let on = false;
    const h = harness({ busIds: [WHEELS], reportsOn: () => on });
    h.d.start();
    h.cruise(1);
    await h.stand(5);
    h.drive(600);
    expect(h.d.status.state).toBe("found");
    expect(h.reports).toHaveLength(0);
    // Found again (another car of the kind, the same layout): reported now that the setting is on.
    on = true;
    h.store.setJson(CAN_DISCOVERY_KEY, {});
    const again = harness({ busIds: [WHEELS], store: h.store, reportsOn: () => on });
    again.d.start();
    again.cruise(1);
    await again.stand(5);
    again.drive(600);
    expect(again.reports.map((r) => r.outcome)).toEqual(["found"]);
  });

  test("not due while the make's own profiles are being tried, or before the car stands for the survey", async () => {
    const probing = harness({ busIds: [WHEELS], auto: "probing" });
    probing.d.start();
    await flush();
    expect(probing.d.status).toEqual({ state: "idle" });
    expect(probing.surveys()).toBe(0);
    const moving = harness({ busIds: [WHEELS] });
    moving.d.start();
    moving.cruise(1);
    await flush();
    expect(moving.d.status).toEqual({ state: "waiting" });
    // Standing with the engine off: the ECU awake isn't enough.
    moving.engine(false);
    await moving.stand(2);
    expect(moving.d.status).toEqual({ state: "waiting" });
    expect(moving.surveys()).toBe(0);
    moving.engine(true);
    await moving.stand(0.5);
    expect(moving.surveys()).toBe(1);
  });
});
