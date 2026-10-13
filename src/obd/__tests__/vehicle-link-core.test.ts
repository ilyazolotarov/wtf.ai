import { VirtualClock, yieldMacrotask } from "@/obd/clock";
import { Elm327Emulator, KLINE_PROFILE, STN_PROFILE, type EmulatorProfile } from "@/obd/emulator";
import type { CanFrame } from "@/obd/can-monitor";
import type { CanWindow } from "@/obd/can-shadow";
import {
  AUTO_CONNECT_WINDOW_MS,
  OBD_SPEED_HZ,
  VehicleLinkCore,
  type DiscoveryBackend,
  type KeyValueStore,
  type KnownCar,
  type RememberedAdapter,
  type ScannedDevice,
} from "@/obd/vehicle-link-core";
import type { ExchangeEvent, LinkEvent, LinkState, SpeedSample } from "@/obd/types";

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

class FakeDiscovery implements DiscoveryBackend {
  devices: ScannedDevice[] = [];
  /** MFi accessories iOS has connected. */
  mfi: string[] = [];
  /** The scan's own end (its time limit), as the native backend reports it. */
  onStopped: (() => void) | null = null;
  start(onUpdate: (d: ScannedDevice[]) => void, onStopped?: () => void) {
    this.onStopped = onStopped ?? null;
    onUpdate(this.devices);
  }
  stop() {
    this.onStopped = null;
  }
  mfiPresent() {
    return this.mfi;
  }
}

const CX5_VIN = "JM3KFBDM1J0123456";
/** The store of an app that has seen the CX-5 (VIN read) through adapter emu-1 on CAN (protocol 6). */
function storeWithCx5(): MemoryStore {
  const store = new MemoryStore();
  store.setJson("vehicleLink.adapters", [
    { id: "emu-1", transport: "emulator", name: "OBDII", protocolNumber: 6, lastVerifiedAt: 500 },
  ] satisfies RememberedAdapter[]);
  store.setJson("vehicleLink.cars", [{ vin: CX5_VIN, protocolNumber: 6, seenAt: 500 }] satisfies KnownCar[]);
  return store;
}

async function until(cond: () => boolean, maxTicks = 200_000) {
  for (let i = 0; i < maxTicks && !cond(); i++) await new Promise<void>((r) => yieldMacrotask(r));
  if (!cond()) throw new Error("condition not reached");
}

function setup(profile: Partial<EmulatorProfile> = {}, store = new MemoryStore()) {
  const clock = new VirtualClock();
  const emulators = new Map<string, Elm327Emulator>();
  const discovery = new FakeDiscovery();
  discovery.devices = [
    { id: "emu-1", transport: "emulator", name: "OBDII", rssi: -60, lastSeenUs: 0 },
    { id: "headphones", transport: "emulator", name: "AirPods", rssi: -40, lastSeenUs: 0 },
  ];
  const core = new VehicleLinkCore({
    clock,
    discovery,
    store,
    nowMs: () => 1_000,
    createTransport: (d) => {
      let emu = emulators.get(d.id);
      if (!emu) {
        emu = new Elm327Emulator(clock, d.id === "headphones" ? { isElm: false } : profile);
        emulators.set(d.id, emu);
      }
      return emu;
    },
  });
  const states: LinkState[] = [];
  core.subscribe(() => {
    const s = core.getSnapshot().link;
    if (states[states.length - 1] !== s) states.push(s);
  });
  const events: LinkEvent[] = [];
  core.onLinkEvent((e) => events.push(e));
  return { clock, core, emulators, store, states, discovery, events };
}

describe("VehicleLinkCore", () => {
  test("discovery ranks adapters above other devices", () => {
    const { core } = setup();
    core.startDiscovery();
    expect(core.getSnapshot().devices.map((d) => [d.id, d.rank])).toEqual([
      ["emu-1", "known-name"],
      ["headphones", "unknown"],
    ]);
  });

  test("the scan ending by itself ends discovering; an old scan's end doesn't touch a new one", () => {
    const { core, discovery } = setup();
    core.startDiscovery();
    expect(core.getSnapshot().discovering).toBe(true);
    const first = discovery.onStopped!;
    first();
    expect(core.getSnapshot().discovering).toBe(false);
    // Scan again: the first scan's end, reported late, doesn't stop this one.
    core.startDiscovery();
    first();
    expect(core.getSnapshot().discovering).toBe(true);
    core.stopDiscovery();
    expect(core.getSnapshot().discovering).toBe(false);
  });

  test("connect → probe → init → polling, remembered for auto-connect", async () => {
    const { core, states, store, emulators } = setup();
    core.startDiscovery();
    const exchanges: ExchangeEvent[] = [];
    core.onExchange((e) => exchanges.push(e));
    void core.connect("emu-1");
    await until(() => core.getSnapshot().link === "polling" && core.getSnapshot().lastSpeed !== null);
    expect(states).toEqual(["idle", "connecting", "probing", "initializing", "polling"]);
    // Running is confirmed by a second, different RPM reading (§10.4).
    await until(() => core.getSnapshot().engine === "engine-running");
    const snap = core.getSnapshot();
    expect(snap.adapter?.elmVersion).toBe("ELM327 v1.5");
    expect(snap.vehicle?.vin).toBe("JM3KFBDM1J0123456");
    expect(exchanges.some((e) => e.pollPid === 0x0d && e.status === "ok")).toBe(true);
    expect(exchanges.some((e) => e.command === "ATZ")).toBe(true);

    await core.disconnect();
    expect(core.getSnapshot().link).toBe("idle");
    expect(store.getJson<{ id: string; protocolNumber: number }[]>("vehicleLink.adapters")?.[0]).toMatchObject({
      id: "emu-1",
      protocolNumber: 6,
    });

    // A fresh app start auto-connects to the remembered adapter, and knows its car before connecting.
    expect(setup().core.expectedVin()).toBeNull();
    const second = setup({}, store);
    expect(second.core.expectedVin()).toBe("JM3KFBDM1J0123456");
    second.emulators.set("emu-1", emulators.get("emu-1")!);
    expect(await second.core.autoConnect()).toBe(true);
    await until(() => second.core.getSnapshot().link === "polling");
    await second.core.disconnect();
  });

  test("auto-connect waits for the adapter and retries after a failed attempt", async () => {
    const { core, store, emulators } = setup();
    core.startDiscovery();
    void core.connect("emu-1");
    await until(() => core.getSnapshot().link === "polling");
    await core.disconnect();

    // Next app start: the adapter isn't reachable yet and the first attempt fails.
    const second = setup({}, store);
    const emu = emulators.get("emu-1")!;
    second.emulators.set("emu-1", emu);
    const connect = jest
      .spyOn(emu, "connect")
      .mockRejectedValueOnce(Object.assign(new Error("not reachable"), { code: "device-not-found" }));
    await second.core.autoConnect();
    expect(second.core.getSnapshot()).toMatchObject({ link: "error", activeDeviceId: "emu-1" });
    expect(connect).toHaveBeenLastCalledWith({ wait: true });

    // Returning to the foreground retries instead of leaving the error until "Disconnect".
    expect(await second.core.autoConnect()).toBe(true);
    await until(() => second.core.getSnapshot().link === "polling");
    await second.core.disconnect();
  });

  test("non-ELM device is rejected", async () => {
    const { core } = setup();
    core.startDiscovery();
    await core.connect("headphones");
    expect(core.getSnapshot()).toMatchObject({ link: "error", error: { code: "not-elm327" } });
  });

  // 2026-10-13: two phones with the app in one car took the MX+ from each other; the one left without it read
  // "not-elm327: probe failed at reset".
  test("an adapter used before that answers nothing at all: adapter-silent (another phone may hold it)", async () => {
    const { core, emulators } = setup();
    core.startDiscovery();
    void core.connect("emu-1");
    await until(() => core.getSnapshot().link === "polling" || core.getSnapshot().link === "standby");
    await core.disconnect();
    emulators.get("emu-1")!.freeze(false);
    await core.connect("emu-1");
    expect(core.getSnapshot()).toMatchObject({ link: "error", error: { code: "adapter-silent" } });
  });

  test("standby while ignition is off, polls once the car starts", async () => {
    const { core, emulators } = setup();
    core.startDiscovery();
    void core.connect("emu-1");
    await until(() => emulators.has("emu-1"));
    emulators.get("emu-1")!.setVehicle({ ignition: false, rpm: 0 });
    await until(() => core.getSnapshot().link === "standby");
    emulators.get("emu-1")!.setVehicle({ ignition: true, rpm: 800 });
    await until(() => core.getSnapshot().link === "polling");
    await core.disconnect();
  });

  // The ECU answers the standby check with its last breath (the car switched off just then): the init finds no car.
  test("an init that finds no car after the standby check: back to the checks, polling once the car answers", async () => {
    const { core, emulators, states } = setup();
    core.startDiscovery();
    void core.connect("emu-1");
    await until(() => emulators.has("emu-1"));
    const emu = emulators.get("emu-1")!;
    emu.setVehicle({ ignition: false, rpm: 0 });
    await until(() => core.getSnapshot().link === "standby");
    let tricked = 0;
    const off = core.onExchange((e) => {
      // The standby check is answered; the car is off again before the init asks.
      if (e.command === "0100" && e.status === "ok" && core.getSnapshot().link === "standby" && tricked < 2) {
        tricked++;
        emu.setVehicle({ ignition: false, rpm: 0 });
      }
    });
    emu.setVehicle({ ignition: true, rpm: 800 });
    await until(() => tricked === 1 && states.filter((s) => s === "initializing").length === 1 && core.getSnapshot().link === "standby");
    emu.setVehicle({ ignition: true, rpm: 800 });
    await until(() => tricked === 2 && states.filter((s) => s === "initializing").length === 2 && core.getSnapshot().link === "standby");
    off();
    emu.setVehicle({ ignition: true, rpm: 800 });
    await until(() => core.getSnapshot().link === "polling");
    // Two inits that found no car, each back to standby; the third polls (via the usual "standby" until the RPM confirms).
    const seq = states.slice(states.indexOf("standby"));
    expect(seq.slice(0, 6)).toEqual(["standby", "initializing", "standby", "initializing", "standby", "initializing"]);
    expect(seq.at(-1)).toBe("polling");
    await core.disconnect();
  });

  test("link loss → reconnecting → polling again", async () => {
    const { core, emulators, states } = setup();
    core.startDiscovery();
    void core.connect("emu-1");
    await until(() => core.getSnapshot().link === "polling");
    emulators.get("emu-1")!.dropLink();
    await until(() => states.includes("reconnecting") && core.getSnapshot().link === "polling");
    await core.disconnect();
  });

  // A BLE adapter flapping while the car wakes up: the link drops again while the reconnect's session is probing.
  test("a second link loss during the reconnect: one session on the adapter afterwards, not two", async () => {
    const { core, emulators, states, events } = setup();
    core.startDiscovery();
    void core.connect("emu-1");
    await until(() => core.getSnapshot().link === "polling");
    const emu = emulators.get("emu-1")!;
    emu.dropLink();
    await until(() => states.includes("reconnecting") && core.getSnapshot().link === "probing");
    emu.dropLink("again");
    await until(() => core.getSnapshot().link === "polling" && events.filter((e) => e.type === "link-restored").length >= 2);
    expect(events.filter((e) => e.type === "link-lost").map((e) => e.detail)).toEqual(["emulated link loss", "again"]);
    // One poller: the speed polls come at the configured rate, not twice as often.
    const polls: number[] = [];
    const off = core.onExchange((e) => {
      if (e.pollPid === 0x0d) polls.push(e.txUs);
    });
    await until(() => polls.length >= 12);
    off();
    const gaps = polls.slice(1).map((t, i) => t - polls[i]);
    const meanGapUs = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    expect(meanGapUs).toBeGreaterThanOrEqual((1e6 / OBD_SPEED_HZ) * 0.9);
    await core.disconnect();
  });

  // 2026-10-11: an OBDLink MX+ went silent at 39 km/h with its link up; the app reported ignition off and kept the
  // dead session for 2 min.
  test("the adapter freezes while driving: no ignition-off, the link reopens and polls again", async () => {
    const { core, emulators, events } = setup();
    const engine: string[] = [];
    core.onEngineState((s) => engine.push(s));
    core.startDiscovery();
    void core.connect("emu-1");
    await until(() => emulators.has("emu-1"));
    const emu = emulators.get("emu-1")!;
    emu.setVehicle({ speedKph: 39 });
    await until(() => core.getSnapshot().link === "polling" && (core.getSnapshot().lastSpeed?.raw ?? 0) === 39);
    try {
      emu.freeze();
      await until(() => events.some((e) => e.type === "reopen"));
      await until(() => core.getSnapshot().link === "polling" && events.some((e) => e.type === "link-restored"));
      expect(events.find((e) => e.type === "link-lost")?.detail).toBe("adapter silent");
      expect(engine).not.toContain("ignition-off");
    } finally {
      await core.disconnect();
    }
  });

  test("frozen for good while driving: the reconnect keeps trying, never an error", async () => {
    const { core, clock, emulators, events } = setup();
    core.startDiscovery();
    void core.connect("emu-1");
    await until(() => emulators.has("emu-1"));
    const emu = emulators.get("emu-1")!;
    emu.setVehicle({ speedKph: 39 });
    await until(() => core.getSnapshot().link === "polling" && (core.getSnapshot().lastSpeed?.raw ?? 0) === 39);
    try {
      emu.freeze(false);
      await until(() => events.some((e) => e.type === "reopen"));
      const t0 = clock.nowUs();
      await until(() => clock.nowUs() - t0 > 90_000_000);
      expect(["reconnecting", "probing"]).toContain(core.getSnapshot().link);
      expect(events.some((e) => e.type === "error")).toBe(false);
      expect(events.filter((e) => e.type === "probe-failed").length).toBeGreaterThan(1);
    } finally {
      await core.disconnect();
    }
  });

  test("another car on the adapter (K-line after CAN): the cached protocol's bus errors start a search", async () => {
    const { core, store, events, emulators } = setup(KLINE_PROFILE, storeWithCx5());
    core.startDiscovery();
    const searching: boolean[] = [];
    core.subscribe(() => searching.at(-1) !== core.getSnapshot().protocolSearch && searching.push(core.getSnapshot().protocolSearch));
    void core.connect("emu-1");
    await until(() => core.getSnapshot().link === "polling" && core.getSnapshot().lastSpeed !== null);
    expect(events.find((e) => e.type === "protocol-search")?.detail).toBe("protocol 6 failed; 5 answered");
    expect(searching).toEqual([false, true, false]);
    // One search: the init uses what it found instead of trying the CX-5's protocol and searching again.
    expect(emulators.get("emu-1")!.log.filter((c) => c === "ATSP0")).toHaveLength(1);
    expect(core.getSnapshot().vehicle).toMatchObject({ protocol: "5", vin: "VF1LSRAEH12345678", vinSource: "read" });
    expect(store.getJson<RememberedAdapter[]>("vehicleLink.adapters")?.[0].protocolNumber).toBe(5);
    // Both cars stay known, the last one first.
    expect(store.getJson<KnownCar[]>("vehicleLink.cars")?.map((c) => [c.vin, c.protocolNumber])).toEqual([
      ["VF1LSRAEH12345678", 5],
      [CX5_VIN, 6],
    ]);
    await core.disconnect();
  });

  test("a K-line car on a new adapter: the init keeps the protocol the search found, without searching again", async () => {
    // A tester's car (2026-10-10): each init searched again (ATSP0), which dropped the session the search had just
    // opened; the ECU ignores a new init while that one is open, so init failed, standby found the car, init failed…
    // for 2 min 15 s before the first poll.
    const { core, clock, emulators } = setup(KLINE_PROFILE);
    core.startDiscovery();
    void core.connect("emu-1");
    await until(() => core.getSnapshot().link === "polling" || clock.nowUs() > 300e6);
    expect(core.getSnapshot().link).toBe("polling");
    expect(clock.nowUs()).toBeLessThan(30e6);
    expect(core.getSnapshot().vehicle?.protocol).toBe("5");
    expect(emulators.get("emu-1")!.log.filter((c) => c === "ATSP0")).toHaveLength(1);
    await core.disconnect();
  });

  test("a K-line car whose ECU still holds an old session at connect: standby finds it, the init keeps it", async () => {
    const { core, clock, emulators } = setup(KLINE_PROFILE);
    core.startDiscovery();
    void core.connect("emu-1");
    await until(() => emulators.has("emu-1"));
    // The adapter's previous session (before the app connected) left the ECU busy: the probe's search fails.
    emulators.get("emu-1")!.holdEcuSession(6000);
    await until(() => core.getSnapshot().link === "polling" || clock.nowUs() > 300e6);
    expect(core.getSnapshot().link).toBe("polling");
    expect(clock.nowUs()).toBeLessThan(40e6);
    await core.disconnect();
  });

  test("another car found from standby: every few bus errors, all protocols are searched", async () => {
    const { core, emulators } = setup(KLINE_PROFILE, storeWithCx5());
    core.startDiscovery();
    void core.connect("emu-1");
    await until(() => emulators.has("emu-1"));
    emulators.get("emu-1")!.setVehicle({ ignition: false, rpm: 0 });
    await until(() => core.getSnapshot().link === "standby");
    emulators.get("emu-1")!.setVehicle({ ignition: true, rpm: 800 });
    await until(() => core.getSnapshot().link === "polling");
    expect(core.getSnapshot().vehicle?.protocol).toBe("5");
    await core.disconnect();
  });

  test("a VIN read that misses at init: the last car on the protocol is assumed, a retry reads it", async () => {
    const { core, clock, store, events } = setup({ ...STN_PROFILE, vinMisses: 1 }, storeWithCx5());
    core.startDiscovery();
    void core.connect("emu-1");
    await until(() => core.getSnapshot().link === "polling");
    expect(core.getSnapshot().vehicle).toMatchObject({ vin: CX5_VIN, vinSource: "remembered" });
    expect(core.expectedVin()).toBe(CX5_VIN);
    await until(() => core.getSnapshot().engine === "engine-running");
    const runningAt = clock.nowUs();
    await until(() => core.getSnapshot().vehicle?.vinSource === "read");
    expect(core.getSnapshot().vehicle?.vin).toBe(CX5_VIN);
    expect(clock.nowUs() - runningAt).toBeLessThan(6e6);
    expect(events.filter((e) => e.type === "vin").map((e) => e.detail)).toEqual([
      `not read; the last car on protocol 6: ${CX5_VIN}`,
      "read on retry 1",
    ]);
    // The car list never loses the VIN to a missed read.
    expect(store.getJson<KnownCar[]>("vehicleLink.cars")).toEqual([{ vin: CX5_VIN, protocolNumber: 6, seenAt: 1_000 }]);
    await core.disconnect();
  });

  test("a car not seen on its protocol, its VIN never read: unknown, the CX-5 kept for later", async () => {
    const { core, clock, store, events } = setup({ ...KLINE_PROFILE, vinMisses: 99 }, storeWithCx5());
    core.startDiscovery();
    void core.connect("emu-1");
    await until(() => core.getSnapshot().link === "polling");
    expect(core.getSnapshot().vehicle?.vin).toBeNull();
    expect(core.expectedVin()).toBeNull();
    const t0 = clock.nowUs();
    await until(() => clock.nowUs() - t0 > 300e6);
    expect(events.filter((e) => e.type === "vin").map((e) => e.detail)).toEqual([
      "not read; a car not seen on this protocol",
      "not read after 6 retries",
    ]);
    expect(core.getSnapshot().vehicle?.vinSource).toBe("missing");
    await core.disconnect();
    expect(store.getJson<KnownCar[]>("vehicleLink.cars")?.map((c) => c.vin)).toEqual([null, CX5_VIN]);
    // Back in the CX-5 with a missed read: its VIN again.
    const back = setup({ ...STN_PROFILE, vinMisses: 99 }, store);
    back.core.startDiscovery();
    void back.core.connect("emu-1");
    await until(() => back.core.getSnapshot().link === "polling");
    expect(back.core.getSnapshot().vehicle).toMatchObject({ protocol: "6", vin: CX5_VIN, vinSource: "remembered" });
    await back.core.disconnect();
  });

  describe("auto-connect with two adapters remembered", () => {
    /** vLinker (BLE) verified last, then the MX+ (MFi); `reachable` says which can connect now. */
    function twoAdapters(reachable: { ble: boolean; mfi: boolean }) {
      const store = new MemoryStore();
      store.setJson("vehicleLink.adapters", [
        { id: "ble-1", transport: "ble", name: "vLinker FD", protocolNumber: 6, lastVerifiedAt: 900 },
        { id: "mfi-1", transport: "mfi", name: "OBDLink MX+", protocolNumber: 6, lastVerifiedAt: 500 },
      ] satisfies RememberedAdapter[]);
      const t = setup({}, store);
      for (const id of ["ble-1", "mfi-1"] as const) {
        const emu = new Elm327Emulator(t.clock);
        const connect = emu.connect.bind(emu);
        // Not reachable: the pending connect never completes (iOS waits for the adapter).
        jest.spyOn(emu, "connect").mockImplementation(() => (reachable[id === "ble-1" ? "ble" : "mfi"] ? connect() : new Promise(() => undefined)));
        t.emulators.set(id, emu);
      }
      t.discovery.mfi = reachable.mfi ? ["mfi-1"] : [];
      return t;
    }
    const notReachable = (events: LinkEvent[]) => events.filter((e) => e.type === "auto-connect").map((e) => e.detail);

    test("the most recent one wins when it answers", async () => {
      const { core, events } = twoAdapters({ ble: true, mfi: true });
      await core.autoConnect();
      await until(() => core.getSnapshot().link === "polling");
      expect(core.getSnapshot().activeDeviceId).toBe("ble-1");
      expect(notReachable(events)).toEqual([]);
      await core.disconnect();
    });

    test("one not reachable in its window: the next one", async () => {
      const { core, events } = twoAdapters({ ble: false, mfi: true });
      void core.autoConnect();
      await until(() => core.getSnapshot().link === "polling");
      expect(core.getSnapshot().activeDeviceId).toBe("mfi-1");
      expect(notReachable(events)).toEqual([`vLinker FD not reachable in ${AUTO_CONNECT_WINDOW_MS / 1000} s`]);
      // A foreground return meanwhile doesn't start a second round; connected now, the MX+ goes first next time.
      expect(await core.autoConnect()).toBe(true);
      await core.disconnect();
    });

    test("nobody there yet: rounds until one joins; an MFi adapter iOS reports goes next once all had a turn", async () => {
      const t = twoAdapters({ ble: false, mfi: false });
      void t.core.autoConnect();
      await until(() => notReachable(t.events).length === 2);
      expect(t.core.getSnapshot().link).toBe("connecting");
      // The car wakes the MX+ (it joins iOS) while the vLinker has its second window.
      const mfi = t.emulators.get("mfi-1")!;
      const connect = Object.getPrototypeOf(mfi).connect.bind(mfi);
      jest.spyOn(mfi, "connect").mockImplementation(() => connect());
      t.discovery.mfi = ["mfi-1"];
      await until(() => t.core.getSnapshot().link === "polling");
      expect(t.core.getSnapshot().activeDeviceId).toBe("mfi-1");
      expect(notReachable(t.events)).toHaveLength(2); // logged on the first round only
      await t.core.disconnect();
    });

    test("an MFi adapter iOS lists but can't open takes one turn per round, not every slot", async () => {
      const t = twoAdapters({ ble: false, mfi: false });
      void t.core.autoConnect();
      await until(() => notReachable(t.events).length === 2);
      // The MX+ is listed (present) but its session can't be opened: still unreachable.
      t.discovery.mfi = ["mfi-1"];
      const from = t.events.length;
      await until(() => t.events.slice(from).filter((e) => e.type === "connect").length >= 6);
      const tried = t.events.slice(from).filter((e) => e.type === "connect").map((e) => e.detail).slice(0, 6);
      // The MX+ goes first in each round (so it may follow itself across a round's end), the vLinker gets its turn.
      expect(tried.filter((name) => name === "vLinker FD").length).toBeGreaterThanOrEqual(2);
      expect(tried.some((name, i) => i >= 2 && name === "OBDLink MX+" && tried[i - 1] === name && tried[i - 2] === name)).toBe(false);
      await t.core.disconnect();
    });

    test("trying since: kept across the turns, cleared when ready or stopped", async () => {
      let now = 1_000;
      const t = twoAdapters({ ble: false, mfi: false });
      // The setup's nowMs is fixed: give this core a moving wall clock through the store-free path.
      (t.core as unknown as { deps: { nowMs: () => number } }).deps.nowMs = () => now;
      void t.core.autoConnect();
      await until(() => t.core.getSnapshot().link === "connecting");
      const since = t.core.getSnapshot().tryingSinceMs;
      expect(since).toBe(1_000);
      now = 60_000;
      await until(() => t.events.filter((e) => e.type === "auto-connect").length === 2 && t.core.getSnapshot().link === "connecting");
      expect(t.core.getSnapshot().tryingSinceMs).toBe(since);
      // The MX+ shows up: a step forward, a fresh window for reaching the car.
      jest.spyOn(t.emulators.get("mfi-1")!, "connect").mockImplementation(() => Elm327Emulator.prototype.connect.call(t.emulators.get("mfi-1")!));
      t.discovery.mfi = ["mfi-1"];
      await until(() => t.core.getSnapshot().link === "probing");
      expect(t.core.getSnapshot().tryingSinceMs).toBe(60_000);
      await t.core.disconnect();
      expect(t.core.getSnapshot().tryingSinceMs).toBeNull();

      const ready = twoAdapters({ ble: true, mfi: false });
      await ready.core.autoConnect();
      await until(() => ready.core.getSnapshot().link === "polling" && ready.core.getSnapshot().vehicle?.vin != null);
      expect(ready.core.getSnapshot().tryingSinceMs).toBeNull();
      await ready.core.disconnect();
    });

    test("disconnect stops the rounds", async () => {
      const { core, events } = twoAdapters({ ble: false, mfi: false });
      void core.autoConnect();
      await until(() => core.getSnapshot().link === "connecting");
      await core.disconnect();
      const after = events.length;
      for (let i = 0; i < 2000; i++) await new Promise<void>((r) => yieldMacrotask(r));
      expect(events.slice(after).filter((e) => e.type === "connect")).toEqual([]);
      expect(core.getSnapshot()).toMatchObject({ link: "idle", activeDeviceId: null });
    });
  });

  test("raw send and exclusive work while polling", async () => {
    const { core } = setup();
    core.startDiscovery();
    void core.connect("emu-1");
    await until(() => core.getSnapshot().link === "polling");
    const r = await core.send("ATRV");
    expect(r.lines[0]).toMatch(/V$/);
    const both = await core.exclusive(async (send) => [await send("ATI"), await send("ATDPN")]);
    expect(both.map((x) => x.lines[0])).toEqual(["ELM327 v1.5", "6"]);
    await core.disconnect();
  });
  describe("CAN monitor (§16)", () => {
    const BROADCAST = [
      { id: 0x215, periodMs: 20, data: [0x27, 0x10, 0x27, 0x10, 0x27, 0x10, 0x27, 0x10] },
      { id: 0x228, periodMs: 100, data: [0x10] },
      { id: 0x4f0, periodMs: 1000, data: [1, 2, 3] },
    ];

    test("monitors the ids asked for, past the speed ECU's receive filter, then polls again", async () => {
      const { core, emulators, events } = setup({ ...STN_PROFILE, broadcast: BROADCAST });
      core.startDiscovery();
      void core.connect("emu-1");
      await until(() => core.getSnapshot().link === "polling" && core.getSnapshot().lastSpeed !== null);
      const emu = emulators.get("emu-1")!;
      expect(emu.log).toContain("ATCRA7E8");

      const survey = await core.monitorCan({ ids: [0x215, 0x228], durationMs: 2000 });
      expect(survey.ids.map((i) => i.id)).toEqual([0x215, 0x228]);
      expect(survey.ids[0].hz).toBeGreaterThan(45);
      expect(survey.ids[0].hz).toBeLessThan(55);
      expect(survey.ids[1].hz).toBeGreaterThan(8);
      expect(survey.ids[1].hz).toBeLessThan(12);
      expect(survey.ids[0].last).toEqual(BROADCAST[0].data);
      expect(events.some((e) => e.type === "can-monitor" && e.detail?.startsWith("2 ids"))).toBe(true);
      expect(events.some((e) => e.type === "unsolicited")).toBe(false);

      // The session is back as init left it: headers off, the speed ECU pinned again.
      const log = emu.log.slice(emu.log.indexOf("STM"));
      expect(log.slice(0, 5)).toEqual(["STM", "", "ATAR", "ATCRA7E8", "ATH0"]);
      const polls = core.getSnapshot().lastSpeed!.rxUs;
      await until(() => core.getSnapshot().lastSpeed!.rxUs > polls);

      // Every id: a pass-all filter.
      const all = await core.monitorCan({ ids: null, durationMs: 3000 });
      expect(all.ids.map((i) => i.id)).toEqual([0x215, 0x228, 0x4f0]);
      await core.disconnect();
    });

    test("needs an STN adapter", async () => {
      const { core } = setup({ broadcast: BROADCAST });
      core.startDiscovery();
      void core.connect("emu-1");
      await until(() => core.getSnapshot().link === "polling");
      await expect(core.monitorCan({ ids: null, durationMs: 1000 })).rejects.toThrow("needs an STN adapter");
      await core.disconnect();
    });
  });
  describe("CAN shadow (§16.2)", () => {
    const BROADCAST = [
      { id: 0x215, periodMs: 10, data: [0x27, 0x10, 0x27, 0x10, 0x27, 0x10, 0x27, 0x10] },
      { id: 0x228, periodMs: 20, data: [0x10] },
      { id: 0x4f0, periodMs: 100, data: [1, 2, 3] },
    ];

    // As on the MX+: with the pass filters set, broadcast frames reach request answers.
    async function shadowOn(profile: Partial<EmulatorProfile>) {
      const s = setup({ ...STN_PROFILE, broadcast: BROADCAST, passFiltersLeak: true, ...profile });
      s.core.startDiscovery();
      void s.core.connect("emu-1");
      await until(() => s.core.getSnapshot().engine === "engine-running");
      const frames: CanFrame[] = [];
      const windows: CanWindow[] = [];
      const speeds: { tUs: number; ok: boolean }[] = [];
      s.core.onCanFrames((f) => frames.push(...f));
      s.core.onCanWindow((w) => windows.push(w));
      s.core.onExchange((e) => {
        if (e.pollPid === 0x0d) speeds.push({ tUs: e.txUs, ok: e.status === "ok" });
      });
      const emu = s.emulators.get("emu-1")!;
      const logFrom = emu.log.length;
      s.core.setCanShadow([0x215, 0x228]);
      return { ...s, frames, windows, speeds, emu, logFrom };
    }

    test("listens between polls at the shadow's speed rate; frames and windows go out; off restores the adapter", async () => {
      const { core, frames, windows, speeds, emu, logFrom, events } = await shadowOn({});
      try {
        await until(() => windows.length >= 10 && speeds.length >= 10);
        expect(core.getSnapshot().canShadow?.state).not.toBe("failed");
        expect(events.some((e) => e.type === "can-shadow" && e.detail === "set up: 2 ids")).toBe(true);
        expect(new Set(frames.map((f) => f.id))).toEqual(new Set([0x215, 0x228]));
        // Every poll reads the ECU's answer, never a broadcast frame: the receive filter is pinned for it.
        expect(speeds.every((s) => s.ok)).toBe(true);
        // Polls at the shadow's rate (on average: the emulator's monitor loop moves the virtual clock in between).
        const polled = speeds.slice(2);
        const meanGapUs = (polled.at(-1)!.tUs - polled[0].tUs) / (polled.length - 1);
        expect(meanGapUs).toBeGreaterThanOrEqual((1e6 / OBD_SPEED_HZ) * 0.95);
        // The breaks don't come on top of the gap: the poll is asked for early by what they take.
        expect(meanGapUs).toBeLessThanOrEqual((1e6 / OBD_SPEED_HZ) * 1.05);
        const log = emu.log.slice(logFrom);
        expect(log.slice(0, 6)).toEqual(["ATH1", "ATAR", "STCMM0", "STFPA215,7FF", "STFPA228,7FF", "ATCS"]);
        // The filter self-test first (its last command is STM 20), then a break: stop, pin, poll; open again before
        // the next window.
        const test = events.find((e) => e.type === "can-shadow" && e.detail?.startsWith("filter test: "));
        expect(test?.detail).toMatch(/^filter test: setup [1-9]\d*, pinned 0, ATCRAXXX "OK" [1-9]\d*, ATCRA "OK" [1-9]\d*, setup again [1-9]\d*, STM n accepted \(20 frames in \d+ ms\) → opens by ATCRA from now on$/);
        const after = log.slice(log.indexOf("STM 20") + 1);
        const pins = after.filter((c) => c.startsWith("ATCRA"));
        expect(pins.length).toBeGreaterThan(10);
        expect(pins.slice(0, 4)).toEqual(["ATCRA7E8", "ATCRA", "ATCRA7E8", "ATCRA"]);
        expect(windows.slice(1).every((w) => w.reopen === "bare" && w.stopMs !== null && w.stopMs >= 0 && !w.stopRetried && w.bytes > 0)).toBe(true);
        expect(windows.every((w) => !w.endedItself && w.endUs > w.startUs)).toBe(true);

        core.setCanShadow(null);
        await until(() => emu.log.slice(-3).join(" ") === "ATAR ATCRA7E8 ATH0");
        expect(core.getSnapshot().canShadow).toBeNull();
        const stm = emu.log.lastIndexOf("STM");
        const n = speeds.length;
        await until(() => speeds.length >= n + 10);
        expect(emu.log.lastIndexOf("STM")).toBe(stm);
      } finally {
        await core.disconnect();
      }
    });

    // 2026-10-11: an OBDLink MX+ (STN2255 v5.10.3) froze twice inside a monitor window, once at 39 km/h.
    test("the adapter freezes in the monitor while driving: the link reopens at once, the shadow stays off on that firmware", async () => {
      const { core, windows, emu, events, store } = await shadowOn({});
      try {
        emu.setVehicle({ speedKph: 39 });
        await until(() => windows.length >= 3 && core.getSnapshot().lastSpeed?.raw === 39);
        const chip = core.getSnapshot().adapter!.chip!;
        emu.freezeInMonitor();
        await until(() => events.some((e) => e.type === "reopen"));
        expect(events.find((e) => e.type === "can-shadow" && e.detail?.startsWith("off: no answer at all"))).toBeDefined();
        // At the first silent stop, not after three.
        expect(events.filter((e) => e.type === "reinit").map((e) => e.detail)).toEqual(["adapter silent in the CAN monitor"]);
        await until(() => core.getSnapshot().link === "polling" && events.some((e) => e.type === "link-restored"));
        await until(() => events.some((e) => e.detail === `off: the adapter froze in the monitor on this firmware (${chip})`));
        expect(store.getJson<Record<string, string>>("vehicleLink.canShadowFrozeOn")).toEqual({ "emu-1": chip });
        // Other firmware (updated): it listens again.
        store.setJson("vehicleLink.canShadowFrozeOn", { "emu-1": "STN2255 v5.10.2" });
        const n = windows.length;
        core.setCanShadow(null);
        core.setCanShadow([0x215, 0x228]);
        await until(() => windows.length >= n + 3);
      } finally {
        await core.disconnect();
      }
    });

    test("standing, a freeze counts once the adapter is still there and silent 20 s later", async () => {
      const { core, windows, emu, events, store, clock } = await shadowOn({});
      try {
        await until(() => windows.length >= 3);
        emu.freezeInMonitor(false);
        await until(() => events.some((e) => e.type === "reopen"));
        const silentUs = events.find((e) => e.detail?.startsWith("off: no answer at all"))!.tUs;
        expect(store.getJson("vehicleLink.canShadowFrozeOn")).toBeNull();
        // The forensics first, each answer in the events: ATI after a pause, ATWS, ATZ.
        expect(events.filter((e) => e.type === "frozen").map((e) => e.detail)).toEqual(["ATI: no answer 1 s after the silent stop", "ATZ: no answer either"]);
        await until(() => store.getJson("vehicleLink.canShadowFrozeOn") !== null);
        expect(clock.nowUs() - silentUs).toBeGreaterThanOrEqual(20_000_000);
      } finally {
        await core.disconnect();
      }
    });

    // 2026-10-11, 5.13.1: the car switched off with the monitor running; iOS reported the MX+ gone 3 s later. That
    // first build took it for a freeze and kept the shadow off on the new firmware.
    test("the car switched off while listening (the adapter powers down): not a freeze", async () => {
      const { core, windows, emu, events, store, clock } = await shadowOn({});
      try {
        await until(() => windows.length >= 3);
        emu.powerOffInMonitor();
        await until(() => events.some((e) => e.type === "reopen"));
        const t0 = clock.nowUs();
        await until(() => clock.nowUs() - t0 > 60_000_000);
        expect(store.getJson("vehicleLink.canShadowFrozeOn")).toBeNull();
        emu.powerOn();
        await until(() => core.getSnapshot().link === "polling" && windows.length > 3 && core.getSnapshot().canShadow?.state !== "failed");
        const n = windows.length;
        await until(() => windows.length >= n + 3);
      } finally {
        await core.disconnect();
      }
    });

    // 2026-10-11: a bare ATCRA didn't open the filter on the vLinker (STN1151 v4.3.2) nor the MX+ on 5.13.1; it restores
    // the OBD answers' filter and clears the pass filters (`default`), which on 2026-10-12 had the self-test, trying
    // ATCRAXXX after it, hear every id and choose a full setup for the vLinker.
    test.each(["refused", "ignored", "default"] as const)("a bare ATCRA %s on the adapter: ATCRAXXX opens the filter, frames go on", async (bareAtcra) => {
      const { core, windows, events, emu } = await shadowOn({ bareAtcra });
      try {
        await until(() => events.some((e) => e.type === "can-shadow" && /opens by ATCRAXXX from now on/.test(e.detail ?? "")));
        const n = windows.length;
        await until(() => windows.length >= n + 5);
        // The first window after the self-test finds the filter open; every break after it opens by ATCRAXXX.
        expect(windows.slice(n).every((w) => w.frames > 0 && (w.reopen === "wildcard" || w.reopen === "open"))).toBe(true);
        expect(windows.slice(n + 1).every((w) => w.reopen === "wildcard")).toBe(true);
        // The pass filters stay: only the ids asked for.
        expect(windows.slice(n).every((w) => w.other === 0)).toBe(true);
        expect(core.getSnapshot().canShadow?.state).not.toBe("failed");
        // The self-test measured each way; no full setup since its own.
        const test = events.find((e) => e.detail?.startsWith("filter test: "))!.detail!;
        expect(test).toMatch(bareAtcra === "refused" ? /ATCRAXXX "OK" [1-9]\d*, ATCRA "\?" 0,/ : /ATCRAXXX "OK" [1-9]\d*, ATCRA "OK" 0,/);
        expect(emu.log.filter((c) => c === "ATAR").length).toBe(2);
      } finally {
        await core.disconnect();
      }
    });

    // 2026-10-12: the vLinker answered a stop character with nothing now and then; waiting 1 s left a turn unheard.
    test("a stop character without an answer: once the adapter's stops are known, the second one goes soon", async () => {
      const { core, windows, emu } = await shadowOn({});
      try {
        await until(() => windows.length >= 5);
        emu.ignoreNextStop();
        await until(() => windows.some((w) => w.stopRetried));
        // Before 30 stops are measured, the full second.
        expect(windows.find((w) => w.stopRetried)!.stopMs).toBeGreaterThanOrEqual(1000);
        const n = windows.length;
        await until(() => windows.length >= n + 30);
        emu.ignoreNextStop();
        await until(() => windows.slice(n).some((w) => w.stopRetried));
        const late = windows.slice(n).find((w) => w.stopRetried)!;
        expect(late.stopMs).toBeLessThan(400);
        expect(core.getSnapshot().canShadow?.state).not.toBe("failed");
      } finally {
        await core.disconnect();
      }
    });

    // §16.3: the wheels carry the speed while the car moves; OBD only standing, so the monitor listens without breaks.
    test("CAN primary: no polls while CAN speed shows the car moving, polls again standing or when it stops coming", async () => {
      const { core, emu, clock, speeds } = await shadowOn({});
      const toNav: SpeedSample[] = [];
      core.onSpeed((s) => toNav.push(s));
      const can = (kph: number) => {
        const tUs = clock.nowUs();
        core.pushCanSpeed({ txUs: tUs, rxUs: tUs, tUs, speedMps: kph / 3.6, raw: kph, source: "can" });
      };
      const pushFor = async (ms: number, kph: number) => {
        for (let t = 0; t < ms; t += 100) {
          can(kph);
          await clock.sleep(100);
        }
      };
      const polls = () => emu.log.filter((c) => c.startsWith("010D") || c.startsWith("010C") || c === "ATRV").length;
      try {
        core.setCanPrimary(true);
        emu.setVehicle({ speedKph: 40 });
        await until(() => speeds.length >= 3);
        await pushFor(500, 40);
        const before = polls();
        const n = toNav.length;
        await pushFor(10_000, 40);
        // Moving on CAN: not a poll in 10 s, the navigator fed from CAN only, the engine still running.
        expect(polls()).toBe(before);
        expect(toNav.slice(n).every((s) => s.source === "can")).toBe(true);
        expect(core.getSnapshot().engine).toBe("engine-running");
        // Standing: the polls are back (the engine state needs them); CAN still feeds the navigator.
        emu.setVehicle({ speedKph: 0 });
        await pushFor(3000, 0);
        expect(polls()).toBeGreaterThan(before + 3);
        // CAN goes quiet while moving: OBD's speed is the navigator's again.
        emu.setVehicle({ speedKph: 40 });
        await pushFor(500, 40);
        const m = toNav.length;
        await until(() => toNav.slice(m).some((s) => s.source !== "can"));
        // Off: nothing from CAN is taken.
        core.setCanPrimary(false);
        const k = toNav.length;
        can(40);
        expect(toNav.slice(k).some((s) => s.source === "can")).toBe(false);
      } finally {
        await core.disconnect();
      }
    });

    // 2026-10-13: an MX+ silent from the init on, with CAN off: off must mean not a CAN command, primary or not.
    test("CAN off (after CAN primary was on): not one CAN command, the init and the polls as without it", async () => {
      const s = setup({ ...STN_PROFILE, broadcast: BROADCAST, passFiltersLeak: true });
      s.core.setCanShadow([0x215, 0x228]);
      s.core.setCanPrimary(true);
      s.core.setCanShadow(null);
      s.core.setCanPrimary(false);
      s.core.startDiscovery();
      void s.core.connect("emu-1");
      try {
        await until(() => s.core.getSnapshot().link === "polling" && s.core.getSnapshot().engine === "engine-running");
        const emu = s.emulators.get("emu-1")!;
        const n = emu.log.length;
        const t0 = s.clock.nowUs();
        await until(() => s.clock.nowUs() - t0 > 5_000_000);
        const can = emu.log.filter((c) => /^(STM|STF|STCMM|ATCRAX|ATCS$)/.test(c));
        expect(can).toEqual([]);
        expect(emu.log.slice(n).filter((c) => c.startsWith("010D")).length).toBeGreaterThan(5);
        expect(s.core.getSnapshot().canShadow).toBeNull();
        expect(s.events.some((e) => e.type === "probe-failed")).toBe(false);
      } finally {
        await s.core.disconnect();
      }
    });

    // CAN primary keeps the monitor running while the car moves: a link lost then leaves the adapter monitoring, and
    // the next connection's probe meets it mid-monitor.
    test("CAN primary: the link lost with the monitor running, the reconnect's probe stops it and polls again", async () => {
      const { core, emu, clock, events, windows } = await shadowOn({});
      const can = (kph: number) => {
        const tUs = clock.nowUs();
        core.pushCanSpeed({ txUs: tUs, rxUs: tUs, tUs, speedMps: kph / 3.6, raw: kph, source: "can" });
      };
      try {
        core.setCanPrimary(true);
        emu.setVehicle({ speedKph: 40 });
        await until(() => windows.length >= 3);
        for (let i = 0; i < 30; i++) {
          can(40);
          await clock.sleep(100);
        }
        expect(core.getSnapshot().canShadow?.state).toBe("listening");
        emu.dropLink();
        await until(() => events.some((e) => e.type === "link-restored"));
        expect(events.some((e) => e.type === "probe-failed")).toBe(false);
        // CAN speed stopped coming with the link: OBD's polls and the monitor's windows are back.
        const n = windows.length;
        await until(() => core.getSnapshot().link === "polling" && windows.length >= n + 3);
        expect(core.getSnapshot().error).toBeNull();
      } finally {
        await core.disconnect();
      }
    });

    test("STM n refused: noted, nothing else changes", async () => {
      const { core, windows, events } = await shadowOn({ stmCountUnsupported: true });
      try {
        await until(() => events.some((e) => e.detail?.startsWith("filter test: ")));
        expect(events.find((e) => e.detail?.startsWith("filter test: "))!.detail).toMatch(/STM n "\?" → opens by ATCRA from now on/);
        await until(() => windows.length >= 3);
        expect(core.getSnapshot().canShadow?.state).not.toBe("failed");
      } finally {
        await core.disconnect();
      }
    });

    test("neither ATCRA opens it: a full setup before every window", async () => {
      const { core, windows, events } = await shadowOn({ bareAtcra: "ignored", wildcardAtcraIgnored: true });
      try {
        await until(() => events.some((e) => e.type === "can-shadow" && /opens by a full setup from now on/.test(e.detail ?? "")));
        const n = windows.length;
        await until(() => windows.length >= n + 5);
        expect(windows.slice(n).every((w) => w.frames > 0)).toBe(true);
        expect(core.getSnapshot().canShadow?.state).not.toBe("failed");
      } finally {
        await core.disconnect();
      }
    });

    test("ignition off: no windows until the ECU is back", async () => {
      const { core, windows, emu } = await shadowOn({});
      try {
        await until(() => windows.length >= 3);
        emu.setVehicle({ ignition: false });
        await until(() => core.getSnapshot().engine === "ignition-off");
        const n = windows.length;
        const stm = emu.log.lastIndexOf("STM");
        const polls = emu.commandCount;
        await until(() => emu.commandCount >= polls + 5);
        expect(emu.log.lastIndexOf("STM")).toBe(stm);
        expect(windows.length).toBe(n);
        emu.setVehicle({ ignition: true });
        await until(() => windows.length > n + 2);
      } finally {
        await core.disconnect();
      }
    });

    test("another component's filter change: set up again before the next window", async () => {
      const { core, frames, emu } = await shadowOn({});
      try {
        await until(() => frames.length > 20);
        await core.exclusive(async (send) => {
          await send("ATCRA7E8");
        });
        const from = emu.log.length;
        const n = frames.length;
        await until(() => frames.length > n + 20);
        expect(emu.log.slice(from)).toContain("STFPA215,7FF");
      } finally {
        await core.disconnect();
      }
    });

    test("needs an STN adapter", async () => {
      const { core, events } = setup({ broadcast: BROADCAST });
      core.startDiscovery();
      void core.connect("emu-1");
      try {
        await until(() => core.getSnapshot().link === "polling");
        core.setCanShadow([0x215]);
        expect(events.some((e) => e.type === "can-shadow" && e.detail === "off: needs an STN adapter")).toBe(true);
        expect(core.getSnapshot().canShadow).toBeNull();
      } finally {
        await core.disconnect();
      }
    });
  });
});
