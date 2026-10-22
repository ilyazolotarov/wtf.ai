import { VirtualClock } from "@/obd/clock";
import { Emitter } from "@/obd/emitter";
import { VehicleLinkCore, type KeyValueStore } from "@/obd/vehicle-link-core";
import type { SensorService } from "@/services/sensor-capture/sensor-service";
import type { TripFiles } from "@/services/trip-recorder/trip-files";
import { MANUAL_RESUME_WITHIN_MS, TripRecorder } from "@/services/trip-recorder/trip-recorder";

// A manual recording the system ended with the app (TRIP-LOGGER-SPEC §4.3) starts again at the next start.

class MemoryStore implements KeyValueStore {
  data = new Map<string, string>();
  getJson<T>(key: string): T | null {
    const v = this.data.get(key);
    return v === undefined ? null : (JSON.parse(v) as T);
  }
  setJson(key: string, value: unknown): void {
    this.data.set(key, JSON.stringify(value));
  }
}

function memoryFiles(): TripFiles {
  const files = new Map<string, number>();
  return {
    create(name) {
      files.set(name, 0);
      return { uri: `mem://${name}`, write: (b) => files.set(name, files.get(name)! + b.length), close: () => undefined };
    },
    list: () => [...files.entries()].map(([name, size]) => ({ name, uri: `mem://${name}`, size })),
    remove: (name) => void files.delete(name),
    uri: (name) => `mem://${name}`,
    archive: (name) => `mem://${name}`,
    freeBytes: () => 10 * 1024 ** 3,
  };
}

const sensors = {
  gnss: new Emitter(),
  imu: new Emitter(),
  want: () => undefined,
} as unknown as SensorService;

const live: TripRecorder[] = [];
// The recorders' timers; stopping ends a recording, after the test has looked.
afterEach(() => live.splice(0).forEach((r) => r.stop()));

/** One app process: its recorder over the phone's storage and files, which outlive it. */
function process(phone: { store: MemoryStore; files: TripFiles; wallMs: { now: number } }) {
  const clock = new VirtualClock();
  const link = new VehicleLinkCore({
    clock,
    store: phone.store,
    discovery: { start: () => undefined, stop: () => undefined },
    createTransport: () => {
      throw new Error("no adapter");
    },
  });
  const recorder = new TripRecorder({
    link,
    sensors,
    files: phone.files,
    store: phone.store,
    nowUs: clock.nowUs,
    wallMs: () => phone.wallMs.now,
    appInfo: () => ({ sys_name: "wtf.ai", ver_sw: "test" }),
  });
  recorder.start();
  recorder.resumeManual();
  live.push(recorder);
  return recorder;
}

function phone() {
  return { store: new MemoryStore(), files: memoryFiles(), wallMs: { now: 1_800_000_000_000 } };
}

const manualLogs = (p: ReturnType<typeof phone>) => p.files.list().filter((f) => f.name.endsWith("_manual.ulg"));

test("the system ends the app mid-recording: the next start records again, in a new log", () => {
  const p = phone();
  process(p).manualStart();
  // Ended without a stop (no `stop()`, as with a kill); started again a minute later.
  p.wallMs.now += 60_000;
  const next = process(p);
  expect(next.getSnapshot().state).toBe("recording");
  expect(next.getSnapshot().current?.startReason).toBe("manual");
  expect(manualLogs(p)).toHaveLength(2);
});

test("stopped by the driver: nothing starts again", () => {
  const p = phone();
  const first = process(p);
  first.manualStart();
  first.manualStop();
  const next = process(p);
  expect(next.getSnapshot().state).not.toBe("recording");
  expect(manualLogs(p)).toHaveLength(1);
});

test("opened long after: no recording the driver has forgotten about", () => {
  const p = phone();
  process(p).manualStart();
  p.wallMs.now += MANUAL_RESUME_WITHIN_MS + 1000;
  const next = process(p);
  expect(next.getSnapshot().state).not.toBe("recording");
  // Not on the start after that either.
  p.wallMs.now -= MANUAL_RESUME_WITHIN_MS;
  expect(process(p).getSnapshot().state).not.toBe("recording");
});

test("a long recording keeps saying it is on: ended an hour in, it still starts again", () => {
  const p = phone();
  const first = process(p);
  first.manualStart();
  for (let s = 0; s < 3600; s++) {
    p.wallMs.now += 1000;
    first.tick();
  }
  p.wallMs.now += 30_000;
  expect(process(p).getSnapshot().state).toBe("recording");
});
