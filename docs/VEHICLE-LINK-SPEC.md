# wtf.ai — Vehicle Link (Bluetooth ELM327) Specification

Talking to the OBD-II adapter: `modules/vehicle-link` (Swift, Kotlin) and `src/obd` (TypeScript). Companion to
[SPEC.md](SPEC.md) §3.1; the trip logger built on it is [TRIP-LOGGER-SPEC.md](TRIP-LOGGER-SPEC.md). Source of truth
for coding agents.

## 1. Goal

Talk to as many ELM327-compatible OBD-II adapters as possible: every BLE adapter including no-name clones, the
MFi-certified Classic Bluetooth adapters on iOS, and Classic SPP adapters on Android.

1. Discover adapters automatically and offer a ranked list.
2. Connect and **verify** that the device really is an ELM327-compatible adapter.
3. Poll vehicle speed (PID `0D`) at 2 Hz and engine RPM (PID `0C`) occasionally; on STN adapters, listen to the CAN
   bus between and instead of polls (§16).
4. Expose all of this through a transport-agnostic TypeScript contract (§6). Nothing above it knows which transport
   the adapter uses.

## 2. Decisions

| Topic | Decision |
| --- | --- |
| Transports | iOS: **BLE** (CoreBluetooth) and **MFi Classic** (`ExternalAccessory`). Android: BLE and **Classic SPP** (RFCOMM). Wi-Fi ELM327 is out of scope. |
| Native code | Own Expo module `modules/vehicle-link`. Thin: scan, connect, write, frame on the `>` prompt, timestamp, forward unsolicited bytes. No ELM327 logic in native code. No third-party BLE library. |
| Protocol logic | Pure TypeScript in `src/obd/` (no React Native imports), unit-tested against an ELM327 emulator. |
| Adapter catalog | BLE GATT profiles and name patterns in a **TS table** passed to native, so adding a BLE adapter needs no native build. MFi protocol strings are in `Info.plist` → a native build and the vendor's authorization. |
| Command set | Plain ELM327 subset (§9) for polling. STN commands: `STI` for identification, and the CAN monitor (§16) on STN adapters only. |
| Speed rate | **2 Hz** (`OBD_SPEED_HZ`), fixed: in replay navigation was no worse than at 25–30 Hz back-to-back (back-to-back polls repeat the same 1 km/h value, which the EKF counted as new evidence). 1 Hz while parked with the engine off. |
| RPM rate | Every 5 s while the engine runs, 2 s while the ECU is awake with the engine stopped, 5 s as the ignition probe while the ECU is silent (§10.3). A developer knob changes the engine-on period (2 / 5 / 10 s). |
| Time base | Monotonic uptime µs (`ProcessInfo.systemUptime`; `SystemClock.elapsedRealtimeNanos` on Android). |
| Lifecycle | The user opens the app; from then on connect, trip detection and polling are automatic and continue in the background while the app stays alive. Waking a non-running app is later (§11). |

## 3. Adapter landscape

### 3.1 What a phone can talk to

| Adapter radio | iOS | Android |
| --- | --- | --- |
| BLE (Bluetooth 4.0+ LE) | CoreBluetooth, no MFi, no pairing in Settings | `BluetoothGatt` |
| Classic Bluetooth **with MFi** | `ExternalAccessory` over an MFi protocol string; paired in iOS Settings or the in-app picker; the App Store needs the vendor's authorization (§3.4) | as any Classic adapter |
| Classic Bluetooth without MFi (SPP) | **Impossible** | RFCOMM, UUID `00001101-…`; must be bonded (PIN 1234/0000) |
| Wi-Fi | out of scope | out of scope |

### 3.2 BLE GATT profiles (`src/obd/catalog.ts`)

ELM327 BLE adapters expose a "serial over GATT" service: one characteristic to write commands, one (sometimes the
same) that notifies responses. Matched **by UUID, not brand**.

| Profile id | Service | Notify | Write | Seen on |
| --- | --- | --- | --- | --- |
| `fff0` | `FFF0` | `FFF1` | `FFF2` | OBDLink CX, Veepeak OBDCheck BLE, many generic clones |
| `ffe0` | `FFE0` | `FFE1` | `FFE1` (same) | HM-10 / CC254x modules: LELink and many clones |
| `vgate` | `18F0` | `2AF0` | `2AF1` | Vgate iCar Pro BLE and other Vgate models |
| `e781` | `E7810A71-…` | `BEF8D6C9-…` | same | generic Chinese BLE serial module |
| `issc` | `49535343-…` | by properties | by properties | Microchip RN4870 / BM70 / ISP1807 |
| `nus` | `6E400001-…` | `6E400003-…` | `6E400002-…` | Nordic UART: ESP32/nRF DIY adapters |
| `beef` | `BEEF` | by properties | by properties | listed by LTSupportAutomotive |
| `heuristic` | any non-SIG service | exactly one notify/indicate char | exactly one write char | anything else (§8.2) |

OBDLink CX: MTU up to 247; bonding window 5 minutes after power-up; wait for each write response before the next
write; iOS reports a bogus 512 for `maximumWriteValueLength(for: .withResponse)`, and writes that large become queued
writes the CX silently drops, so chunks are always sized by the `.withoutResponse` value (§5.3). Ignored when looking
for a UART: `1800`, `1801`, `180A` (read for diagnostics), `180F`, `FEF5` and other SIG services.

### 3.3 Name patterns

Many adapters don't advertise their service UUID, so scanning doesn't filter by service and ranking uses names
(case-insensitive): `obdlink`; `v-?link`, `vlinker`, `vgate`, `icar`; `veepeak`, `obdcheck`; `lelink`; `carista`;
`kiwi`; `konnwei`, `kw\d{3}`; `viecar`, `fixd`, `unicarscan`, `yawoa`, `tonwon`, `cyel`, `microtech`; generic `obd`,
`elm`, `327`, `obd2`, `obdii`, `obdble`. Known non-ELM devices (shown with a warning, ranked last): BlueDriver, xTool.

### 3.4 MFi adapters

| Adapter | Manufacturer | Protocol string | PPID |
| --- | --- | --- | --- |
| OBDLink MX+ (STN2255) | OBD Solutions LLC | `com.obdlink` | `221699-0001` |
| Vgate vLinker FS (BT) | ShenZhen CheBoTong | `com.vgatemall` | `649626-099130` |
| Vgate vLinker MS | ShenZhen CheBoTong | `com.vgatemall` | `649626-112572` |

These two strings are the complete `UISupportedExternalAccessoryProtocols` list (the config plugin's `mfiProtocols`).
Declare only strings backed by an authorization: App Review checks every one. iOS only reports accessories whose
string is declared, so MFi adapters cannot be discovered generically. The two Vgate models share a string; tell them
apart by `EAAccessory.modelNumber` / `name`. The vLinker FS/MS over EA is untested (none on hand); their "BLE+BT"
firmware mode makes them plain BLE adapters.

### 3.5 Expected performance

iOS BLE connection intervals (15–30 ms) cap a single adapter at roughly 15–30 polls/s; clones are slower. The link
needs 2 Hz, so every adapter tested so far has headroom; what matters is that it answers every poll without gaps
(§13).

## 4. Architecture

```
src/app (vehicle screen, ELM terminal) ──┐
src/services/trip-recorder, navigation ──┤  consumers: the VehicleLink contract (§6) only
                                         ▼
src/services/vehicle-link   (RN glue: native transports, discovery, persistence, the CAN speed feed and id picker)
   │
   ├── src/obd/catalog.ts        GATT profiles, name patterns, ranking (§3, §7)
   ├── src/obd/elm327/           session (command queue, idle monitor), parser, probe (§8), init (§9)
   ├── src/obd/pids.ts           Mode 01 decoders (0C, 0D, supported-PID bitmaps), VIN
   ├── src/obd/poller.ts         speed/RPM/battery scheduler, rate statistics (§10)
   ├── src/obd/engine-state.ts   ignition/engine state machine (§10.4)
   ├── src/obd/can-shadow.ts, can-monitor.ts   the CAN monitor between polls and the port survey (§16)
   ├── src/obd/emulator.ts       ELM327 + vehicle emulator (§13)
   └── src/obd/vehicle-link-core.ts   the VehicleLink implementation (lifecycle, discovery, cars, persistence via an injected store)
                                   │  Transport interface (§6.1)
          ┌────────────────────────┼────────────────────────┐
   NativeTransport (BLE / MFi / SPP)                 EmulatorTransport (tests, dev without a car)
          │
   modules/vehicle-link: CoreBluetooth + ExternalAccessory (Swift); BluetoothGatt + RFCOMM (Kotlin); framing, timestamps (§5)
```

## 5. Native module (`modules/vehicle-link`)

### 5.1 Functions (`src/VehicleLinkModule.ts`)

| Function | Purpose |
| --- | --- |
| `initialize(restoreIdentifier)` | Create the central manager (triggers the Bluetooth permission prompt, so only after a user action or when already granted). |
| `getBluetoothState()` | `poweredOn` / `poweredOff` / `unauthorized` / `unsupported` / `resetting` / `unknown`. |
| `startScan(serviceUuids)` / `stopScan()` | BLE scan with **no service filter**, duplicates allowed (RSSI). Foreground only. Also lists adapters with a catalog service **already connected to the phone** (`retrieveConnectedPeripherals`): connected peripherals stop advertising. |
| `getMfiAccessories()` | `EAAccessoryManager.connectedAccessories` filtered to the declared protocol strings (`[]` on Android). |
| `showMfiPicker(nameFilter)` | `showBluetoothAccessoryPicker`: pair a nearby MFi adapter without leaving the app. |
| `connect(options)` | BLE: connect by identifier (a remembered adapter needs no scan: `retrievePeripherals(withIdentifiers:)`), discover services, pick the UART per the profile list (§8.2), subscribe to notify, return the chosen pair and the full GATT dump. MFi: open an `EASession`; if the accessory isn't connected yet, wait for `EAAccessoryDidConnect` until the timeout (`timeoutMs: 0` = wait indefinitely). SPP: bond if needed, the secure socket, then the insecure and channel-1 fallbacks clones need. |
| `disconnect()` | Close the session / cancel a pending connect. |
| `transact(command, timeoutMs)` | Write `command + "\r"`, collect bytes until the `>` prompt or timeout. Returns `{ raw, status: 'ok' \| 'timeout', txUs, rxFirstUs, rxUs }`. One in flight; a second call while busy rejects. |
| `writeRaw(text)` | Write without waiting for a prompt (starts the CAN monitor; the ELM terminal). |
| `nowUs()` | The monotonic clock in µs. |

### 5.2 Events

| Event | Payload | Rate |
| --- | --- | --- |
| `onScanBatch` | `[{ id, name, localName, rssi, serviceUuids, manufacturerDataHex, connectable, seenUs }]` | every 250 ms |
| `onMfiChange` | the accessory list changed | on change |
| `onLinkState` | `{ state: 'connecting' \| 'connected' \| 'disconnected', reason?, errorCode? }` | on change |
| `onUnsolicited` | bytes received while no transaction is in flight (`LV RESET`, `STOPPED`, stray prompts, the CAN monitor's output), with `rxUs` | as received |

### 5.3 Framing and writes

- **Rx**: append bytes to a buffer; drop `0x00`; a response is complete when `>` arrives. Pass the raw text to TS;
  parsing is TS's job.
- **Tx (BLE)**: chunks of `maximumWriteValueLength(for: .withoutResponse)` for both write types (`LinkLogic.bleChunkLimit`).
  Write with response when the characteristic supports it, waiting for `didWriteValueFor` before the next chunk;
  otherwise write without response, gated by `canSendWriteWithoutResponse`. Never queued (long) writes.
- **Tx (MFi)**: `OutputStream` on a dedicated thread with its own run loop; `InputStream` events feed the same framer.
- **Timestamps**: `txUs` immediately before the (first) write; `rxFirstUs` on the first byte after it; `rxUs` on the
  chunk containing `>`.

### 5.4 Config plugin (`modules/vehicle-link/app.plugin.js`)

iOS: `NSBluetoothAlwaysUsageDescription` (localized via `locales/`), `UIBackgroundModes` `bluetooth-central` and
`external-accessory`, `UISupportedExternalAccessoryProtocols` from the `mfiProtocols` option. Android: the Bluetooth,
foreground-service, notification, wake-lock and sensor permissions (ANDROID-SPEC §2). Tested in
`modules/vehicle-link/__tests__/app-plugin.test.ts`. Never hand-edit `ios/` or `android/`.

## 6. TypeScript contract (`src/obd/types.ts`)

### 6.1 Transport (internal)

```ts
type TransportKind = "ble" | "mfi" | "spp" | "emulator";
interface RawExchange { raw: string; status: "ok" | "timeout"; txUs: number; rxFirstUs?: number; rxUs: number }
interface Transport {
  readonly kind: TransportKind;
  connect(device: DeviceRef): Promise<ConnectedInfo>;   // chosen GATT pair or EA protocol, GATT dump, DIS fields
  disconnect(): Promise<void>;
  exchange(command: string, timeoutMs: number): Promise<RawExchange>;
  writeRaw?(text: string): Promise<void>;               // no prompt awaited: starts the CAN monitor (§16)
  onUnsolicited(listener: (text: string, rxUs: number) => void): () => void;
  onLinkLost(listener: (reason: string) => void): () => void;
}
```

### 6.2 VehicleLink (public)

```ts
type LinkState = "idle" | "discovering" | "connecting" | "probing" | "standby" | "initializing" | "polling"
  | "reconnecting" | "error";
type EngineState = "unknown" | "ignition-off" | "engine-off" | "engine-running";

interface DiscoveredDevice {
  id: string;            // CBPeripheral.identifier / Android MAC, "mfi:<serial>:<protocol>", "spp:<MAC>", "emulator:<id>"
  transport: TransportKind; name: string | null; rssi?: number;
  rank: "remembered" | "known-profile" | "known-name" | "unknown" | "non-elm";
  brandHint?: string; profileId?: string; lastSeenUs: number;
}
interface AdapterInfo {
  deviceId: string; transport: TransportKind; name: string | null;
  elmVersion: string | null;   // ATI
  description: string | null;  // AT@1
  chip: string | null;         // STI, e.g. "STN2255 v5.13.1"; null on plain ELM/clones
  suspectedClone: boolean;     // "v2.1" banner
  batteryV: number | null;     // ATRV
  capabilities: { responseCount: boolean; adaptiveTiming2: boolean; physicalAddressing: boolean };
  connected: ConnectedInfo | null;
}
interface VehicleInfo {
  protocol: string | null;     // ATDPN, e.g. "A6"
  supportedPids01: string[];
  vin: string | null;
  vinSource?: "read" | "remembered" | "missing";   // §9.1
  speedEcu: string | null;     // e.g. "7E8"
}
interface PollStats { speedHz: number; latencyP50Ms: number; latencyP95Ms: number; errorsLastMinute: number; speedCapHz: number }

interface VehicleLinkSnapshot {
  link: LinkState; error: LinkError | null; devices: DiscoveredDevice[]; discovering: boolean;
  activeDeviceId: string | null; adapter: AdapterInfo | null; vehicle: VehicleInfo | null;
  protocolSearch: boolean;     // all protocols being searched (another car on this adapter), up to ~20 s
  engine: EngineState; lastSpeed: SpeedSample | null; lastRpm: RpmSample | null; stats: PollStats | null;
  tryingSinceMs: number | null; // since the link has been trying to get ready (adapter, car, VIN); the UI badge times out on it
  canShadow?: CanShadowStatus | null;   // the CAN monitor this session (§16.2)
  canOff?: "adapter" | "car" | "firmware" | null;   // why the wheels can't be read (§16.3)
}

interface SampleTiming { txUs: number; rxUs: number; tUs: number }          // tUs = (txUs + rxUs) / 2
interface SpeedSample extends SampleTiming { speedMps: number; raw: number; source?: "obd" | "can" }
interface RpmSample extends SampleTiming { rpm: number; raw: [number, number] }

type ElmStatus = "ok" | "no-data" | "unable-to-connect" | "bus-error" | "unknown-command" | "stopped"
  | "buffer-full" | "timeout" | "parse-error" | "other";
interface ElmResponse { command: string; status: ElmStatus; lines: string[]; raw: string; txUs: number; rxUs: number }

type LinkErrorCode = "bluetooth-off" | "bluetooth-unauthorized" | "device-not-found" | "no-uart-service"
  | "not-elm327" | "adapter-silent" | "no-speed-pid" | "link-lost" | "other";

interface VehicleLink {
  getSnapshot(): VehicleLinkSnapshot;
  subscribe(listener: () => void): () => void;
  startDiscovery(): void; stopDiscovery(): void;
  connect(deviceId: string): Promise<void>;   // probe → init → polling automatically
  disconnect(): Promise<void>;
  forget(deviceId: string): void;
  pairMfi(): Promise<void>;
  send(command: string, opts?: { timeoutMs?: number }): Promise<ElmResponse>;   // queued; pauses polling
  exclusive<T>(fn: (send: SendFn) => Promise<T>): Promise<T>;                   // several commands, polling paused
  onSpeed(listener: (s: SpeedSample) => void): () => void;
  onRpm(listener: (s: RpmSample) => void): () => void;
  onEngineState(listener: (e: EngineState, tUs: number) => void): () => void;
  onExchange(listener: (e: ExchangeEvent) => void): () => void;   // every exchange with status and timings, for the logger
  onLinkEvent(listener: (e: LinkEvent) => void): () => void;
}
```

Rules:

- One command in flight at a time (ELM327 is half-duplex). Queue priority: `exclusive`/`send` > RPM job > speed job.
- Writing while the ELM is still answering aborts the answer (`STOPPED`), so never write before the prompt. A
  `timeout` is recovered with a bare `"\r"` and waiting for `>`.
- Listeners are called synchronously in arrival order. Samples carry native timestamps.
- Units: SI; RPM in rev/min with the unit in the name.

## 7. Discovery and the device list

- Discovery starts when the vehicle screen opens and stops when it closes (or after 60 s): remembered adapters
  (BLE by identifier, MFi when present in `getMfiAccessories()`), the BLE scan ranked by the catalog (advertised
  known service → `known-profile`; name → `known-name`; other named connectable devices → `unknown`; known non-ELM
  names → `non-elm`), paired MFi accessories plus "New adapter" (`showMfiPicker`); on Android bonded devices plus
  discovery results.
- List: sections *Remembered*, *OBD adapters*, *Other Bluetooth devices* (collapsed; "Try anyway"); RSSI bars and
  brand hint; emulated adapters when Developer → Show emulated adapters is on.
- **Auto-connect** on app start and on return to the foreground: the most recently verified adapter with a pending
  connect that waits for it to become reachable (MFi: wait for the accessory to connect to the phone, a few seconds
  after the car wakes it). A previous attempt that ended in `error` is retried. Never an emulated adapter.
  - Several adapters remembered: the most recently verified first, each given 8 s (`AUTO_CONNECT_WINDOW_MS`), then
    the next, round after round until one connects (link event `auto-connect: <name> not reachable in 8 s`, first
    round only). After a round nobody answered in, a remembered MFi adapter the phone reports connected goes next.
    A user's connect or disconnect ends the rounds.
- Persisted per adapter (`expo-sqlite/kv-store`): id, transport, name, chosen GATT profile and characteristic UUIDs,
  `AdapterInfo`, capabilities, last protocol, `lastVerifiedAt`.
- Persisted cars (`vehicleLink.cars`, most recent first, 8 at most): VIN (null when never read) and protocol number.
  `expectedVin()` before connecting is the first one's VIN (§9.1).

## 8. Verification on connect (probe)

### 8.1 Steps

| # | Step | Command | Timeout | Pass / outcome |
| - | --- | --- | --- | --- |
| 1 | Find the UART (BLE) | service/characteristic discovery | 10 s | a profile matches (§8.2); none → `no-uart-service`, GATT dump logged |
| 2 | Flush | `"\r"`, wait for `>` | 1 s | ignore the result (some clones drop the first command) |
| 3 | Reset | `ATZ` | 3 s | banner contains `ELM327`, `ELM` or `STN`. No answer → `ATWS` (3 s), then `ATI`. Still nothing → `not-elm327`; for an adapter this phone used before that sent not a byte back, `adapter-silent`: the Vehicle screen says it may be connected to another phone, else to unplug it for a few seconds |
| 4 | Echo off | `ATE0` | 1 s | `OK` |
| 5 | Identify | `ATI` | 1 s | `elmVersion`; `v2.1` → `suspectedClone` (informational) |
| 6 | Describe | `AT@1` | 1 s | `description`; `?` is fine |
| 7 | STN identify | `STI` | 1 s | `chip`; `?` on plain ELM/clones is fine |
| 8 | Voltage | `ATRV` | 1 s | `batteryV`; missing → warning only |
| 9 | Vehicle check | `ATSP0` (or the cached `ATSPn`), `0100` | 10 s | `41 00 …` → vehicle present → §9. `NO DATA` / `UNABLE TO CONNECT` / `CAN ERROR` / `SEARCHING…` then nothing → `standby`. `?` → `not-elm327`. A cached protocol that fails with a bus error or `UNABLE TO CONNECT` → one search, `ATSP0` + `0100` (20 s); found → §9 with the new protocol, else back to `ATSPn` and `standby` |

- Pass = steps 3 and 4 succeed; the adapter is then marked verified and remembered.
- Every probe exchange goes to the logger transcript (TRIP-LOGGER-SPEC §6.4).
- The cached protocol is the adapter's last car's. An adapter moved to another car must not stay on it (a CAN
  protocol on a K-line car answered `CAN ERROR` every 5 s). `NO DATA` doesn't start a search: the bus is there and
  the ECUs are asleep.
- The protocol a search finds (`ATDPN` after its `0100`) is cached at once (link event `protocol-search: protocol 6
  failed; 5 answered`): the init then locks it instead of searching again, which breaks a K-line session that just
  came up. `protocolSearch` is true while a search runs; the vehicle screen and the map say "Finding the car's
  protocol…".
- An `0100` answered with text but no bitmap at init is a reply one command late: it is sent once more.

### 8.2 UART selection (BLE)

1. A catalog service advertised or exposed: that profile's characteristics, in catalog order (`fff0` before `issc`).
2. Otherwise the **heuristic**: in non-SIG services, a service with exactly one notify/indicate characteristic and
   exactly one write characteristic (they may be the same).
3. Several candidates: try each with probe steps 2–3 and keep the first that answers.
4. Store the chosen UUIDs per device so the next connect skips the search.

### 8.3 Response parsing (`elm327/parser.ts`)

Strip the echo, blank lines, `SEARCHING...`, `BUS INIT: ...OK` and the trailing `>`. Map error strings to
`ElmStatus` (`NO DATA`, `UNABLE TO CONNECT`, `CAN ERROR` / `BUS ERROR` / `BUS BUSY` / `FB ERROR` / `DATA ERROR` /
`<RX ERROR` → `bus-error`, `?` → `unknown-command`, `STOPPED`, `BUFFER FULL`). Mode 01 data with or without spaces
and headers (with headers, record the ECU address). Tolerate `\r`, `\r\n`, `\n\r` and lowercase hex. Golden strings
from real adapters are in `src/obd/__tests__/parser.test.ts`.

### 8.4 Firmware check (new adapters)

An adapter may have waited on a shelf for months, and its maker fixes bugs in later firmware (MX+ 5.10.3 froze in
the CAN monitor, §16.2). The app doesn't flash firmware and doesn't know the latest version: the first time an adapter
passes the probe on this phone, it sends the driver to the maker's own updater app, once per adapter.

- **Who**: the maker by MFi protocol or Bluetooth name (`firmwareUpdaterFor`, the §3.3 patterns), never by the
  chip's answers: a vLinker FD answers `STI` as `STN1151 v4.3.2` and `AT@1` as a plain ELM327. OBDLink → the OBDLink
  app (Settings → Firmware Updates); Vgate → VgateFwUpdater. No-name clones and other makers: no check.
- **When**: the first verified probe of a device id not in kv-store `adapter-firmware-asked`, while the car stands
  (link speed ≤ `MOVING_MPS`); a first connect on the road waits for a stop. The id is recorded when the page opens.
- **How**: `adapter-firmware`, a full-screen modal over whatever is open (onboarding's Car page too), pushed by the
  map screen. "Get {app}" lets go of the adapter (an adapter answers one app at a time), opens the updater's store
  page and leaves the page open, released: auto-connect stays paused (else the app coming back to the front would
  take the adapter back mid-update) until "Connect again" or the page closing, which reconnect that adapter (waiting
  while it reboots), the driver's own Connect on the Car page, or 30 minutes (a page forgotten open must not leave a
  drive without the adapter). The pause is in memory: a restarted app connects as usual. The last step tells the
  driver to close the updater, which may hold the adapter until it quits. The Car page keeps a "Check for a
  firmware update" button for a connected adapter with an updater. Developer → "Ask about adapter firmware again"
  clears the list.

## 9. Session init (vehicle present)

### 9.1 Base configuration

`ATE0`, `ATL0`, `ATS0`, `ATH1` (headers on while identifying ECUs), `ATAT1`, then:

1. **Protocol:** the init first asks `ATDPN`: a protocol the adapter has just found by its own search (`A…`: the
   probe's or standby's `0100` answered) is locked as is, never searched again (`ATSP0` drops the K-line session
   that search opened, and the ECU ignores a new init until its old session times out, ~5 s). Otherwise `ATSP0` +
   `0100` → `ATDPN` → `ATSPn`. Cached per adapter.
2. **Supported PIDs:** the `0100` bitmap must contain `0D`; missing → `no-speed-pid`.
3. **VIN:** `0902` once, after §9.2. Mode 09 is the engine ECU's, so with another ECU pinned for speed it goes to the
   engine ECU (`ATSH7E0` + `ATCRA7E8`), then the speed ECU is pinned again (a pinned TCM answers `0902` with `7F 09
   12`).
   - **Retries:** with the VIN not read, `0902` is asked again while polling, in an exclusive section, 5, 10, 15, 30,
     60 and 120 s after the init, each once the engine runs (`VIN_RETRY_MS`). Link events `vin: read on retry n` /
     `vin: not read after 6 retries`.
   - **The car list** (§7): a read VIN goes first (replacing a VIN-less entry on its protocol). A missed read assumes
     the last car seen on the same protocol (`vinSource: "remembered"`, link event `vin: not read; the last car on
     protocol 6: …`); with none, the car is unknown (`vin: null`, `"missing"` after every retry). Before this, a
     missed read cleared the adapter's VIN, and with it the parked pose, speed scale and compass of the next start.
   - The trip log has `vehicle_vin_source` next to `vehicle_vin`, both written again when a retry reads the VIN.

### 9.2 Pin the speed ECU

Several ECUs may answer `010D` (ECM `7E8` and TCM `7E9`), which makes the adapter wait for all of them.

1. Send `010D` with headers on; collect the responding addresses.
2. On 11-bit CAN (protocols 6/8): choose `7E8` if present, else the first responder; `ATSH<id−8>` and `ATCRA<id>`.
   Verify `010D` still answers; if not, revert with `ATSH7DF` + `ATAR`.
3. Other protocols: functional addressing; rely on the response count.
4. `ATH0` afterwards, unless the CAN monitor needs headers (§16).

### 9.3 Speed-up probes

Measured over ~20 polls and kept only if accepted and faster/clean: the **response count** `010D1` (ELM327 v1.3+;
clones may answer `?`: fall back to `010D`); **adaptive timing 2** `ATAT2` if the `NO DATA` rate doesn't increase;
a lower `ATST` only with the response count off. Not used: bare-CR repeat, multi-PID requests, STN batch commands.

## 10. Polling

### 10.1 Scheduler (`poller.ts`)

One loop in TS. On each completed exchange the next job is: pending `send`/`exclusive` → due RPM or battery job →
speed job. Statistics: EWMA rate, latency p50/p95 over the last 100 exchanges, error counts per status; in
`PollStats` and logged at 1 Hz.

### 10.2 Speed rate

- 2 Hz (`OBD_SPEED_HZ`, §2). The navigator treats OBD speed as stale after 2.5 s; a stop or start shows up at most
  0.5 s later.
- The 2 Hz count from when the request went out, not from when the poller asked for it (a CAN monitor break ahead of
  it can take over a second), and the poll is asked for early by how long the last breaks held the requests back
  (smoothed over ~5 polls, at most half the gap): otherwise every break came on top of the gap.
- `tools/triplog refresh` estimates an ECU's refresh period from a log, for analysis. Every poll is logged, so the
  rate decision can be revisited from data.

### 10.3 RPM schedule and ignition probe

| Engine state | Speed job | RPM job (`010C`) |
| --- | --- | --- |
| `engine-running` | 2 Hz | every 5 s (developer knob 2 / 5 / 10 s) |
| `engine-off` | 1 Hz while speed is 0; 2 Hz once the car rolls | every 2 s (catch restarts after auto stop-start) |
| `ignition-off` | stopped | every 5 s as the ignition probe |
| `unknown` | stopped | immediately, then per the resulting state |

`standby` (no answer to the vehicle check) probes `0100` every 5 s; on a cached protocol every 4th check after bus
errors / `UNABLE TO CONNECT` (not `NO DATA`) is a protocol search instead, so another car on this adapter is found
within ~20 s of its ignition.

### 10.4 Engine / ignition state machine (`engine-state.ts`)

| From → To | Condition |
| --- | --- |
| any → `engine-running` | 2 consecutive RPM samples ≥ 400 rpm, each different from the one before |
| `engine-running` → `engine-off` | 2 consecutive RPM samples < 250 rpm (auto stop-start, hybrid EV mode, key in ON) |
| `engine-running` → `engine-off` | the same non-zero RPM read 3 times in a row (a stale value latched at shutdown: a running engine's RPM never repeats exactly at 0.25 rpm resolution) |
| any → `ignition-off` | no valid response (`no-data`, `unable-to-connect`, `bus-error`, `timeout`) for ≥ 10 s, the last speed read 0 |
| any → `unknown` → `ignition-off` | the same silence right after a speed > 0: `unknown` at 10 s (the adapter or its link, not the key: an adapter froze at 39 km/h once), `ignition-off` at 2 min |
| `unknown` / `ignition-off` → `engine-off` | first valid RPM response |
| link lost | `unknown` |

- Speed > 0 while `engine-off` is valid (hybrids, coasting with stop-start). A CAN wheel speed counts as a valid read
  (§16.3).
- `ATRV` is read every 30 s and logged; voltage is a hint only (smart alternators).
- Trip start/end on top of these states: TRIP-LOGGER-SPEC §4.

### 10.5 Errors and recovery

- Isolated `no-data`/`timeout` on a speed poll: log it and continue. `stopped` / `buffer-full`: `"\r"`, wait for `>`,
  retry once.
- 3 consecutive `timeout`s with no bytes: the adapter is hung → `ATWS`, re-run §9 from the cached configuration. No
  answer to one `ATWS` (3 when standing) with the car moving, or after the CAN monitor froze (§16.2): the link is
  closed and reopened as after a link loss (§11), its probe retried with the reconnect's backoff. An MFi adapter that
  drops off the phone comes back only when it connects to the phone again; after 25 s of waiting the vehicle screen
  says to tap it in iOS Settings → Bluetooth.
- `?` on a command that worked before: the adapter reset itself (`LV RESET`, brown-out at cranking) → re-run §9.

## 11. Link loss, reconnect, background

- BLE link lost → `reconnecting`; a pending `connect` (iOS keeps it open with no timeout) reconnects when the
  adapter returns. MFi: wait for `EAAccessoryDidConnect`. On reconnect: quick probe (steps 2–4), then §9 with the
  cached protocol and capabilities.
- Background: the TS loop runs while the app is alive; the trip logger keeps the app alive with background location
  during a trip and for a linger period after it (TRIP-LOGGER-SPEC §4.3); `bluetooth-central` and
  `external-accessory` keep the links alive; on Android the foreground service does.
- **Woken by the adapter (iOS):** the central has a restoration id (`RESTORE_IDENTIFIER`, the same in Swift). With
  a connection up or a connect pending when iOS ends the app (memory, a crash; not a swipe), iOS keeps it and
  relaunches the app in the background when the adapter's link has news: mid-drive within moments, parked when the
  car is next switched on. At such a launch the central is created at once (`VehicleLinkAppDelegate`), before JS;
  JS auto-connects as at any launch, and a peripheral restored still connected is set up without a new connect.
  GNSS then needs the location session (TRIP-LOGGER-SPEC §4.3); without it the trip dead-reckons. MFi
  (`EAAccessoryDidConnect`) wakes nothing: not built.
- **Started with a drive (iOS, opt-in):** the same opt-in on iOS (onboarding and the Vehicle screen) asks for
  location "Always" (`requestBackgroundPermissionsAsync`, after saying to pick *Change to Always Allow*) and turns on
  `DriveWake` (`AppHealth.swift`): significant location changes, which relaunch the app a few hundred metres into a
  drive whatever the adapter (cell and Wi-Fi, so under jamming too). iOS shows *Change to Always Allow* once per
  install and ignores a second request, and expo-location can't tell (a new process reports "While Using" as not asked
  yet): the app keeps that it asked (`location-always-asked`), and from then on, as for any refusal, says where to go in
  Settings and opens them. Monitoring starts again at every launch, and when "Always" is granted later. A relaunch on
  the way (in the background for `location`, `on-the-way.ts`) runs the same wait as Android's task (`iosDriveWake`):
  GNSS, which "Always" may start from the background, keeps the app running while it auto-connects; a trip then keeps
  it, and if none records in 9 min GNSS stops unless the app is open (the map starts GNSS only in front). The parked
  pose is left aside unless the relaunch's location, accuracy included, is within 150 m of it (the car still stands
  there); the map says why once a trip records (NAVIGATOR-SPEC §6.1). A swipe or Background App Refresh off stops
  it.
- **Started by a companion device (Android 12+):** the opt-in that keeps the driver's position when they forget to
  open the app: an onboarding step after the adapter's, and the Vehicle screen's *Automatic startup* switch
  (`use-wake-setup.ts`). It shows the system's one-time companion dialog (`CompanionWake.kt`), offering the
  remembered adapter when it is a BLE one and Classic devices, and then asks for location "all the time"
  (`ACCESS_BACKGROUND_LOCATION`, after saying what to pick on Android's settings page). That permission is asked
  for here only. The driver picks the car's own Bluetooth (the phone connects to it at ignition) or a BLE adapter (it
  advertises while powered). A Classic adapter can't be one: it never connects by itself, so Android never sees it
  appear. The dialog can't leave it out (its Classic filter lists every Classic device): one picked that is a
  remembered `spp:` adapter is forgotten again and the driver told to pick the car's Bluetooth. The association is observed for presence; Android then binds `WakeService` when the device comes into BLE
  range or connects, starting the process if needed, and keeps it bound while the device stays. The service runs the
  headless JS task `VehicleWake` (registered in `index.ts`, React Native started without a screen): it notes `app
  woken: <how>`, auto-connects, and holds the CPU until a trip records, nothing is left to wait for (noted with why:
  no adapter remembered, no Bluetooth permission, the link's error), or 9 min pass, counted from the wake (a connect
  that waits for an adapter out of range never returns). When the process dies with the device still present
  (mid-drive), Android binds the service again some seconds later, starting the process, but reports no arrival: no
  callback within 3 s of a bind that started the process runs the task too (`restarted with the device present`), so
  the trip goes on.
  A trip that starts records under the trip service, which a companion app may start from the background
  (`REQUEST_COMPANION_START_FOREGROUND_SERVICES_FROM_BACKGROUND`). With location "all the time" GNSS runs from the
  start. Without it Android 14+ refuses the service's location type with the app off screen: the service starts
  without it (`android trip service without location` in the log), the trip dead-reckons on the car's speed and
  the IMU, and the notification gets a *Turn on GPS* button; a service started from a notification may use
  location, and so does opening the app, which starts the service again. `REQUEST_COMPANION_RUN_IN_BACKGROUND` also puts the app on
  the power allowlist. One arrival through two callbacks (the old and new APIs) acts once (`WakeLogic`); on Android
  16 the old one waits 1 s, so the new one, which says how the device appeared, is the one acted on. A device
  associated twice is listed once.

## 12. Android

The same contract with two transports, BLE (same GATT catalog) and Classic SPP, in Kotlin (ANDROID-SPEC §3). Classic
devices get the id `spp:<MAC>` so a dual-mode adapter doesn't collide with its BLE side. Road-tested with a Classic
no-name clone on a tester's car (§13).

## 13. Testing

- **ELM327 emulator** (`src/obd/emulator.ts`, pure TS) implementing `Transport`: configurable latency, echo, CR/LF
  variants, NUL bytes, `SEARCHING...`, multiple ECUs, ignition/engine states, K-line sessions (`klineSessionMs`),
  clone profiles (no response count, `v2.1` banner, `?` on `AT@1`/`STI`, drops the first command, occasional
  `STOPPED`), the STN pass filters, hardware filter and `STM` monitor with a per-profile broadcast list. Also the
  developer's emulated adapters in the app (with a scripted drive).
- **Unit tests:** parser (golden strings), probe outcomes, init fallbacks, scheduler priorities and rate stats,
  engine-state transitions, the CAN shadow and monitor, the core's lifecycle and car list.
- **Native logic** (`modules/vehicle-link/ios/Logic/LinkLogic.swift`, `android/**/logic/LinkLogic.kt`): UART
  selection, UUID normalization, write chunking, MFi id parsing, `>` framing, with XCTest and JUnit coverage. The
  CoreBluetooth/ExternalAccessory/BluetoothGatt glue only compiles in the CI builds.
- **JS bridge:** `NativeTransport` and discovery tested against a mocked native module; the config plugin for its
  Info.plist and manifest keys.

### Tested adapters

| Adapter | Transport | Chip / ELM | Car / protocol | Notes |
| --- | --- | --- | --- | --- |
| OBDLink MX+ | MFi (`com.obdlink`) | STN2255 / ELM327 v1.4b | CAN 11-bit 500k (`6`); K-line KWP (`A5`) on a second car | the main dev adapter; back-to-back it polls 25–32 Hz, latency p50 16–19 ms. Rare stalls (replies one command late, then `STOPPED` → re-init). Firmware 5.10.3 froze in the CAN monitor (§16.2); 5.13.1 doesn't. |
| vLinker FD-IOS | BLE | STN1151 / ELM327 v2.2 | CAN (`A6`) | back-to-back 26–30 Hz, latency 29 ms. Over BLE the monitor carries ~150 frames/s of the five ids' 370; the two navigation ids arrive at full rate. Doesn't take `STM n`. |
| No-name "OBD II" | Classic SPP (Android) | ELM327 v1.5, no `STI` | a tester's K-line car (`A5`) | 5.3 Hz uncapped, p50 170 ms; the speed every poll, no dropouts; navigated a 2 km route with no GNSS fix at all. |

## 14. Verification targets

1. The MFi adapter and a BLE adapter: discovered, probed, verified, polling on the main test car.
2. An unknown BLE device that isn't an adapter: rejected with `no-uart-service` or `not-elm327` within 15 s.
3. Engine state: start → `engine-running` within 5 s; stop-start stop → `engine-off`; key off → `ignition-off`
   within 15 s of ECU silence.
4. Link loss (unplug while polling) → `reconnecting`; replug → polling again without user action.
5. Emulator-based unit tests, lint and typecheck pass.

## 15. Open items

1. The vLinker FS/MS over `com.vgatemall` once one is available.
2. A cheap no-name BLE clone (the Classic one is tested on Android only).
3. The MX+ vendor's 35-minute lock-up bug in older firmware: a longer drive on 5.13.1 to confirm it is gone.
4. Auto-wake (§11).

## 16. CAN monitor (STN)

Passive listening to the CAN broadcast at the OBD port (SPEC §2.1 Stage 2). STN adapters (`STI` answered) on a CAN
car (protocol 6–9) only: plain ELM327s have one receive filter and small buffers.

### 16.1 Port survey (developer; `can-monitor.ts`)

`VehicleLinkCore.monitorCan({ ids, durationMs })` from the ELM terminal: every id for 3 s, or the ids typed (hex) for
10 s, as an exclusive section. `ATH1`; `ATAR` (clears the speed ECU's `ATCRA`, which `STM` obeys); `STCMM0` (listen
only); `STFPA <id>,7FF` per id (`000,000` for all; `STFAP` on older firmware); `STM` written without awaiting a
prompt; a bare CR after `durationMs` (any character stops the monitor); then `ATAR`, `ATCRA<pinned ECU>`, `ATH0`.
While the monitor runs the native module forwards every chunk as `onUnsolicited`. Output with headers on and spaces
off: the id (3 hex digits on 11-bit CAN, 8 on 29-bit), then 0–8 data bytes. Result per id: frames per second, data
lengths, the last bytes; logged as the link event `can-monitor`. Unfiltered monitoring isn't usable on either tested
adapter (`BUFFER FULL`, and the MX+ answered `STOPPED` to polls for seconds after): it stays a 3 s survey.

### 16.2 The CAN monitor between polls ("the shadow"; `can-shadow.ts`)

- **Where it runs.** `CanShadow` is the session's *idle monitor* (`Elm327Session.setIdleMonitor`): it starts once the
  queue is empty, no exclusive section is open and a macrotask has passed, and is stopped before the next command.
  The poller, RPM polls, `ATRV`, VIN retries and the terminal work unchanged.
- **When.** Only while the ECU is awake (`engine-off`, `engine-running`); `standby` and `ignition-off` keep the OBD
  probe.
- **Setup** (again after any other component's `ATCRA`/`ATCF`/`ATCM`/`ATAR`/`ATZ`/`ATWS`/`ATD`/`ATSP`/`ATH`/`ST…`
  command): `ATH1`, `ATAR`, `STCMM0`, `STFPA` per id (`STFAP` fallback). Headers stay on (the poll parser reads them).
- **A break** is: stop, `ATCRA<pinned ECU>`, the polls, then the receive filter opened again and `STM`. The STN pass
  filters also pass broadcast frames into request answers (with the response count the adapter returns the first
  message it passes), so pinning keeps poll answers clean. A break costs ~160 ms on the MX+.
- **Only the ids asked for** are logged: a frame with any other id is a line that lost its start (counted as
  `garbled`).
- **Stop:** a bare CR. One that times out is sent again. A stop character without an answer (the vLinker, rarely) is
  followed by a second after 3× the slowest of the session's last 100 stops, within 200–1000 ms.
- **The receive filter must open again before each window.** A bare `ATCRA` opened it only on MX+ firmware 5.10.3;
  on later firmware and on the vLinker the monitor heard frames only in the first window after a full setup. So
  **once per session a self-test** (~2 s) listens 250 ms after each of: the setup, the pin alone (must hear nothing),
  `ATCRAXXX` after a pin, a bare `ATCRA` after a pin, a full setup after a pin; then `STM 20` to see whether the
  adapter ends a window by itself after n frames. It picks the cheapest way that heard at least 30 % of what the
  open filter heard and no more frames of other ids than of the ids, and writes one link event with every count
  (`can-shadow: filter test: … → opens by ATCRAXXX from now on`). Nothing heard with the filter open (a silent bus):
  tried again a minute later. **Backstop:** a way not answered `OK`, or 5 s of listening in a row hearing none of the
  ids, moves to the next way for the session; deaf after the full setup too, the shadow is off. `ATCRAXXX` keeps the
  pass filters and opens the filter on both tested adapters; the vLinker needs a full setup for every window.
- **Failure → plain polling for the session** (link event `can-shadow: off: …`, the adapter restored with `ATAR`,
  `ATCRA<pinned>`, `ATH0`): a pass filter refused; the monitor ending by itself (a reset: the prompt arrives unasked)
  3 times; 3 stops without a prompt. `BUFFER FULL` is the link's capacity, not the adapter failing: it doesn't count,
  and with more ids than navigation needs the shadow drops to those for the session (note `can: buffer full with 5
  ids, listening to the 2 navigation needs`).
- **The adapter froze in the monitor:** a stop gets no byte back at all, CR sent twice. The shadow goes off and the
  link is reset with `ATI` after a 1 s pause, one `ATWS`, then `ATZ` (each answer a `frozen` link event); without an
  answer, closed and reopened (§10.5). The adapter id with its chip and firmware are stored and the shadow stays off
  on it (`can-shadow: off: the adapter froze in the monitor on this firmware (…)`) until the firmware changes: at
  once when the car was moving; standing, only when the reconnect still reaches the adapter 20 s later and it
  doesn't answer (standing, the silence may be the car switched off and the MX+ powering down).
- **Into the log, per window** (`can_window`, TRIP-LOGGER-SPEC §6.3): duration, frames, bytes, frames of other ids,
  the stop's latency, whether the first stop character got no prompt, how the filter was opened. Frames the stop
  drained are timed at the stop character. The transcript gets the shadow's own exchanges for the first three of each
  kind and the setup's commands including `ATCS`; answers that went wrong are link events (up to 30).
- **Off:** turning the setting off restores the adapter the same way. A reinit drops the shadow; the next init sets
  it up again.

### 16.3 Speed from the wheels (Settings → Car, on by default)

With the shadow on, the navigator's speed comes from the wheels and the monitor listens without the polls' breaks
while the car moves.

- **Decoded on the phone** (`services/vehicle-link/can-speed-feed.ts`) as replay decodes a log (`withCanSpeed`): the
  profile from the VIN's make and the ids heard, after 200 frames (none with a wheel or speed message after 3000:
  noted, OBD stays); wheel samples averaged per 0.1 s (`CanSpeedAverager`, the same code as replay); negative in
  reverse gear. Note `can primary: speed from the wheels, profile …`.
- **A profile without wheel speeds** (VW PQ, Ford, Tesla Model 3, MG, BYD, Chrysler/Ram, Rivian) gives its speed
  message instead (`CanSpeedFrom`, mostly the ABS module's), signed by the gear the same way; turns stay on the
  phone's gyro.
- **The link** (`VehicleLinkCore.pushCanSpeed`): CAN speed goes to the navigator, the trip detector and the engine
  state (it proves the ECU awake while no poll asks). OBD's speed is passed on only when the last CAN speed is over
  0.3 s old.
- **No polls while the car moves:** the poller waits while the last CAN speed is under 0.5 s old and at least 1 km/h.
  A standing car's wheels don't prove the ECU awake (the body's bus keeps sending the wheels at 0 after the engine
  ECU is off), so only the polls' silence tells `ignition-off`, and with it the monitor stops; standing, or without
  fresh CAN speed, the polls run as always.
- **One long window for a moving car:** an OBD speed of at least 1 km/h without a fresh CAN speed pauses the polls
  1.2 s once, so the monitor gets a window that can bring a CAN speed (on a slow link the 2 Hz polls left it no
  window at all); none in the window, the polls run and the next window comes after 10 s.
- **Only with a live monitor:** nothing pauses the polls unless the monitor is on this session and hasn't failed.
  With the setting on and an adapter or car that can't, the link polls as without it. The snapshot says why
  (`canOff`: `adapter`, `car`, `firmware`) and the Car page shows it.
- **The log** says `can_primary: on` (TRIP-LOGGER-SPEC §6.2); a change mid-drive is the note `can bus off|primary`.
  Replay through the app drives the navigator on the decoded wheels, as the phone did.
- **Off:** no CAN command at all. Older stored settings (typed ids, a log-only mode) are dropped on load.

### 16.4 Ids picked for the car (`can-auto-ids.ts`)

- **Candidates from the VIN's make:** every platform's ids that navigation needs (the wheel speeds and their
  direction signals, else the speed; the gear). Up to 11 for a make.
- **Probing:** the shadow listens to up to 8 at a time; after 2 s of frames the make's profiles are matched against
  the ids heard, and the first with a speed id heard wins. The shadow then listens to that platform's ids only, kept
  per VIN (`vehicleLink.canAutoIds`) and tried first next time. Note `can auto: <make>/…, ids …`. A batch not heard
  in 3 s (`PROBE_SILENT_US`): the next batch (under the monitor's own 5 s backstop).
- **Nothing to pick:** no VIN yet (it waits), a make without a profile, or none of the candidates heard: the monitor
  stays off and the navigator on OBD. Another VIN starts over.
- **Remembered per VIN** (`vehicleLink.canAutoNone`): none heard on 2 drives (with the same candidate ids) while OBD
  showed the car moving during some of the silent listening → the car is OBD only from the start. Parked with the
  ECU awake the wheels may not be on the bus yet: that drive is OBD only, noted `not counted`. New candidates, or
  turning the setting off and on, try again; ids heard later forget it. Two drives, not one: a single deaf session
  must not take the wheels from a car that has them.
- A car without a profile: the ELM terminal's survey (§16.1) is the tool.
