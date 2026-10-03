import { NativeModule, registerWebModule } from "expo";

import type { VehicleLinkEvents } from "./VehicleLinkModule";

// Bluetooth adapters are not available on web; the app falls back to the emulator.
class VehicleLinkWebModule extends NativeModule<VehicleLinkEvents> {
  nowUs(): number {
    return performance.now() * 1000;
  }
  getBluetoothState() {
    return "unsupported" as const;
  }
  async initialize() {
    return "unsupported" as const;
  }
  startScan() {}
  stopScan() {}
  getMfiAccessories() {
    return [];
  }
  async showMfiPicker() {}
  async connect(): Promise<never> {
    throw Object.assign(new Error("Bluetooth not supported on web"), { code: "bluetooth-off" });
  }
  async disconnect() {}
  async transact(): Promise<never> {
    throw new Error("not connected");
  }
  async writeRaw() {}
}

export default registerWebModule(VehicleLinkWebModule, "VehicleLink");
