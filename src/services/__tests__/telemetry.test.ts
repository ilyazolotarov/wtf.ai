// TelemetryReporter: which metrics come out of link and sensor changes (docs/ANDROID-SPEC.md §4.1).

import type { VehicleLinkSnapshot } from "@/obd/types";

import { adapterModel, TelemetryReporter, type MetricSink } from "../telemetry";

jest.mock("expo-device", () => ({ osVersion: "14", platformApiLevel: 34, manufacturer: "Acme", modelName: "Phone 1", isDevice: true }));
jest.mock("react-native", () => ({ Platform: { OS: "android" } }));
jest.mock("expo-updates", () => ({ isEnabled: false }));
jest.mock("@/services/kv-store", () => ({ kvStore: { getJson: jest.fn(() => null), setJson: jest.fn() } }));

type Call = [kind: string, name: string, value: number, attrs?: Record<string, string>];

function setup(flushEveryMs = 60_000) {
  const calls: Call[] = [];
  const sink: MetricSink = {
    count: (n, v, a) => calls.push(["count", n, v, a]),
    gauge: (n, v, a) => calls.push(["gauge", n, v, a]),
    distribution: (n, v, a) => calls.push(["distribution", n, v, a]),
  };
  let now = 1_000_000;
  const reporter = new TelemetryReporter(sink, () => now, flushEveryMs);
  return { calls, reporter, advance: (ms: number) => (now += ms) };
}

const snap = (link: VehicleLinkSnapshot["link"], extra: Partial<VehicleLinkSnapshot> = {}): VehicleLinkSnapshot =>
  ({
    link,
    error: null,
    devices: [],
    discovering: false,
    activeDeviceId: "x",
    adapter: { transport: "spp", name: "OBDII", chip: "ELM327 v2.1", description: null } as VehicleLinkSnapshot["adapter"],
    vehicle: null,
    protocolSearch: false,
    engine: "unknown",
    lastSpeed: null,
    lastRpm: null,
    stats: null,
    tryingSinceMs: null,
    ...extra,
  }) as VehicleLinkSnapshot;

describe("link metrics", () => {
  test("connect time from connecting to polling, with transport and adapter model", () => {
    const { calls, reporter, advance } = setup();
    reporter.onLink(snap("connecting"));
    advance(2500);
    reporter.onLink(snap("probing"));
    advance(1500);
    reporter.onLink(snap("polling"));
    expect(calls).toEqual([["distribution", "link.connect_ms", 4000, { transport: "spp", adapter_model: "elm327 v2.1" }]]);
  });

  test("a failed connect counts with its reason; the timer is cleared", () => {
    const { calls, reporter, advance } = setup();
    reporter.onLink(snap("connecting"));
    advance(1000);
    reporter.onLink(snap("error", { error: { code: "other", nativeCode: "timeout" } }));
    expect(calls).toEqual([["count", "link.connect_failed", 1, { transport: "spp", adapter_model: "elm327 v2.1", reason: "timeout" }]]);
    calls.length = 0;
    reporter.onLink(snap("connecting"));
    reporter.onLink(snap("error", { error: { code: "bluetooth-off" } }));
    expect(calls[0][3]?.reason).toBe("bluetooth-off");
    reporter.onLink(snap("polling"));
    expect(calls.some((c) => c[1] === "link.connect_ms")).toBe(false); // no connect time without a start
  });

  test("losing a working link counts once, and the reconnect time is measured", () => {
    const { calls, reporter, advance } = setup();
    reporter.onLink(snap("connecting"));
    reporter.onLink(snap("polling"));
    calls.length = 0;
    advance(10_000);
    reporter.onLink(snap("reconnecting"));
    reporter.onLink(snap("reconnecting"));
    advance(7000);
    reporter.onLink(snap("polling"));
    expect(calls.map((c) => c[1])).toEqual(["link.lost", "link.connect_ms"]);
    expect(calls[1][2]).toBe(7000);
  });

  test("poll rate and latency go out once per interval while polling", () => {
    const { calls, reporter, advance } = setup(60_000);
    const stats = { speedHz: 24, latencyP50Ms: 17, latencyP95Ms: 30, errorsLastMinute: 1, speedCapHz: 30 };
    reporter.onLink(snap("polling", { stats }));
    expect(calls).toHaveLength(0);
    advance(61_000);
    reporter.onLink(snap("polling", { stats }));
    expect(calls.map((c) => [c[1], c[2]])).toEqual([
      ["link.poll_rate_hz", 24],
      ["link.latency_p50_ms", 17],
      ["link.errors_last_minute", 1],
    ]);
  });

  test("the adapter model is a catalog name: lower case, no odd characters, never empty", () => {
    expect(adapterModel(snap("polling"))).toBe("elm327 v2.1");
    expect(adapterModel(snap("polling", { adapter: null }))).toBe("unknown");
    const odd = snap("polling", { adapter: { chip: "OBDLink® MX+ 12:34:56", description: null } as VehicleLinkSnapshot["adapter"] });
    expect(adapterModel(odd)).toBe("obdlink mx+ 1234:56".replace("1234:56", "123456"));
  });
});

describe("sensor metrics", () => {
  const running = { gnssRunning: true, imuRunning: true, gnssHz: 1, imuHz: 98 };

  test("rates, satellite share and the longest IMU gap while recording go out once per interval", () => {
    const { calls, reporter, advance } = setup(60_000);
    reporter.onGnssFix(true);
    reporter.onGnssFix(true);
    reporter.onGnssFix(false);
    reporter.onGnssFix(true);
    reporter.onImuBatch(true);
    advance(500);
    reporter.onImuBatch(true);
    advance(4000); // the sensors stall for 4 s (screen off)
    reporter.onImuBatch(true);
    reporter.onSensors(running, true);
    expect(calls).toHaveLength(0); // not yet a minute
    advance(60_000);
    reporter.onSensors(running, true);
    expect(calls.map((c) => [c[1], c[2]])).toEqual([
      ["gnss.fix_rate_hz", 1],
      ["imu.rate_hz", 98],
      ["gnss.satellite_share", 0.75],
      ["service.foreground_gap_s", 4],
    ]);
  });

  test("the gap is only measured while recording, and the window resets after a flush", () => {
    const { calls, reporter, advance } = setup(10_000);
    reporter.onImuBatch(false);
    advance(5000);
    reporter.onImuBatch(false);
    advance(10_000);
    reporter.onSensors(running, false);
    expect(calls.map((c) => c[1])).toEqual(["gnss.fix_rate_hz", "imu.rate_hz"]);
    calls.length = 0;
    // Recording starts: the first batch after 10 s of silence is a 10 s gap, then regular batches add nothing.
    reporter.onImuBatch(true);
    advance(100);
    reporter.onImuBatch(true);
    advance(10_000);
    reporter.onSensors(running, true);
    expect(calls.map((c) => c[1])).toEqual(["gnss.fix_rate_hz", "imu.rate_hz", "service.foreground_gap_s"]);
    expect(calls[2][2]).toBe(10);
  });

  test("stopped capture reports no rates", () => {
    const { calls, reporter, advance } = setup(10_000);
    advance(10_000);
    reporter.onSensors({ gnssRunning: false, imuRunning: false, gnssHz: 0, imuHz: 0 }, false);
    expect(calls).toHaveLength(0);
  });
});
