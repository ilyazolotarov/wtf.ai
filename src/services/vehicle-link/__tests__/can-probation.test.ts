import type { CanSpeed } from "@/nav/odometry/can/can-speed";
import { discoveredProfile, tidy } from "@/nav/odometry/can/discovery";
import { profileByKey } from "@/nav/odometry/can/profile";
import type { SpeedSample } from "@/obd/types";
import { scrubLog } from "@/config/sentry-scrub";
import { CAN_PROBATION_KEY, CanProbation, probationReportAttributes, type CanProbationReport } from "@/services/vehicle-link/can-probation";

const PROFILE = profileByKey("mazda/mazda/mazda_2017")!;
const VIN = "JM1AAAAAA00000000";

function memoryStore() {
  const m = new Map<string, unknown>();
  return { getJson: <T>(k: string) => (m.get(k) as T) ?? null, setJson: (k: string, v: unknown) => void m.set(k, v) };
}

function harness(store = memoryStore(), scope = "stn2255 v5.13.1|1.0.0", reportsOn?: () => boolean) {
  let now = 0;
  const obd = new Set<(s: SpeedSample) => void>();
  const can = new Set<(s: CanSpeed) => void>();
  const calls = { trusted: [] as boolean[], promoted: 0, stopped: 0 };
  const reports: CanProbationReport[] = [];
  const notes: string[] = [];
  /** The monitor's stops and the statuses, in order. */
  const events: string[] = [];
  const p = new CanProbation({
    vin: () => VIN,
    nowUs: () => now,
    onSpeed: (l) => (obd.add(l), () => obd.delete(l)),
    onCanSpeed: (l) => (can.add(l), () => can.delete(l)),
    onFrames: () => () => {},
    onWindow: () => () => {},
    setTrusted: (on) => calls.trusted.push(on),
    promote: () => calls.promoted++,
    stopListening: () => {
      calls.stopped++;
      events.push("stop listening");
    },
    reportScope: () => scope,
    ...(reportsOn ? { reportsOn } : {}),
    report: (r) => reports.push(r),
    store,
    note: (t) => notes.push(t),
    onStatus: (s) => events.push(s.state),
  });
  p.start();
  /** A stop-and-go drive: polls at 2 Hz, CAN samples in their breaks; `scale` on the CAN speed; nothing for `gapS` from each `lateAt` (s). */
  const drive = (seconds: number, scale = 1, lateAt: number[] = [], gapS = 3) => {
    for (let ms = 0; ms <= seconds * 1000; ms += 100) {
      now = ms * 1000;
      const tS = ms / 1000;
      const c = tS % 60;
      const kph = c < 10 ? 0 : c < 20 ? (c - 10) * 5 : c < 45 ? 50 : c < 55 ? (55 - c) * 5 : 0;
      if (lateAt.some((t) => tS > t && tS < t + gapS)) continue;
      if (ms % 500 === 0) obd.forEach((l) => l({ txUs: now - 20_000, rxUs: now + 20_000, tUs: now, speedMps: kph / 3.6, raw: Math.round(kph) }));
      else can.forEach((l) => l({ tUs: now, speedMps: (kph * scale) / 3.6, wheelsMps: null, gear: "D", reverse: false }));
    }
  };
  return { p, calls, reports, notes, events, drive, store };
}

describe("CAN probation (VEHICLE-LINK-SPEC §16.5)", () => {
  test("a new car's profile: checked against OBD, then the navigator's from the pass, kept for the VIN", () => {
    const h = harness();
    expect(h.p.admit(PROFILE)).toBe(false);
    expect(h.calls.trusted).toEqual([false]);
    expect(h.p.status).toEqual({ state: "checking", profile: PROFILE.key });
    h.drive(600);
    expect(h.p.status).toEqual({ state: "passed", profile: PROFILE.key });
    expect(h.calls).toMatchObject({ trusted: [false, true], promoted: 1, stopped: 0 });
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({ outcome: "pass", reason: null, make: "mazda", profile: PROFILE.key, from: "wheels" });
    expect(JSON.stringify(h.reports[0])).not.toContain(VIN);
    // The next drive: no probation.
    const next = harness(h.store);
    expect(next.p.admit(PROFILE)).toBe(true);
    expect(next.calls.trusted).toEqual([true]);
    expect(next.reports).toHaveLength(0);
  });

  test("a find's wheels' order, learned after its pass, changes no speed: the pass holds", () => {
    const fields = tidy([0, 2, 4, 6].map((byte) => ({ byte, endian: "be" as const, shift: 0, bits: 16, kphPerCount: 0.01, offset: 10000, r: 0.999 })));
    const find = { id: 0x4b0, len: 8, fields, pairs: 200, rangeKph: 60 };
    const h = harness();
    expect(h.p.admit(discoveredProfile("unknown", find))).toBe(false);
    h.drive(600);
    expect(h.p.status.state).toBe("passed");
    const next = harness(h.store);
    const ordered = discoveredProfile("unknown", { ...find, order: [1, 0, 3, 2] });
    expect(next.p.admit(ordered)).toBe(true);
    expect(next.p.status).toEqual({ state: "passed", profile: ordered.key });
  });

  test("a profile that misreads the speed: OBD stays, the monitor off, and on the next drive too", () => {
    const h = harness();
    h.p.admit(PROFILE);
    h.drive(600, 1.609);
    expect(h.p.status).toEqual({ state: "failed", profile: PROFILE.key, reason: "scale" });
    expect(h.calls).toMatchObject({ trusted: [false], promoted: 0, stopped: 1 });
    expect(h.reports.map((r) => [r.outcome, r.reason])).toEqual([["fail", "scale"]]);
    expect(h.store.getJson(CAN_PROBATION_KEY)).toEqual({ [VIN]: { profile: PROFILE.key, pass: false, reason: "scale" } });
    // The monitor off before the fail is told: a found layout's fail starts the search's next ids from the status
    // (VEHICLE-LINK-SPEC §16.6), which a later stop would cut off.
    expect(h.events).toEqual(["checking", "stop listening", "failed"]);
    const next = harness(h.store);
    expect(next.p.admit(PROFILE)).toBe(false);
    expect(next.calls.stopped).toBe(1);
    expect(next.events).toEqual(["stop listening", "failed"]);
    // Forgotten (the driver turned the wheels' speed off and on): checked again.
    next.p.forgetFailed();
    expect(harness(next.store).p.admit(PROFILE)).toBe(false);
    expect(next.store.getJson(CAN_PROBATION_KEY)).toEqual({});
  });

  test("polls held up while moving: probation ends for the drive, nothing kept, reported once", () => {
    const store = memoryStore();
    const h = harness(store);
    h.p.admit(PROFILE);
    h.drive(120, 1, [25, 35]);
    expect(h.p.status).toEqual({ state: "aborted", profile: PROFILE.key });
    expect(h.calls.stopped).toBe(1);
    expect(h.reports.map((r) => r.outcome)).toEqual(["aborted"]);
    expect(store.getJson(CAN_PROBATION_KEY)).toBeNull();
    // The same again with the same adapter and app: not reported twice.
    const again = harness(store);
    again.p.admit(PROFILE);
    again.drive(120, 1, [25, 35]);
    expect(again.p.status.state).toBe("aborted");
    expect(again.reports).toHaveLength(0);
  });

  test("with the reports off, nothing is reported, nor taken for reported: on again, the next one goes", () => {
    const store = memoryStore();
    let on = false;
    const h = harness(store, undefined, () => on);
    h.p.admit(PROFILE);
    h.drive(120, 1, [25, 35]);
    expect(h.p.status.state).toBe("aborted");
    expect(h.reports).toHaveLength(0);
    on = true;
    const again = harness(store, undefined, () => on);
    again.p.admit(PROFILE);
    again.drive(120, 1, [25, 35]);
    expect(again.reports.map((r) => r.outcome)).toEqual(["aborted"]);
  });

  test("the link lost for a while isn't a late poll", () => {
    const h = harness();
    h.p.admit(PROFILE);
    h.drive(90, 1, [25, 85], 20);
    expect(h.p.status.state).toBe("checking");
    expect(h.calls.stopped).toBe(0);
  });

  test("the report's attributes get through the Sentry scrubber whole, and carry no VIN", () => {
    const h = harness();
    h.p.admit(PROFILE);
    h.drive(600);
    const attrs = probationReportAttributes(h.reports[0], "A6", "stn2255 v5.13.1");
    expect(scrubLog({ message: "can probation: pass", attributes: attrs }).attributes).toEqual(attrs);
    expect(attrs).toMatchObject({ outcome: "pass", make: "mazda", protocol: "A6", stand_pct: 100 });
    expect(attrs.scale_pct).toBeCloseTo(100, 0);
    expect(attrs.correlation_pct as number).toBeGreaterThan(99);
    expect(Object.values(attrs).some((v) => String(v).includes(VIN.slice(0, 8)))).toBe(false);
  });
});
