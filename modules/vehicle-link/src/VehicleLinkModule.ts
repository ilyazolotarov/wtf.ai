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

declare class VehicleLinkNativeModule extends NativeModule<VehicleLinkEvents> {
  nowUs(): number;
  getBluetoothState(): BluetoothState;
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
}

export default requireNativeModule<VehicleLinkNativeModule>("VehicleLink");
