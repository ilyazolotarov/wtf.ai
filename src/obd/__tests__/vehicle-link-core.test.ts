import { VirtualClock, yieldMacrotask } from "@/obd/clock";
import { Elm327Emulator, type EmulatorProfile } from "@/obd/emulator";
import { VehicleLinkCore, type DiscoveryBackend, type KeyValueStore, type ScannedDevice } from "@/obd/vehicle-link-core";
import type { ExchangeEvent, LinkState } from "@/obd/types";

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
  start(onUpdate: (d: ScannedDevice[]) => void) {
    onUpdate(this.devices);
  }
  stop() {}
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
  return { clock, core, emulators, store, states };
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

    // A fresh app start auto-connects to the remembered adapter.
    const second = setup({}, store);
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
