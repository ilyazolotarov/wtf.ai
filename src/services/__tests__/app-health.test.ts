import type { HealthReport, LaunchInfo, NativeProcessStats } from "../../../modules/sensor-capture/src/SensorCaptureModule";
import { AppHealth, endedMidTrip, launchNote, previousRunNote, reportNote, type AppHealthDeps } from "@/services/app-health";
import type { AppStatsRecord } from "@/triplog/schema";

const LAUNCH_MS = Date.UTC(2026, 9, 21, 12, 1, 10);

function harness(launch: Partial<LaunchInfo> = {}, reports: HealthReport[] = []) {
  let nowUs = 1_000_000_000;
  let cpuS = 10;
  let tick: (() => void) | null = null;
  let warn: ((level?: string) => void) | null = null;
  const records: AppStatsRecord[] = [];
  const notes: string[] = [];
  const sent: { message: string; extra: Record<string, unknown> }[] = [];
  const stats = (): NativeProcessStats => ({ footprintMb: 412.4, headroomMb: 1210, cpuS, thermal: "fair", lowPower: true, memoryWarnings: 0 });
  const deps: AppHealthDeps = {
    launchInfo: () => ({ wallMs: LAUNCH_MS, uptimeUs: 990_000_000, inBackground: false, reasons: [], ...launch }),
    processStats: async () => stats(),
    takeReports: () => reports.splice(0),
    onMemoryWarning: (l) => ((warn = l), () => (warn = null)),
    appState: () => "background",
    context: () => "recording u37h65",
    nowUs: () => nowUs,
    record: (r) => records.push(r),
    note: (t) => notes.push(t),
    report: (message, extra) => sent.push({ message, extra }),
    setInterval: (fn) => ((tick = fn), 1),
    clearInterval: () => (tick = null),
  };
  const health = new AppHealth(deps);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    health, records, notes, sent, flush,
    advance: async (s: number, cpu: number) => {
      nowUs += s * 1e6;
      cpuS += cpu;
      tick?.();
      await flush();
    },
    warn: (level?: string) => warn?.(level),
    ticking: () => tick !== null,
  };
}

test("every 5 s the process into the log: memory, headroom, CPU since the last record, thermal, app state", async () => {
  const h = harness();
  h.health.start();
  await h.flush();
  await h.advance(5, 2.5);
  expect(h.records).toHaveLength(2);
  expect(h.records[0].cpuPct).toBeNaN();
  expect(h.records[1]).toMatchObject({ footprintMb: 412.4, headroomMb: 1210, thermal: "fair", appState: "background", lowPower: true });
  expect(h.records[1].cpuPct).toBeCloseTo(50);
  h.health.stop();
  expect(h.ticking()).toBe(false);
});

test("a trip's start says how the process was launched; the first also how the run before ended and what the OS reported", () => {
  const h = harness(
    {
      inBackground: true,
      reasons: ["location"],
      previous: { wallMs: LAUNCH_MS - 25_000, appState: "background", context: "recording u37h65", footprintMb: 412, headroomMb: 300, thermal: "nominal", memoryWarnings: 2 },
    },
    [{ kind: "crash", atMs: LAUNCH_MS - 20_000, signal: 9, terminationReason: "Namespace RUNNINGBOARD" }],
  );
  h.health.tripStarted();
  expect(h.notes).toEqual([
    "app launched 10 s before this, in the background (location)",
    "previous run: last seen 25 s before this launch, background, recording u37h65, 412 MB, 300 MB to spare, 2 memory warnings; ended without notice",
    'iOS crash report 2026-10-21 12:00 UTC: signal 9, "Namespace RUNNINGBOARD"',
  ]);
  h.health.tripStarted();
  expect(h.notes.slice(3)).toEqual(["app launched 10 s before this, in the background (location)"]);
});

test("a run that ended mid-trip without notice goes to Sentry at launch; one the OS said it would end doesn't", () => {
  const prev = { wallMs: LAUNCH_MS - 25_000, appState: "background", context: "recording u37h65", footprintMb: 412, headroomMb: 300, thermal: "nominal", memoryWarnings: 0 };
  const killed = harness({ previous: prev });
  killed.health.start();
  expect(killed.sent).toEqual([expect.objectContaining({ message: "app ended mid-trip without notice" })]);
  expect(killed.sent[0].extra).toMatchObject({ secondsBeforeLaunch: 25, footprintMb: 412 });
  killed.health.stop();

  expect(endedMidTrip({ ...prev, willTerminateWallMs: LAUNCH_MS - 24_000 })).toBe(false);
  expect(endedMidTrip({ ...prev, context: "idle" })).toBe(false);
  expect(previousRunNote({ ...prev, willTerminateWallMs: prev.wallMs + 1000 }, LAUNCH_MS)).toMatch(/; the OS said it would end it 1 s after$/);
});

test("a memory warning is a note, with the memory last seen", async () => {
  const h = harness();
  h.health.start();
  await h.flush();
  h.warn("critical");
  expect(h.notes).toEqual(["app memory warning (critical); 412 MB, 1210 MB to spare at the last check"]);
  h.health.stop();
});

test("the OS reports in words", () => {
  expect(
    reportNote({
      kind: "exits",
      fromMs: Date.UTC(2026, 9, 20, 3),
      toMs: Date.UTC(2026, 9, 21, 3),
      foreground: { normal: 0, watchdog: 1 },
      background: { memoryPressure: 2, normal: 0 },
    }),
  ).toBe("iOS exits 2026-10-20 03:00 UTC to 2026-10-21 03:00 UTC: in front watchdog 1, background memory pressure 2");
  expect(reportNote({ kind: "exit", atMs: Date.UTC(2026, 9, 21, 12), reason: "low-memory", importance: "background", pssMb: 380.4, description: "lmk" })).toBe(
    "Android exit 2026-10-21 12:00 UTC: low-memory, background, 380 MB PSS; lmk",
  );
  expect(reportNote({ kind: "cpu", atMs: Date.UTC(2026, 9, 21, 12), cpuSeconds: 48.2, sampledSeconds: 60 })).toBe("iOS CPU report 2026-10-21 12:00 UTC: 48 s of CPU in 60 s");
  expect(launchNote({ wallMs: 0, uptimeUs: 0, inBackground: false, reasons: [] }, 3.4)).toBe("app launched 3 s before this, in front");
});

test("Android's wake is a launch reason only for a process it started", async () => {
  const woken = harness({ inBackground: true });
  woken.health.woken("ble in range");
  woken.health.woken("ble in range");
  woken.health.tripStarted();
  expect(woken.notes[0]).toBe("app launched 10 s before this, in the background (ble in range)");

  const open = harness();
  open.health.woken("ble in range");
  open.health.tripStarted();
  expect(open.notes[0]).toBe("app launched 10 s before this, in front");

  const old = harness({ inBackground: true });
  await old.advance(60, 0);
  old.health.woken("bluetooth connected");
  old.health.tripStarted();
  expect(old.notes[0]).toBe("app launched 70 s before this, in the background");
});
