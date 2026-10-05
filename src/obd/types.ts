// Public and internal types of the vehicle link (docs/VEHICLE-LINK-SPEC.md §6).
// Pure TS: no React Native / Expo imports.

export type TransportKind = "ble" | "mfi" | "emulator";

/** One request/response at the transport level (native `transact`). */
export interface RawExchange {
  /** Everything received up to and including the `>` prompt. */
  raw: string;
  status: "ok" | "timeout";
  txUs: number;
  rxFirstUs?: number;
  rxUs: number;
}

export interface GattProfile {
  id: string;
  service: string;
  /** Missing → pick by characteristic properties. */
  notify?: string;
  write?: string;
}

export interface GattCharacteristicDump {
  uuid: string;
  properties: string[];
}

export interface GattServiceDump {
  uuid: string;
  characteristics: GattCharacteristicDump[];
}

export interface ConnectedInfo {
  /** Chosen BLE UART (absent for MFi / emulator). */
  gatt?: { profileId: string; service: string; notify: string; write: string };
  gattDump?: GattServiceDump[];
  /** Device Information Service fields (BLE) or EAAccessory fields (MFi). */
  deviceInfo?: Record<string, string>;
  /** EA protocol string used (MFi). */
  protocol?: string;
}

export interface Transport {
  readonly kind: TransportKind;
  /** `wait`: keep the connect pending until the adapter is reachable (no timeout). */
  connect(options?: { wait?: boolean }): Promise<ConnectedInfo>;
  disconnect(): Promise<void>;
  /** Write `command + "\r"`, resolve on `>` or timeout. One in flight. */
  exchange(command: string, timeoutMs: number): Promise<RawExchange>;
  onUnsolicited(listener: (text: string, rxUs: number) => void): () => void;
  onLinkLost(listener: (reason: string) => void): () => void;
}

export type LinkState =
  | "idle"
  | "discovering"
  | "connecting"
  | "probing"
  | "standby"
  | "initializing"
  | "polling"
  | "reconnecting"
  | "error";

export type EngineState =
  | "unknown"
  | "ignition-off"
  | "engine-off"
  | "engine-running";

export type DeviceRank =
  | "remembered"
  | "known-profile"
  | "known-name"
  | "unknown"
  | "non-elm";

export interface DiscoveredDevice {
  /** CBPeripheral.identifier, "mfi:<serial>:<protocol>", or "emulator:<id>". */
  id: string;
  transport: TransportKind;
  name: string | null;
  rssi?: number;
  rank: DeviceRank;
  brandHint?: string;
  profileId?: string;
  lastSeenUs: number;
}

export interface AdapterCapabilities {
  responseCount: boolean;
  adaptiveTiming2: boolean;
  physicalAddressing: boolean;
}

export interface AdapterInfo {
  deviceId: string;
  transport: TransportKind;
  name: string | null;
  elmVersion: string | null;
  description: string | null;
  chip: string | null;
  suspectedClone: boolean;
  batteryV: number | null;
  capabilities: AdapterCapabilities;
  connected: ConnectedInfo | null;
}

export interface VehicleInfo {
  /** ATDPN answer, e.g. "A6". */
  protocol: string | null;
  supportedPids01: string[];
  /** Null: a car not seen before on this protocol, its VIN not read (yet). */
  vin: string | null;
  /**
   * "read" from the car (`0902`); "remembered": the read missed, so the last car seen on this protocol is assumed
   * until a retry reads it (VEHICLE-LINK-SPEC §9.1).
   */
  vinSource?: "read" | "remembered";
  speedEcu: string | null;
}

export interface PollStats {
  speedHz: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  errorsLastMinute: number;
  speedCapHz: number;
}

export interface SampleTiming {
  txUs: number;
  rxUs: number;
  /** Midpoint of tx and rx (SPEC §3.1). */
  tUs: number;
}

export interface SpeedSample extends SampleTiming {
  speedMps: number;
  /** PID 0D byte, km/h. */
  raw: number;
}

export interface RpmSample extends SampleTiming {
  rpm: number;
  raw: [number, number];
}

export type ElmStatus =
  | "ok"
  | "no-data"
  | "unable-to-connect"
  | "bus-error"
  | "unknown-command"
  | "stopped"
  | "buffer-full"
  | "timeout"
  | "parse-error"
  | "other";

/** Same order as `obd_pid.status` in the trip log (TRIP-LOGGER-SPEC §6.5). */
export const ELM_STATUS_CODES: readonly ElmStatus[] = [
  "ok",
  "no-data",
  "timeout",
  "unable-to-connect",
  "bus-error",
  "unknown-command",
  "stopped",
  "buffer-full",
  "parse-error",
  "other",
];

export interface ElmResponse {
  command: string;
  status: ElmStatus;
  /** Echo, status noise and prompt stripped. */
  lines: string[];
  raw: string;
  txUs: number;
  rxUs: number;
}

export interface ExchangeEvent extends ElmResponse {
  /** Set for poll exchanges: Mode 01 PID polled. */
  pollPid?: number;
  /** Raw data bytes of the poll answer (for the logger). */
  pollBytes?: number[];
  /** Responding ECU (CAN id), when known. */
  pollEcu?: number;
  /** Decoded SI value (m/s for 0D, rpm for 0C). */
  pollValue?: number;
}

export type LinkErrorCode =
  | "bluetooth-off"
  | "bluetooth-unauthorized"
  | "device-not-found"
  | "no-uart-service"
  | "not-elm327"
  | "no-speed-pid"
  | "link-lost"
  | "other";

export interface LinkError {
  code: LinkErrorCode;
  message?: string;
}

export interface LinkEvent {
  type: string;
  tUs: number;
  detail?: string;
}

export interface VehicleLinkSnapshot {
  link: LinkState;
  error: LinkError | null;
  devices: DiscoveredDevice[];
  discovering: boolean;
  activeDeviceId: string | null;
  adapter: AdapterInfo | null;
  vehicle: VehicleInfo | null;
  engine: EngineState;
  lastSpeed: SpeedSample | null;
  lastRpm: RpmSample | null;
  stats: PollStats | null;
}

export type SendFn = (
  command: string,
  opts?: { timeoutMs?: number },
) => Promise<ElmResponse>;

export interface VehicleLink {
  getSnapshot(): VehicleLinkSnapshot;
  subscribe(listener: () => void): () => void;

  startDiscovery(): void;
  stopDiscovery(): void;
  connect(deviceId: string): Promise<void>;
  disconnect(): Promise<void>;
  forget(deviceId: string): void;
  pairMfi(): Promise<void>;

  send: SendFn;
  exclusive<T>(fn: (send: SendFn) => Promise<T>): Promise<T>;

  onSpeed(listener: (s: SpeedSample) => void): () => void;
  onRpm(listener: (s: RpmSample) => void): () => void;
  onEngineState(listener: (e: EngineState, tUs: number) => void): () => void;
  onExchange(listener: (e: ExchangeEvent) => void): () => void;
  onLinkEvent(listener: (e: LinkEvent) => void): () => void;
}
