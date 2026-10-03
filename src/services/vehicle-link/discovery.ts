import type { EventSubscription } from "expo-modules-core";

import VehicleLinkModule, {
  type NativeMfiAccessory,
  type NativeScanResult,
} from "../../../modules/vehicle-link/src/VehicleLinkModule";
import { GATT_PROFILES } from "@/obd/catalog";
import type { DiscoveryBackend, ScannedDevice } from "@/obd/vehicle-link-core";

export const EMULATOR_DEVICES: ScannedDevice[] = [
  { id: "emulator:genuine", transport: "emulator", name: "Emulator · ELM327 v1.5", lastSeenUs: 0 },
  { id: "emulator:clone", transport: "emulator", name: "Emulator · clone v2.1", lastSeenUs: 0 },
  { id: "emulator:stn", transport: "emulator", name: "Emulator · OBDLink (STN)", lastSeenUs: 0 },
];

const SCAN_LIMIT_MS = 60_000;

/** BLE scan + paired MFi accessories (+ emulators in dev) (VEHICLE-LINK-SPEC §7). */
export class NativeDiscovery implements DiscoveryBackend {
  private subscriptions: EventSubscription[] = [];
  private stopTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly includeEmulators: () => boolean) {}

  start(onUpdate: (devices: ScannedDevice[]) => void): void {
    if (this.includeEmulators()) onUpdate(EMULATOR_DEVICES.map((d) => ({ ...d, lastSeenUs: VehicleLinkModule.nowUs() })));
    onUpdate(mfiDevices(VehicleLinkModule.getMfiAccessories()));
    this.subscriptions.push(
      VehicleLinkModule.addListener("onScanBatch", (e) => onUpdate(e.devices.map(bleDevice))),
      VehicleLinkModule.addListener("onMfiChange", (e) => onUpdate(mfiDevices(e.accessories))),
    );
    void VehicleLinkModule.initialize(null).then(() => VehicleLinkModule.startScan(GATT_PROFILES.map((p) => p.service)));
    this.stopTimer = setTimeout(() => VehicleLinkModule.stopScan(), SCAN_LIMIT_MS);
  }

  stop(): void {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    this.subscriptions.forEach((s) => s.remove());
    this.subscriptions = [];
    VehicleLinkModule.stopScan();
  }

  async pairMfi(): Promise<void> {
    await VehicleLinkModule.showMfiPicker(null);
  }
}

function bleDevice(d: NativeScanResult): ScannedDevice {
  return {
    id: d.id,
    transport: "ble",
    name: d.name ?? null,
    rssi: d.rssi,
    serviceUuids: d.serviceUuids,
    lastSeenUs: d.seenUs,
  };
}

function mfiDevices(list: NativeMfiAccessory[]): ScannedDevice[] {
  const now = VehicleLinkModule.nowUs();
  return list.map((a) => ({ id: a.id, transport: "mfi", name: a.name, lastSeenUs: now }));
}
