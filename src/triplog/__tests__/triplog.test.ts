/// <reference types="node" />
import * as fs from "fs";
import * as path from "path";

import { readTripLog } from "@/triplog/trip-log-reader";
import { TripLogWriter, type ByteSink } from "@/triplog/trip-log-writer";
import { readULog } from "@/triplog/ulog/reader";
import { ULogEncoder } from "@/triplog/ulog/encoder";

import { buildFixture, FIXTURE_START_US } from "../__fixtures__/trip-fixture";

const FIXTURE_PATH = path.join(__dirname, "../../../tools/triplog/tests/data/fixture.ulg");

describe("ULog encoder/reader", () => {
  test("header and round trip of all field kinds", () => {
    const enc = new ULogEncoder(123_456_789_012);
    enc.infoString("sys_name", "wtf.ai — тест");
    enc.infoUint32("ver", 7);
    enc.infoInt64("utc", -5);
    enc.format({
      name: "m",
      fields: [
        { type: "uint64_t", name: "timestamp" },
        { type: "int64_t", name: "s64" },
        { type: "double", name: "d" },
        { type: "float", name: "f", count: 2 },
        { type: "int16_t", name: "i16" },
        { type: "char", name: "c", count: 4 },
      ],
    });
    enc.subscribe("m");
    enc.data("m", [2 ** 40 + 3, -(2 ** 33) - 1, Math.PI, [1.5, -2], -300, "ab"]);
    enc.tagged(54, 2, 99, "hello");
    enc.dropout(250);
    enc.sync();
    const bytes = enc.take();
    expect(Array.from(bytes.slice(0, 8))).toEqual([0x55, 0x4c, 0x6f, 0x67, 0x01, 0x12, 0x35, 0x01]);

    const f = readULog(bytes);
    expect(f.startUs).toBe(123_456_789_012);
    expect(f.info).toEqual({ sys_name: "wtf.ai — тест", ver: 7, utc: -5 });
    expect(f.data.m).toEqual([{ timestamp: 2 ** 40 + 3, s64: -(2 ** 33) - 1, d: Math.PI, f: [1.5, -2], i16: -300, c: "ab" }]);
    expect(f.logs).toEqual([{ level: 54, tag: 2, timestampUs: 99, text: "hello" }]);
    expect(f.dropoutsMs).toEqual([250]);
    expect(f.syncCount).toBe(1);
    expect(f.truncated).toBe(false);
  });

  test("formats must precede data; late info overrides the header", () => {
    const enc = new ULogEncoder(0);
    enc.infoString("vin", "");
    enc.format({ name: "m", fields: [{ type: "uint64_t", name: "timestamp" }] });
    enc.subscribe("m");
    expect(() => enc.format({ name: "n", fields: [{ type: "uint64_t", name: "timestamp" }] })).toThrow();
    enc.infoString("vin", "JM3KFBDM1J0123456");
    expect(readULog(enc.take()).info.vin).toBe("JM3KFBDM1J0123456");
  });

  test("truncated file is still readable", () => {
    const bytes = buildFixture();
    const f = readULog(bytes.slice(0, bytes.length - 7));
    expect(f.truncated).toBe(true);
    expect(f.data.imu_motion.length).toBe(100);
  });
});

describe("TripLogWriter", () => {
  test("fixture content and sizes", () => {
    const f = readULog(buildFixture());
    expect(f.startUs).toBe(FIXTURE_START_US);
    expect(f.info.wtf_log_ver).toBe(1);
    expect(f.info.vehicle_vin).toBe("JM3KFBDM1J0123456");
    expect(f.data.obd_pid).toHaveLength(11);
    expect(f.data.obd_pid[3]).toMatchObject({ pid: 13, status: 0, n_bytes: 1, data: [30, 0, 0, 0], ecu: 0x7e8 });
    expect(f.data.obd_pid[5]).toMatchObject({ status: 1, n_bytes: 0 });
    expect(f.data.gnss[2]).toMatchObject({ lat_deg: 50.4502, speed_mps: 12 });
    expect(f.data.imu_motion).toHaveLength(100);
    expect(f.data.time_sync[0].utc_us).toBe(1_791_000_000_000_000);
    expect(f.data.trip_event.map((e) => e.event)).toEqual([0, 1]);
    expect(f.logs[0].tag).toBe(1);
    expect(readTripLog(buildFixture()).navEstimate).toEqual([
      expect.objectContaining({ tUs: FIXTURE_START_US + 1_500_000, latDeg: 50.4501, behindUs: 300_000, mode: "dr", source: "fused", trust: "TRUSTED", parkedPose: "confirmed" }),
    ]);
  });

  test("flushes on interval with a sync message, closes the sink", () => {
    const writes: number[] = [];
    let closed = false;
    const sink: ByteSink = { write: (b) => writes.push(b.length), close: () => (closed = true) };
    const w = new TripLogWriter(sink, { startUs: 0, utcUs: 0, info: {} });
    const afterHeader = writes.length;
    w.engineState(10, 3);
    w.tick(500_000, 0);
    expect(writes.length).toBe(afterHeader);
    w.tick(1_000_000, 0);
    expect(writes.length).toBe(afterHeader + 1);
    w.close();
    expect(closed).toBe(true);
  });

  test("drops IMU and records a dropout when the buffer is over budget", () => {
    const chunks: Uint8Array[] = [];
    const w = new TripLogWriter(
      { write: (b) => chunks.push(b), close: () => undefined },
      { startUs: 0, utcUs: 0, info: {} },
      { maxBufferBytes: 1000, flushBytes: 1e9, flushIntervalUs: 1e12 },
    );
    const imu = (t: number) => ({ timestampUs: t, gyro: [0, 0, 0], userAccel: [0, 0, 0], gravity: [0, 0, 0], attitude: [1, 0, 0, 0] }) as const;
    for (let i = 0; i < 50; i++) w.imuMotion(imu(i * 10_000));
    w.flush();
    w.imuMotion(imu(600_000));
    w.close();
    const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of chunks) {
      all.set(c, off);
      off += c.length;
    }
    const f = readULog(all);
    expect(f.data.imu_motion.length).toBeLessThan(50);
    expect(f.dropoutsMs.length).toBe(1);
  });
});

describe("golden fixture (shared with tools/triplog)", () => {
  test("bytes match the committed fixture", () => {
    const bytes = buildFixture();
    if (process.env.UPDATE_TRIPLOG_FIXTURE || !fs.existsSync(FIXTURE_PATH)) {
      fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
      fs.writeFileSync(FIXTURE_PATH, bytes);
    }
    expect(Buffer.from(bytes).equals(fs.readFileSync(FIXTURE_PATH))).toBe(true);
  });
});
