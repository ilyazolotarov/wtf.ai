// Deterministic trip log shared with the Python reader tests
// (tools/triplog/tests/data/fixture.ulg). Keep values in sync with tools/triplog/tests/test_reader.py.

import { TRIP_EVENTS, LOG_TAGS } from "../schema";
import { TripLogWriter, type ByteSink } from "../trip-log-writer";

export const FIXTURE_START_US = 10_000_000;
export const FIXTURE_UTC_US = 1_791_000_000_000_000;

export function buildFixture(): Uint8Array {
  const chunks: Uint8Array[] = [];
  const sink: ByteSink = { write: (b) => chunks.push(b), close: () => undefined };
  const w = new TripLogWriter(sink, {
    startUs: FIXTURE_START_US,
    utcUs: FIXTURE_UTC_US,
    info: {
      sys_name: "wtf.ai",
      ver_sw: "fixture",
      trip_id: "abc123",
      start_reason: "engine",
      adapter_transport: "emulator",
      adapter_elm: "ELM327 v1.5",
      vehicle_vin: "JM3KFBDM1J0123456",
      imu_frame: "xArbitraryZVertical",
    },
  });
  const t0 = FIXTURE_START_US;
  w.tripEvent(t0, TRIP_EVENTS.start);
  w.engineState(t0, 3);
  // 10 speed polls every 50 ms, raw = 10·i km/h; poll 5 has no data.
  for (let i = 0; i < 10; i++) {
    const noData = i === 5;
    w.obd({
      timestampUs: t0 + 50_000 * (i + 1),
      latencyUs: 40_000,
      mode: 1,
      pid: 0x0d,
      status: noData ? 1 : 0,
      data: noData ? [] : [i * 10],
      ecu: noData ? 0 : 0x7e8,
      value: noData ? NaN : (i * 10) / 3.6,
    });
  }
  w.obd({ timestampUs: t0 + 200_000, latencyUs: 30_000, mode: 1, pid: 0x0c, status: 0, data: [0x1a, 0xf8], ecu: 0x7e8, value: 1726 });
  for (let i = 0; i < 3; i++) {
    w.gnss({
      timestampUs: t0 + 1_000_000 * i,
      utcUs: FIXTURE_UTC_US + 1_000_000 * i,
      latDeg: 50.45 + i * 1e-4,
      lonDeg: 30.52,
      altMslM: 180,
      altEllipsoidM: 210,
      hAccM: 4.5,
      vAccM: 6,
      speedMps: 10 + i,
      speedAccMps: 0.5,
      courseRad: 0.25,
      courseAccRad: 0.1,
      deliveryDelayUs: 120_000,
      flags: 0,
    });
  }
  for (let i = 0; i < 100; i++) {
    w.imuMotion({
      timestampUs: t0 + 10_000 * i,
      gyro: [0, 0, 0.1],
      userAccel: [0.01 * i, 0, 0],
      gravity: [0, 0, -9.80665],
      attitude: [1, 0, 0, 0],
    });
  }
  // Raw magnetometer at 20 Hz: horizontal field rotating 1°/sample, 45 µT down.
  for (let i = 0; i < 20; i++) {
    const a = (i * Math.PI) / 180;
    w.magRaw({ timestampUs: t0 + 50_000 * i, v: [20 * Math.cos(a), 20 * Math.sin(a), -45] });
  }
  w.navEstimate({
    timestampUs: t0 + 1_500_000,
    latDeg: 50.4501,
    lonDeg: 30.52,
    accuracyM: 3.5,
    headingRad: 0.25,
    headingSigmaRad: 0.02,
    speedMps: 10.5,
    speedScale: 1.02,
    gnssLagS: -0.1,
    behindUs: 300_000,
    mode: "dr",
    source: "fused",
    trust: "TRUSTED",
    parkedPose: "confirmed",
  });
  w.linkStats({ timestampUs: t0 + 1_000_000, speedHz: 19.5, latencyP50Ms: 40, latencyP95Ms: 55, errors: 1, linkState: 6, batteryV: 14.2 });
  w.log("info", LOG_TAGS.elm, t0 + 1, "tx=10000000 ATI | ELM327 v1.5\\r\\r>");
  w.tripEvent(t0 + 3_000_000, TRIP_EVENTS.end, 0);
  w.close();
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
