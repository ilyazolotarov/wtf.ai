import { NativeModule, requireNativeModule } from "expo";

// Typed binding for modules/vehicle-link (docs/VEHICLE-LINK-SPEC.md §5).

export type BluetoothState =
  | "poweredOn"
  | "poweredOff"
  | "unauthorized"
  | "unsupported"
  | "resetting"
  | "notDetermined"
  | "unknown";

export interface NativeScanResult {
  id: string;
  name?: string;
  /** Missing for adapters already connected to iOS (listed via retrieveConnectedPeripherals). */
  rssi?: number;
  serviceUuids: string[];
  systemConnected?: boolean;
  manufacturerDataHex?: string;
  connectable: boolean;
  seenUs: number;
  /** Android only: `spp` for Classic Bluetooth serial devices (id `spp:<MAC>`); iOS and Android BLE leave it out. */
  transport?: "ble" | "spp";
  /** Android only: paired with this phone already. */
  bonded?: boolean;
}

export interface NativeMfiAccessory {
  id: string;
  name: string;
  manufacturer: string;
  modelNumber: string;
  serialNumber: string;
  firmwareRevision: string;
  hardwareRevision: string;
  protocol: string;
  protocolStrings: string[];
}

export interface NativeGattProfile {
  id: string;
  service: string;
  notify?: string;
  write?: string;
}

export interface NativeConnectOptions {
  id: string;
  transport: "ble" | "mfi" | "spp";
  profiles: NativeGattProfile[];
  preferred?: [string, string, string];
  /** 0 = pending connect without timeout (reconnect). */
  timeoutMs: number;
}

export interface NativeConnectResult {
  gatt?: { profileId: string; service: string; notify: string; write: string };
  gattDump?: { uuid: string; characteristics: { uuid: string; properties: string[] }[] }[];
  deviceInfo?: Record<string, string>;
  protocol?: string;
}

export interface NativeExchange {
  raw: string;
  status: "ok" | "timeout";
  txUs: number;
  rxFirstUs?: number;
  rxUs: number;
}

export type VehicleLinkEvents = {
  onScanBatch: (e: { devices: NativeScanResult[] }) => void;
  onMfiChange: (e: { accessories: NativeMfiAccessory[] }) => void;
  onLinkState: (e: { state: "connected" | "disconnected"; reason?: string }) => void;
  onUnsolicited: (e: { text: string; rxUs: number }) => void;
  onBluetoothState: (e: { state: BluetoothState }) => void;
};

/** A device that wakes the app when it appears (Android, VEHICLE-LINK-SPEC §11). */
export interface NativeWakeDevice {
  address: string;
  name: string | null;
}

declare class VehicleLinkNativeModule extends NativeModule<VehicleLinkEvents> {
  nowUs(): number;
  getBluetoothState(): BluetoothState;
  /** `restoreIdentifier`: iOS state restoration (relaunched for the adapter after ending the app); Android ignores it. */
  initialize(restoreIdentifier: string | null): Promise<BluetoothState>;
  /** `serviceUuids`: catalog services, used to also list adapters already connected to iOS. */
  startScan(serviceUuids: string[]): void;
  stopScan(): void;
  getMfiAccessories(): NativeMfiAccessory[];
  showMfiPicker(nameFilter: string | null): Promise<void>;
  connect(options: NativeConnectOptions): Promise<NativeConnectResult>;
  disconnect(): Promise<void>;
  transact(command: string, timeoutMs: number): Promise<NativeExchange>;
  writeRaw(text: string): Promise<void>;
  /** Android 12+ only (undefined on iOS and web): the companion devices that wake the app. */
  wakeSupported?(): boolean;
  wakeDevices?(): NativeWakeDevice[];
  /** The system's dialog, offering `bleAddress` (a BLE adapter) and Classic devices; null when cancelled. */
  addWakeDevice?(bleAddress: string | null): Promise<NativeWakeDevice | null>;
  forgetWakeDevice?(address: string): void;
}

export default requireNativeModule<VehicleLinkNativeModule>("VehicleLink");
