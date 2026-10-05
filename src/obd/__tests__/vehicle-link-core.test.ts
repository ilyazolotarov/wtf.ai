import { VirtualClock, yieldMacrotask } from "@/obd/clock";
import { Elm327Emulator, KLINE_PROFILE, STN_PROFILE, type EmulatorProfile } from "@/obd/emulator";
import {
  AUTO_CONNECT_WINDOW_MS,
  VehicleLinkCore,
  type DiscoveryBackend,
  type KeyValueStore,
  type KnownCar,
  type RememberedAdapter,
  type ScannedDevice,
} from "@/obd/vehicle-link-core";
import type { ExchangeEvent, LinkEvent, LinkState } from "@/obd/types";

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
  start(onUpdate: (d: ScannedDevice[]) => void) {
    onUpdate(this.devices);
  }
  stop() {}
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

  test("link loss → reconnecting → polling again", async () => {
    const { core, emulators, states } = setup();
    core.startDiscovery();
    void core.connect("emu-1");
    await until(() => core.getSnapshot().link === "polling");
    emulators.get("emu-1")!.dropLink();
    await until(() => states.includes("reconnecting") && core.getSnapshot().link === "polling");
    await core.disconnect();
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
});
