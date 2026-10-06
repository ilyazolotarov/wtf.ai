// JS side of modules/vehicle-link: NativeTransport and NativeDiscovery against a mocked native module.

import { GATT_PROFILES } from "@/obd/catalog";
import { EMULATOR_DEVICES, NativeDiscovery } from "../discovery";
import { NativeTransport } from "../native-transport";

type Listener = (e: any) => void;

jest.mock("../../../../modules/vehicle-link/src/VehicleLinkModule", () => {
  const listeners = new Map<string, Set<(e: any) => void>>();
  const native = {
    nowUs: jest.fn(() => 1_000),
    initialize: jest.fn(async () => "poweredOn"),
    startScan: jest.fn(),
    stopScan: jest.fn(),
    getMfiAccessories: jest.fn(() => [] as any[]),
    showMfiPicker: jest.fn(async () => undefined),
    connect: jest.fn(async (_options: any): Promise<any> => ({
      gatt: { profileId: "fff0", service: "FFF0", notify: "FFF1", write: "FFF2" },
      gattDump: [],
      deviceInfo: { name: "OBDII" },
    })),
    disconnect: jest.fn(async () => undefined),
    transact: jest.fn(async (_command: string, _timeoutMs: number): Promise<any> => ({ raw: "OK\r\r>", status: "ok", txUs: 1, rxUs: 2 })),
    addListener: jest.fn((name: string, fn: (e: any) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(fn);
      return { remove: () => listeners.get(name)!.delete(fn) };
    }),
  };
  return {
    __esModule: true,
    default: native,
    __listeners: listeners,
    __emit: (name: string, payload: unknown) => listeners.get(name)?.forEach((fn) => fn(payload)),
  };
});


const mocked = jest.requireMock("../../../../modules/vehicle-link/src/VehicleLinkModule");
const mockNative = mocked.default;
const mockListeners: Map<string, Set<Listener>> = mocked.__listeners;
const mockEmit: (name: string, payload: unknown) => void = mocked.__emit;

beforeEach(() => {
  mockListeners.clear();
  jest.clearAllMocks();
});

describe("NativeTransport", () => {
  test("first connect sends the catalog with a timeout; reconnects stay pending", async () => {
    const t = new NativeTransport("PERIPH-1", "ble");
    const info = await t.connect();
    expect(info.gatt?.profileId).toBe("fff0");
    const first = mockNative.connect.mock.calls[0][0];
    expect(first).toMatchObject({ id: "PERIPH-1", transport: "ble", timeoutMs: 15000, preferred: undefined });
    expect(first.profiles.map((p: { id: string }) => p.id)).toEqual(GATT_PROFILES.map((p) => p.id));

    await t.connect();
    expect(mockNative.connect.mock.calls[1][0].timeoutMs).toBe(0);
  });

  test("remembered UART is passed as the preferred triple", async () => {
    const t = new NativeTransport("PERIPH-1", "ble", {
      id: "PERIPH-1",
      transport: "ble",
      name: "OBDII",
      gatt: { profileId: "heuristic", service: "ABCD", notify: "AB01", write: "AB02" },
      lastVerifiedAt: 0,
    });
    await t.connect();
    expect(mockNative.connect.mock.calls[0][0].preferred).toEqual(["ABCD", "AB01", "AB02"]);
  });

  test("exchange passes through the native result", async () => {
    const t = new NativeTransport("PERIPH-1", "ble");
    await t.connect();
    await expect(t.exchange("ATI", 1000)).resolves.toMatchObject({ raw: "OK\r\r>", status: "ok" });
    expect(mockNative.transact).toHaveBeenCalledWith("ATI", 1000);
  });

  test("link-lost rejection fires onLinkLost once, before the error propagates", async () => {
    const t = new NativeTransport("PERIPH-1", "ble");
    await t.connect();
    const order: string[] = [];
    t.onLinkLost((reason) => order.push(`lost:${reason}`));
    mockNative.transact.mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "link-lost" }));
    await t.exchange("010D1", 1000).catch(() => order.push("rejected"));
    mockEmit("onLinkState", { state: "disconnected", reason: "again" });
    expect(order).toEqual(["lost:link-lost", "rejected"]);
  });

  test("other native errors don't count as link loss", async () => {
    const t = new NativeTransport("PERIPH-1", "ble");
    await t.connect();
    const lost = jest.fn();
    t.onLinkLost(lost);
    mockNative.transact.mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "busy" }));
    await expect(t.exchange("ATI", 1000)).rejects.toThrow("busy");
    expect(lost).not.toHaveBeenCalled();
  });

  test("native disconnect event and unsolicited text reach the listeners; disconnect unsubscribes", async () => {
    const t = new NativeTransport("mfi:SN:com.obdlink", "mfi");
    await t.connect();
    const lost = jest.fn();
    const text = jest.fn();
    t.onLinkLost(lost);
    t.onUnsolicited(text);
    mockEmit("onUnsolicited", { text: "LV RESET", rxUs: 5 });
    mockEmit("onLinkState", { state: "disconnected", reason: "accessory disconnected" });
    expect(text).toHaveBeenCalledWith("LV RESET", 5);
    expect(lost).toHaveBeenCalledWith("accessory disconnected");

    await t.disconnect();
    expect(mockNative.disconnect).toHaveBeenCalled();
    expect([...mockListeners.values()].every((s) => s.size === 0)).toBe(true);
  });
});

describe("NativeDiscovery on Android", () => {
  test("Classic Bluetooth devices arrive as spp transport and keep their prefixed id", async () => {
    const updates: any[][] = [];
    const d = new NativeDiscovery(() => false);
    d.start((devices) => updates.push(devices));
    mockEmit("onScanBatch", {
      devices: [
        { id: "spp:AA:BB:CC:DD:EE:FF", name: "OBDII", serviceUuids: [], connectable: true, seenUs: 5, transport: "spp", bonded: true },
        { id: "11:22:33:44:55:66", name: "V-LINK", rssi: -55, serviceUuids: ["18F0"], connectable: true, seenUs: 6, transport: "ble" },
      ],
    });
    const batch = updates[updates.length - 1];
    expect(batch[0]).toMatchObject({ id: "spp:AA:BB:CC:DD:EE:FF", transport: "spp", name: "OBDII" });
    expect(batch[1]).toMatchObject({ id: "11:22:33:44:55:66", transport: "ble" });
    d.stop();
  });

  test("a spp device connects with the spp transport and the first-connect timeout", async () => {
    const t = new NativeTransport("spp:AA:BB:CC:DD:EE:FF", "spp");
    await t.connect();
    expect(mockNative.connect.mock.calls[0][0]).toMatchObject({ id: "spp:AA:BB:CC:DD:EE:FF", transport: "spp", timeoutMs: 15000 });
  });
});

describe("NativeDiscovery", () => {
  test("maps BLE scan batches and MFi accessories; includes emulators when enabled", async () => {
    mockNative.getMfiAccessories.mockReturnValueOnce([
      { id: "mfi:SN1:com.obdlink", name: "OBDLink MX+", protocol: "com.obdlink" },
    ]);
    const updates: any[][] = [];
    const d = new NativeDiscovery(() => true);
    d.start((devices) => updates.push(devices));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockNative.initialize).toHaveBeenCalledWith(null);
    expect(mockNative.startScan).toHaveBeenCalledWith(GATT_PROFILES.map((p) => p.service));

    mockEmit("onScanBatch", {
      devices: [{ id: "P1", name: "OBDII", rssi: -60, serviceUuids: ["FFF0"], connectable: true, seenUs: 7 }, { id: "P2", rssi: -90, serviceUuids: [], connectable: true, seenUs: 8 }],
    });
    expect(updates[0].map((x) => x.id)).toEqual(EMULATOR_DEVICES.map((x) => x.id));
    expect(updates[1]).toEqual([{ id: "mfi:SN1:com.obdlink", transport: "mfi", name: "OBDLink MX+", lastSeenUs: 1000 }]);
    expect(updates[2]).toEqual([
      { id: "P1", transport: "ble", name: "OBDII", rssi: -60, serviceUuids: ["FFF0"], lastSeenUs: 7 },
      { id: "P2", transport: "ble", name: null, rssi: -90, serviceUuids: [], lastSeenUs: 8 },
    ]);

    d.stop();
    expect(mockNative.stopScan).toHaveBeenCalled();
    expect([...mockListeners.values()].every((s) => s.size === 0)).toBe(true);
  });

  test("no emulators unless enabled; MFi changes update the list; pairing opens the picker", async () => {
    const updates: any[][] = [];
    const d = new NativeDiscovery(() => false);
    d.start((devices) => updates.push(devices));
    expect(updates).toEqual([[]]);
    mockEmit("onMfiChange", { accessories: [{ id: "mfi:SN2:com.vgatemall", name: "vLinker MS", protocol: "com.vgatemall" }] });
    expect(updates[1][0]).toMatchObject({ id: "mfi:SN2:com.vgatemall", transport: "mfi" });
    await d.pairMfi();
    expect(mockNative.showMfiPicker).toHaveBeenCalledWith(null);
    d.stop();
  });
});
