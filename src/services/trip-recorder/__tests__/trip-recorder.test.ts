import { VirtualClock, yieldMacrotask } from "@/obd/clock";
import { Emitter } from "@/obd/emitter";
import { Elm327Emulator } from "@/obd/emulator";
import { VehicleLinkCore, type KeyValueStore } from "@/obd/vehicle-link-core";
import type { SensorService } from "@/services/sensor-capture/sensor-service";
import type { TripFiles } from "@/services/trip-recorder/trip-files";
import { TripRecorder } from "@/services/trip-recorder/trip-recorder";
import type { GnssRecord } from "@/triplog/schema";
import { readULog } from "@/triplog/ulog/reader";

jest.setTimeout(60_000);

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

function memoryFiles() {
  const files = new Map<string, Uint8Array[]>();
  const api: TripFiles = {
    create(name) {
      files.set(name, []);
      return { uri: `mem://${name}`, write: (b) => files.get(name)!.push(b), close: () => undefined };
    },
    list: () => [...files.entries()].map(([name, chunks]) => ({ name, uri: `mem://${name}`, size: chunks.reduce((n, c) => n + c.length, 0) })),
    remove: (name) => void files.delete(name),
    uri: (name) => `mem://${name}`,
    archive: (name) => `mem://${name}`,
    freeBytes: () => 10 * 1024 ** 3,
  };
  const bytes = (name: string) => {
    const chunks = files.get(name)!;
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  };
  return { api, bytes };
}

function fakeSensors() {
  const gnss = new Emitter<[GnssRecord]>();
  const imu = new Emitter<[{ motion: never[]; gyro: never[]; accel: never[]; mag: never[] }]>();
  const wanted = { gnss: false, imu: false };
  const sensors = {
    gnss,
    imu,
    want: (g: boolean, i: boolean) => Object.assign(wanted, { gnss: g, imu: i }),
    setImuSettings: () => undefined,
  } as unknown as SensorService;
  return { sensors, gnss, wanted };
}

async function until(cond: () => boolean, maxTicks = 300_000) {
  for (let i = 0; i < maxTicks && !cond(); i++) await new Promise<void>((r) => yieldMacrotask(r));
  if (!cond()) throw new Error("condition not reached");
}

test("engine start → recording → key off → complete ULog trip", async () => {
  const clock = new VirtualClock();
  const emu = new Elm327Emulator(clock);
  emu.setVehicle({ ignition: true, rpm: 0, speedKph: 0 });
  const store = new MemoryStore();
  const link = new VehicleLinkCore({
    clock,
    store,
    discovery: { start: (cb) => cb([{ id: "emu", transport: "emulator", name: "OBDII", lastSeenUs: 0 }]), stop: () => undefined },
    createTransport: () => emu,
  });
  const { api, bytes } = memoryFiles();
  const { sensors, gnss, wanted } = fakeSensors();
  const recorder = new TripRecorder({
    link,
    sensors,
    files: api,
    store,
    nowUs: clock.nowUs,
    appInfo: () => ({ sys_name: "wtf.ai", ver_sw: "test" }),
  });
  recorder.start();
  link.startDiscovery();
  void link.connect("emu");
  try {

  // ECU awake, engine off → armed with pre-roll sensors.
  await until(() => link.getSnapshot().engine === "engine-off");
  expect(recorder.getSnapshot().state).toBe("armed");
  expect(wanted).toEqual({ gnss: true, imu: true });

  emu.setVehicle({ rpm: 900 });
  await until(() => recorder.getSnapshot().state === "recording");
  emu.setVehicle({ speedKph: 30 });
  const fix = (t: number, latDeg = 50.45, satellite = true): GnssRecord => ({
    timestampUs: t, utcUs: 1.79e15, latDeg, lonDeg: 30.52, altMslM: 180, altEllipsoidM: 210, hAccM: satellite ? 4 : 40,
    vAccM: 6, speedMps: satellite ? 8.3 : NaN, speedAccMps: 0.4, courseRad: 1, courseAccRad: 0.1, deliveryDelayUs: 1000, flags: 0,
  });
  // Jammed GNSS: Wi-Fi/cell fixes (no speed) don't add distance, even with h_acc < 50 m.
  gnss.emit(fix(clock.nowUs(), 50.45));
  gnss.emit(fix(clock.nowUs(), 50.451, false));
  gnss.emit(fix(clock.nowUs(), 50.451));
  gnss.emit(fix(clock.nowUs(), 50.452));
  const t0 = clock.nowUs();
  await until(() => clock.nowUs() - t0 > 3_000_000);
  recorder.tick();
  expect(recorder.getSnapshot().current?.distanceM).toBeCloseTo(111.2, 0);

  emu.setVehicle({ ignition: false, rpm: 0, speedKph: 0 });
  await until(() => recorder.getSnapshot().state === "lingering");
  expect(wanted).toEqual({ gnss: true, imu: false });

  const trip = recorder.getSnapshot().trips[0];
  expect(trip).toMatchObject({ complete: true, endReason: "ignition-off", startReason: "engine" });
  const log = readULog(bytes(trip.fileName));
  expect(log.truncated).toBe(false);
  expect(log.info).toMatchObject({
    sys_name: "wtf.ai",
    adapter_elm: "ELM327 v1.5",
    vehicle_vin: "JM3KFBDM1J0123456",
    vehicle_vin_source: "read",
    start_reason: "engine",
  });
  // The adapter setup ran before the engine state was known (no pre-roll yet): it opens the log, with its age.
  const before = log.logs.filter((l) => l.text.includes(" s before the log: "));
  expect(before.map((l) => l.text.replace(/^.* s before the log: /, "").replace(/tx=\d+ /, "").split(" |")[0])).toEqual(
    expect.arrayContaining(["ATZ", "ATSP0", "0100", "ATDPN", "0902", "initialized: A6 010D1"]),
  );
  expect(before.every((l) => l.timestampUs === before[0].timestampUs && /^\d+\.\d s/.test(l.text))).toBe(true);
  const speeds = log.data.obd_pid.filter((r) => r.pid === 0x0d && r.status === 0);
  expect(speeds.length).toBeGreaterThan(20);
  expect(speeds.some((r) => (r.data as number[])[0] === 30)).toBe(true);
  expect(log.data.obd_pid.some((r) => r.pid === 0x0c)).toBe(true);
  expect(log.data.gnss).toHaveLength(4);
  expect(log.data.trip_event.map((e) => [e.event, e.reason])).toEqual([[0, 0], [1, 0]]);
  // Running at trip start (not the link snapshot's stale "engine-off"), then ignition off.
  expect(log.data.engine_state.map((e) => e.state)).toEqual([3, 3, 1]);
  expect(log.data.link_stats.length).toBeGreaterThanOrEqual(1);
  } finally {
    recorder.stop();
    await link.disconnect();
  }
});
