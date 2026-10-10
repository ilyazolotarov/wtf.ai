# wtf.ai — Vehicle Link (Bluetooth ELM327) Specification

Status: v3 (2026-10-10), field-tested with the OBDLink MX+ (MFi) and the vLinker FD-IOS (BLE) on the main test car, and the MX+ on a second car over K-line. Companion to [SPEC.md](SPEC.md) §3.1. Source of truth for coding agents implementing adapter communication. The trip logger built on top of it is specified in [TRIP-LOGGER-SPEC.md](TRIP-LOGGER-SPEC.md).

## 1. Goal

Talk to as many ELM327-compatible OBD-II adapters as possible from an iPhone:

- **Every BLE adapter** (Bluetooth 4.0+ Low Energy), including no-name clones.
- **MFi-certified Classic Bluetooth adapters** (e.g. OBDLink MX+) via `ExternalAccessory`.

First target for the module:

1. Discover adapters automatically and offer the user a ranked list.
2. Connect and **verify** that the device really is an ELM327-compatible adapter.
3. Poll OBD-II vehicle speed (PID `0D`) at the highest rate this adapter + car can sustain.
4. Poll engine RPM (PID `0C`) occasionally to know whether the engine is running.
5. Expose all of this through a transport-agnostic TypeScript contract (§6) that the rest of the app uses. Nothing above the contract knows whether the adapter is BLE or MFi.

## 2. Decisions

| Topic                   | Decision                                                                                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transports              | **BLE** (CoreBluetooth) and **MFi Classic** (`ExternalAccessory`), both from the first milestone. Wi-Fi ELM327 is out of scope. Android Classic SPP is a future transport (§12).           |
| Native code             | Own Expo module `modules/vehicle-link` (Swift). Thin: scan, connect, write, frame on the `>` prompt, timestamp. No ELM327 logic in Swift. No third-party BLE library.                   |
| Protocol logic          | Pure TypeScript in `src/obd/` (no React Native imports), unit-testable in Node/Bun on Windows against an ELM327 emulator.                                                                  |
| Adapter catalog         | BLE GATT profiles and name patterns live in a **TS table** passed to native, so adding a BLE adapter needs no native build. MFi protocol strings must be in `Info.plist` → native build. |
| Command set             | Plain ELM327 subset (§9). STN commands only for read-only identification (`STI`), never for features (STN features are Stage 2, SPEC §2.1).                                              |
| Speed rate              | Closed-loop, back-to-back polling. No artificial cap apart from a 50 Hz safety ceiling and an optional per-vehicle cap derived from measured ECU refresh (§10.2).                          |
| RPM rate                | Every 5 s while the engine runs, 2 s while the ECU is awake with the engine stopped, 5 s ignition probe while the ECU is silent (§10.3).                                                    |
| Time base               | All timestamps are **monotonic uptime in µs** (`ProcessInfo.systemUptime`, same clock as CoreMotion). Wall clock only through explicit sync records.                                    |
| Lifecycle (first target) | The user opens the app; from then on connect, trip detection, and polling are automatic and continue in the background while the app stays alive. Waking a non-running app is later (§11). |

## 3. Adapter landscape (research summary)

### 3.1 What iOS can talk to

| Adapter radio                        | iOS access                                                               | Notes                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| BLE (Bluetooth 4.0+ LE)              | CoreBluetooth, **no MFi needed**, no pairing in iOS Settings             | Most modern cheap adapters. "Dual" (BT 4.0 dual-mode) adapters expose their BLE side to iOS.                   |
| Classic Bluetooth **with MFi**       | `ExternalAccessory` (EA) session over an MFi protocol string             | Must be paired in iOS Settings (or via the in-app MFi picker). App Store needs the vendor's MFi authorization (PPID) for our app (§3.4). |
| Classic Bluetooth without MFi (SPP)  | **Impossible on iOS**                                                    | The typical old "ELM327 v1.5/v2.1" blue dongle. Works on Android only (§12).                                   |
| Wi-Fi                                | TCP socket                                                               | Out of scope (SPEC §8).                                                                                        |

### 3.2 Known BLE GATT profiles

ELM327 BLE adapters expose a "serial over GATT" service: one characteristic to write commands, one (sometimes the same) that notifies responses. The catalog is matched **by UUID, not brand**; brand columns are hints only.

| Profile id  | Service UUID                           | Notify (adapter → phone)                | Write (phone → adapter)                 | Seen on                                                                                   | Source       |
| ----------- | -------------------------------------- | --------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------- | ------------ |
| `fff0`      | `FFF0`                                 | `FFF1`                                  | `FFF2`                                  | OBDLink CX, Veepeak OBDCheck BLE, many generic "OBDII"/"OBDBLE" clones                   | OBDLink docs, community |
| `ffe0`      | `FFE0`                                 | `FFE1`                                  | `FFE1` (same characteristic)            | HM-10 / TI CC254x modules: LELink and many clones                                         | community    |
| `vgate`     | `18F0`                                 | `2AF0`                                  | `2AF1`                                  | Vgate iCar Pro BLE and other Vgate models                                                 | community    |
| `e781`      | `E7810A71-73AE-499D-8C15-FAA9AEF0C3F2` | `BEF8D6C9-9C21-4C9E-B632-BD58C1009F9F`  | same characteristic                     | Generic Chinese BLE serial module, used by some adapters (and label printers)             | LTSupportAutomotive |
| `issc`      | `49535343-FE7D-4AE5-8FA9-9FAFD205E455` | by properties (notify)                  | by properties (write)                   | Microchip RN4870 / BM70 / ISP1807 modules. Characteristic UUIDs vary by firmware.          | community    |
| `nus`       | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` | `6E400003-…`                            | `6E400002-…`                            | Nordic UART: ESP32/nRF DIY adapters                                                        | Nordic docs  |
| `beef`      | `BEEF`                                 | by properties                           | by properties                           | Listed by LTSupportAutomotive; device unknown                                              | LTSupportAutomotive |
| `heuristic` | any non-standard service               | exactly one notify/indicate char        | exactly one write/write-without-response char | Anything else                                                                        | §8.2         |

Known OBDLink CX specifics (official adapter notes): MTU up to 247; bonding window is 5 minutes after power-up; **wait for each write response before the next write**; no queued writes. iOS reports a bogus 512 for `maximumWriteValueLength(for: .withResponse)`; writes that large become queued (long) writes, which the CX silently drops (found in CornucopiaStreams). So chunks are always sized by the `.withoutResponse` value (the real ATT MTU − 3), whatever the write type (§5.3).

Ignored services when searching for a UART: `1800` GAP, `1801` GATT, `180A` Device Information (read it for diagnostics), `180F` Battery, `FEF5` (OBDLink internal), and other Bluetooth SIG 16-bit services.

### 3.3 Known name patterns

Many adapters **do not advertise** their service UUID, so scanning must not filter by service and ranking uses names. Case-insensitive patterns (initial list, extend from field data):

| Pattern                                         | Brand hint                    |
| ----------------------------------------------- | ----------------------------- |
| `obdlink`                                       | OBDLink (CX on BLE)           |
| `v-?link`, `vlinker`, `vgate`, `icar`           | Vgate / vLinker               |
| `veepeak`, `obdcheck`                           | Veepeak                       |
| `lelink`                                        | LELink                        |
| `carista`                                       | Carista                       |
| `kiwi`                                          | PLX Kiwi 3/4                  |
| `konnwei`, `kw\d{3}`                            | Konnwei                       |
| `viecar`, `fixd`, `unicarscan`, `yawoa`, `tonwon`, `cyel`, `microtech` | other BLE brands reported working |
| `obd`, `elm`, `327`, `obd2`, `obdii`, `obdble`  | generic clone                 |

Known **non-ELM** devices (show with a warning, rank last): BlueDriver (proprietary protocol), xTool (not ELM327-compatible).

### 3.4 MFi (Classic Bluetooth) adapters

| Adapter                 | Manufacturer (MFi licensee)  | EA protocol string | MFi Product Plan ID (PPID) | Notes                                                                                     |
| ----------------------- | ---------------------------- | ------------------ | -------------------------- | ----------------------------------------------------------------------------------------- |
| OBDLink MX+ (STN2255)   | OBD Solutions LLC            | `com.obdlink`      | `221699-0001`              | Dev adapter on hand.                                                                      |
| Vgate vLinker FS (BT)   | ShenZhen CheBoTong           | `com.vgatemall`    | `649626-099130`            | Firmware can also switch to "BLE+BT" mode, which makes it a plain BLE adapter (§3.2).      |
| Vgate vLinker MS        | ShenZhen CheBoTong           | `com.vgatemall`    | `649626-112572`            | Same as vLinker FS.                                                                       |

- These two strings are the complete `UISupportedExternalAccessoryProtocols` list. Declare only strings backed by an MFi authorization: App Review checks every declared protocol against an approved PPID.
- Not declared: `com.scantool.stnobd` (OBDLink EX, a USB adapter, per EVMSwiftOBD2), which isn't a Bluetooth adapter and has no authorization for this app.
- iOS only reports accessories whose protocol string is declared, so MFi adapters cannot be discovered generically. Each new string = native rebuild + a new MFi authorization from that vendor.
- Ad-hoc / development builds only need the strings in `Info.plist`. For App Store submission, the PPIDs above go into the App Store Connect review information (SPEC §9).
- Both Vgate models share one protocol string; tell them apart by `EAAccessory.modelNumber` / `name`, logged in `AdapterInfo`.

### 3.5 Expected performance

- iOS BLE connection interval is 15–30 ms (Apple's minimum is 15 ms). One request/response needs at least one connection event for the write and one for the notification, so BLE caps a single adapter at roughly **15–30 polls/s** in the best case.
- On top of that: adapter firmware (clones are slow), ECU response time (typically 10–50 ms on CAN), and ELM timeout behavior when it doesn't know how many responses to wait for (fixed by the response-count suffix, §9.3).
- Expected: genuine/STN adapters 15–30 Hz, decent clones 8–15 Hz, bad clones 3–8 Hz. Measure every adapter (§13).

## 4. Architecture

```
src/app (vehicle + debug screens) ──┐
src/services/trip-recorder ─────────┤  consumers: use only the VehicleLink contract (§6)
                                    ▼
src/services/vehicle-link   (RN glue: owns the session, persistence, React bindings)
   │
   ├── src/obd/catalog      pure TS: GATT profiles, name patterns, ranking (§3, §7)
   ├── src/obd/elm327       pure TS: command queue, response parser, probe (§8), init (§9)
   ├── src/obd/pids         pure TS: Mode 01 decoders (0C, 0D, supported-PID bitmaps)
   ├── src/obd/poller       pure TS: speed/RPM scheduler, rate statistics (§10)
   ├── src/obd/engine-state pure TS: ignition/engine state machine (§10.4)
   ├── src/obd/emulator     pure TS: ELM327 + vehicle emulator (§13)
   └── src/obd/vehicle-link-core  pure TS: VehicleLink implementation (lifecycle, discovery ranking, persistence via injected store)
                                    │  Transport interface (§6.1)
          ┌─────────────────────────┼─────────────────────────┐
   NativeBleTransport        NativeMfiTransport        EmulatorTransport (tests, dev without car)
          └──────────┬──────────────┘
                     ▼
   modules/vehicle-link (Swift): CoreBluetooth + ExternalAccessory, framing, timestamps (§5)
```

- `src/obd/**` follows the `src/nav/**` rule: no React Native or Expo imports.
- `src/nav/odometry/obd` (SPEC §3.2) consumes speed samples from the VehicleLink contract; it doesn't talk to the adapter.

## 5. Native module — `modules/vehicle-link`

Local Expo module (see the `expo-module` skill). Swift only; iOS first.

### 5.1 Functions

| Function                                    | Purpose                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `initialize(options)`                       | Create `CBCentralManager` (this triggers the Bluetooth permission prompt, so call it only after a user action or when permission is already granted). Options: `restoreIdentifier` (§11). |
| `getBluetoothState()`                       | `poweredOn` / `poweredOff` / `unauthorized` / `unsupported` / `resetting` / `unknown`.                                           |
| `startScan(serviceUuids)` / `stopScan()`    | BLE scan with **no service filter**, duplicates allowed (for RSSI). Foreground only (iOS doesn't deliver unfiltered scans in background). Also lists adapters with a catalog service that are **already connected to iOS** (`retrieveConnectedPeripherals`): connected peripherals stop advertising, so a scan alone misses them after an app relaunch or while another app holds the adapter. |
| `getMfiAccessories()`                       | `EAAccessoryManager.connectedAccessories` filtered to declared protocol strings.                                                 |
| `showMfiPicker(nameFilter?)`                | `showBluetoothAccessoryPicker` — lets the user pair a nearby MFi adapter without leaving the app.                                |
| `retrieveKnownPeripheral(id)`               | `retrievePeripherals(withIdentifiers:)` — reconnect a remembered BLE adapter without scanning.                                   |
| `connect(deviceRef, gattProfiles)`          | BLE: connect, discover services/characteristics, pick the UART per profile list (§8.2), subscribe to notify, return the chosen pair + full GATT dump. MFi: open `EASession` for the protocol string; if the accessory isn't connected to iOS yet, wait for `EAAccessoryDidConnect` until the timeout (`timeoutMs: 0` = wait indefinitely). |
| `disconnect()`                              | Close session / cancel connection (also cancels a pending BLE or MFi connect).                                                   |
| `transact(command, { timeoutMs })`          | Write `command + "\r"`, collect bytes until the `>` prompt or timeout. Returns `{ raw, status: 'ok' \| 'timeout', txUs, rxFirstUs, rxUs }`. One in flight; a second call while busy rejects. |
| `writeRaw(text)`                            | Debug only (ELM terminal escape hatch): write without waiting for a prompt.                                                     |
| `nowUs()`                                   | Current monotonic time in µs (same clock as all timestamps).                                                                    |

### 5.2 Events

| Event               | Payload                                                                                                         | Rate                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `onScanBatch`       | `[{ id, name, localName, rssi, serviceUuids, manufacturerDataHex, connectable, seenUs }]`                       | batched every 250 ms     |
| `onMfiChange`       | accessory list changed (connect/disconnect notifications)                                                      | on change                |
| `onLinkState`       | `{ state: 'connecting' \| 'connected' \| 'disconnected', reason?, errorCode? }`                                | on change                |
| `onUnsolicited`     | bytes received while no transaction is in flight (`LV RESET`, `STOPPED`, stray prompts), with `rxUs`            | as received, rare        |

### 5.3 Framing and writes

- **Rx**: append notification/stream bytes to a buffer; drop `0x00` (some clones send NULs); a response is complete when `>` arrives. Pass the raw text (including CR/LF and echo) to TS; parsing is TS's job.
- **Tx (BLE)**: split into chunks of `maximumWriteValueLength(for: .withoutResponse)` for both write types (never the `.withResponse` value, see §3.2; `LinkLogic.bleChunkLimit`). Use **write with response** when the characteristic supports it, waiting for `didWriteValueFor` before the next chunk (required by OBDLink CX, safe for everything). Otherwise use write without response, gated by `canSendWriteWithoutResponse` / `peripheralIsReady(toSendWriteWithoutResponse:)`. Never use queued (long) writes.
- **Tx (MFi)**: `OutputStream` write on a dedicated thread with its own run loop; `InputStream` events feed the same Rx framer.
- **Timestamps**: `txUs` immediately before the (first) write; `rxFirstUs` on the first byte after the write; `rxUs` on the chunk containing `>`. All from `ProcessInfo.processInfo.systemUptime`.

### 5.4 Config plugin (`modules/vehicle-link/plugin`)

Adds to `Info.plist` (never hand-edit `ios/`):

- `NSBluetoothAlwaysUsageDescription` (localized EN/UK via `locales`).
- `UIBackgroundModes`: `bluetooth-central`, `external-accessory`.
- `UISupportedExternalAccessoryProtocols`: `["com.obdlink", "com.vgatemall"]` from plugin options (§3.4).

## 6. TypeScript contract

### 6.1 Transport (internal, implemented by native wrappers and the emulator)

```ts
type TransportKind = "ble" | "mfi" | "spp" | "emulator"; // spp: Android Classic Bluetooth

interface RawExchange {
  raw: string; // everything received up to and including '>'
  status: "ok" | "timeout";
  txUs: number;
  rxFirstUs?: number;
  rxUs: number;
}

interface Transport {
  readonly kind: TransportKind;
  connect(device: DeviceRef): Promise<ConnectedInfo>; // ConnectedInfo: chosen GATT pair or EA protocol, GATT dump, DIS fields
  disconnect(): Promise<void>;
  exchange(command: string, timeoutMs: number): Promise<RawExchange>;
  onUnsolicited(listener: (text: string, rxUs: number) => void): () => void;
  onLinkLost(listener: (reason: string) => void): () => void;
}
```

### 6.2 VehicleLink (public, used by the app)

```ts
type LinkState =
  | "idle"          // nothing selected
  | "discovering"
  | "connecting"
  | "probing"       // verifying ELM327 (§8)
  | "standby"       // adapter verified, vehicle ECU silent (ignition off)
  | "initializing"  // vehicle answered, configuring session (§9)
  | "polling"       // speed/RPM loop running (§10)
  | "reconnecting"  // link lost, waiting for the adapter to come back
  | "error";

type EngineState = "unknown" | "ignition-off" | "engine-off" | "engine-running";

interface DiscoveredDevice {
  id: string;                 // CBPeripheral.identifier, or "mfi:<serial>:<protocol>"
  transport: "ble" | "mfi";
  name: string | null;
  rssi?: number;
  rank: "remembered" | "known-profile" | "known-name" | "unknown" | "non-elm";
  brandHint?: string;
  profileId?: string;         // when the service UUID was advertised
  lastSeenUs: number;
}

interface AdapterInfo {
  deviceId: string;
  transport: "ble" | "mfi";
  name: string | null;
  elmVersion: string | null;  // from ATI, e.g. "ELM327 v1.5"
  description: string | null; // AT@1
  chip: string | null;        // STI answer, e.g. "STN2255 v5.10.3", null on plain ELM/clones
  suspectedClone: boolean;    // e.g. "v2.1" banner
  batteryV: number | null;    // ATRV
  capabilities: { responseCount: boolean; adaptiveTiming2: boolean; physicalAddressing: boolean };
}

interface VehicleInfo {
  protocol: string | null;    // ATDPN, e.g. "A6" → ISO 15765-4 CAN 11/500
  supportedPids01: string[];  // hex PIDs
  vin: string | null;
  speedEcu: string | null;    // responding ECU address used for 0D, e.g. "7E8"
}

interface PollStats {
  speedHz: number;            // EWMA of completed speed polls
  latencyP50Ms: number;
  latencyP95Ms: number;
  errorsLastMinute: number;
  speedCapHz: number;         // active cap (§10.2)
}

interface VehicleLinkSnapshot {
  link: LinkState;
  error: LinkError | null;
  devices: DiscoveredDevice[];
  adapter: AdapterInfo | null;
  vehicle: VehicleInfo | null;
  engine: EngineState;
  lastSpeed: SpeedSample | null;
  lastRpm: RpmSample | null;
  stats: PollStats | null;
}

interface SampleTiming { txUs: number; rxUs: number; tUs: number } // tUs = (txUs + rxUs) / 2
interface SpeedSample extends SampleTiming { speedMps: number; raw: number }      // raw = PID 0D byte, km/h
interface RpmSample extends SampleTiming { rpm: number; raw: [number, number] }   // rev/min, named unit (SPEC §6 exception)

type ElmStatus =
  | "ok" | "no-data" | "unable-to-connect" | "bus-error" | "unknown-command"
  | "stopped" | "buffer-full" | "timeout" | "parse-error" | "other";

interface ElmResponse {
  command: string;
  status: ElmStatus;
  lines: string[];            // echo and prompt stripped
  raw: string;
  txUs: number;
  rxUs: number;
}

type LinkError =
  | { code: "bluetooth-off" | "bluetooth-unauthorized" | "device-not-found" | "no-uart-service" | "not-elm327" | "link-lost" }
  | { code: "other"; message: string };

interface VehicleLink {
  getSnapshot(): VehicleLinkSnapshot;
  subscribe(listener: () => void): () => void; // for useSyncExternalStore

  startDiscovery(): void;
  stopDiscovery(): void;
  connect(deviceId: string): Promise<void>; // runs probe → init → polling automatically
  disconnect(): Promise<void>;
  forget(deviceId: string): void;
  pairMfi(): Promise<void>;                 // opens the MFi accessory picker

  /** Raw command. Queued behind the in-flight command; pauses polling for its duration. */
  send(command: string, opts?: { timeoutMs?: number }): Promise<ElmResponse>;
  /** Several commands with polling paused in between (ELM terminal, VIN read). */
  exclusive<T>(fn: (send: VehicleLink["send"]) => Promise<T>): Promise<T>;

  onSpeed(listener: (s: SpeedSample) => void): () => void;
  onRpm(listener: (s: RpmSample) => void): () => void;
  onEngineState(listener: (e: EngineState, tUs: number) => void): () => void;
  /** Every exchange with status and timings, including polls. For the logger. */
  onExchange(listener: (r: ElmResponse & { pollPid?: number }) => void): () => void;
  onLinkEvent(listener: (e: { type: string; tUs: number; detail?: string }) => void): () => void;
}
```

Rules:

- Only one command is in flight at a time (ELM327 is half-duplex). The queue priorities are: `exclusive`/`send` > RPM job > speed job.
- Writing while the ELM is still answering aborts the answer (`STOPPED`), so never write before the prompt arrives. `timeout` → recover with a bare `"\r"` and wait for `>` before the next command.
- Listeners are called synchronously in arrival order. Samples carry native timestamps, so JS jitter doesn't affect timing.
- Units follow SPEC §6 (SI). RPM is the one exception, kept in rev/min with the unit in the field name.

## 7. Discovery and the device list

- Discovery starts when the vehicle screen opens and stops when it closes (or after 60 s). It combines:
  1. **Remembered adapters** (verified before): BLE via `retrieveKnownPeripheral`, MFi when present in `getMfiAccessories()`.
  2. **BLE scan** results, ranked by catalog: advertised known service UUID → `known-profile`; name matches §3.3 → `known-name`; other named connectable devices → `unknown`; known non-ELM names → `non-elm`.
  3. **MFi accessories** already paired, plus a "Pair MFi adapter" action (`showMfiPicker`).
- List UI: sections *Remembered*, *OBD adapters* (known-profile + known-name + MFi), *Other Bluetooth devices* (collapsed; "Try anyway"). Unnamed devices hidden behind a toggle. Show RSSI bars and brand hint.
- **Auto-connect**: on app start and when the app returns to the foreground, connect to the most recently verified adapter with a pending connect that waits for it to become reachable (BLE: connect via identifier; MFi: wait for the accessory to connect to iOS, which takes a few seconds after the car wakes the adapter). A previous attempt that ended in `error` is retried. The user doesn't pick from the list again.
  - Several adapters remembered: the most recently verified first, each given 8 s to become reachable, then the next,
    round after round until one connects (link event `auto-connect: <name> not reachable in 8 s`, first round only).
    After a round nobody answered in, a remembered MFi adapter iOS reports connected goes next: everyone before it had
    a turn, and a car has one OBD port. One adapter remembered: its pending connect waits, as before. A user's connect
    or disconnect ends the rounds. Seen on 2026-10-05: a vLinker FD tried once became the most recent adapter, and the
    next drive would have waited for it forever instead of the MX+ in the car.
- Persist per adapter (`expo-sqlite/kv-store`): id, transport, name, chosen GATT profile + characteristic UUIDs, `AdapterInfo`, capabilities, last protocol (`ATSPn`), measured poll rate, `lastVerifiedAt`.
- Persist the cars seen by any adapter (`vehicleLink.cars`, most recent first, 8 at most): VIN (null when never read) and
  protocol number. `expectedVin()` before connecting is the first one's VIN (§9.1).

## 8. Verification on connect (probe)

### 8.1 Steps

| # | Step                    | Command / action                    | Timeout | Pass / outcome                                                                                       |
| - | ----------------------- | ----------------------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| 1 | Find the UART (BLE)     | service/characteristic discovery    | 10 s    | A profile matches (§8.2) → continue; none → `no-uart-service`, GATT dump logged for the catalog.       |
| 2 | Flush                   | write `"\r"`, wait for `>`          | 1 s     | Ignore result (clears half-typed input; some clones drop the first command after connect).             |
| 3 | Reset                   | `ATZ`                               | 3 s     | Banner contains `ELM327`, `ELM`, or `STN`. No answer → try `ATWS` (3 s). Still nothing → `not-elm327`. |
| 4 | Echo off                | `ATE0`                              | 1 s     | `OK` (the response may still echo the command once).                                                  |
| 5 | Identify                | `ATI`                               | 1 s     | `ELM327 vX.Y` → `elmVersion`. `v2.1` → `suspectedClone` (informational only).                          |
| 6 | Describe (optional)     | `AT@1`                              | 1 s     | Text → `description`; `?` is fine.                                                                    |
| 7 | STN identify (optional) | `STI`                               | 1 s     | `STNxxxx …` → `chip`; `?` on plain ELM/clones is fine.                                                |
| 8 | Voltage                 | `ATRV`                              | 1 s     | `12.6V` → `batteryV`. Missing → warning only (but a real OBD port must show 9–16 V).                   |
| 9 | Vehicle check           | `ATSP0` (or cached `ATSPn`), `0100` | 10 s    | `41 00 …` → vehicle present → §9. `NO DATA` / `UNABLE TO CONNECT` / `CAN ERROR` / `SEARCHING…` then nothing → adapter verified, `standby`. `?` → `not-elm327`. A cached protocol that fails with a bus error or `UNABLE TO CONNECT` → one search, `ATSP0` + `0100` (20 s); found → §9 without the cached protocol, else back to `ATSPn` and `standby`. |

- Pass = steps 3 and 4 succeed. The adapter is then marked verified and remembered.
- Every probe exchange goes to the logger transcript (TRIP-LOGGER-SPEC §6.4).
- The cached protocol is the adapter's last car's. An adapter moved to another car must not stay on it: on 2026-10-05
  the MX+ went from the main test car (CAN, 6) to the second test car (K-line, ISO 14230 KWP), and `ATSP6` + `0100` answered
  `CAN ERROR` every 5 s until the user gave up, while the OBDLink app (auto search) read the car. `NO DATA` doesn't start
  a search: the bus is there and the ECUs are asleep.
- The protocol a search finds (`ATDPN` after its `0100`) is cached at once (link event `protocol-search: protocol 6
  failed; 5 answered`): the init then locks it instead of trying the old one and searching again, which breaks a K-line
  session that just came up. `protocolSearch` in the snapshot is true while a search runs; the vehicle screen and the
  map show "Finding the car's protocol…" (UI-SPEC).
- An `0100` answered with text but no bitmap at init is a reply one command late: it is sent once more.

### 8.2 UART selection (BLE)

1. If the device advertised or exposes a catalog service (§3.2), use that profile's characteristics in catalog order (`fff0` before `issc` when both exist).
2. Otherwise, **heuristic**: in non-SIG services, pick a service with exactly one notify/indicate characteristic and exactly one write/write-without-response characteristic (they may be the same characteristic, as in `ffe0`).
3. Ambiguous (several candidates): try each in order with step 2–3 of the probe and keep the first that answers.
4. Store the chosen UUIDs per device so the next connect skips the search.

### 8.3 Response parsing (pure TS)

- Strip echo (line equal to the sent command), blank lines, `SEARCHING...`, `BUS INIT: ...OK`, and the trailing `>`.
- Map error strings to `ElmStatus`: `NO DATA`, `UNABLE TO CONNECT`, `CAN ERROR` / `BUS ERROR` / `BUS BUSY` / `FB ERROR` / `DATA ERROR` / `<RX ERROR` → `bus-error`, `?` → `unknown-command`, `STOPPED`, `BUFFER FULL`.
- Mode 01 data: accept with or without spaces and headers; find `41 <pid>` and read the data bytes; with headers on, also record the ECU address.
- Tolerate `\r`, `\r\n`, `\n\r`, and lowercase hex.

## 9. Session init (vehicle present)

### 9.1 Base configuration

`ATE0`, `ATL0`, `ATS0` (no spaces, ~30% fewer bytes), `ATH1` (headers on while identifying ECUs), `ATAT1`, then:

1. Protocol: `ATSP0` + `0100` (auto search) → `ATDPN` → `ATSPn` (lock it, so later requests never re-search). Cache `n` per VIN/adapter for fast reconnect.
   The init first asks `ATDPN`: a protocol the adapter has just found by its own search (`A5`: the probe's or
   standby's `0100` answered) is locked as is, never searched again. `ATSP0` drops the K-line session that search
   opened, and the ECU ignores a new init until its old session times out (KWP2000 P3max, ~5 s): a tester's K-line car
   went init → fail → standby → found → init for 2 min 15 s (2026-10-10), passing only when the adapter happened to
   be slow enough. The emulator's K-line profile models that session (`klineSessionMs`).
2. Supported PIDs: `0100` bitmap must contain `0C` and `0D`. Missing `0D` → error "vehicle doesn't report speed over OBD".
3. VIN: `0902` once, after §9.2 (multi-frame; clones may fail — non-fatal). Mode 09 is the engine ECU's, so with
   another ECU pinned for speed it goes to the engine ECU (`ATSH7E0` + `ATCRA7E8`), then the speed ECU is pinned
   again; the pinned ECU is the fallback. On the main test car the TCM (`7E9`) is pinned when the engine ECU misses the
   speed probe, and it answers `0902` with `7F 09 12`: that is why the VIN was in only 3 of 14 logs.
   - Still missed with that fixed: 1 of 4 main test car drives on 2026-10-05 had the VIN (and the vLinker's one drive had none).
     The init runs before the trip log starts, so the cause isn't in the logs; likely the ECU is busy while the engine
     cranks (init starts when `0100` first answers, at ignition on). Since then the setup goes into the log
     (TRIP-LOGGER-SPEC §6.4) and:
   - **Retries**: with the VIN not read, `0902` is asked again while polling, in an exclusive section (a gap of a few
     hundred ms in speed polling) 5, 15, 30, 60, 120 and 240 s after the init, each once the engine runs. Link events
     `vin: read on retry n` / `vin: not read after 6 retries`.
   - **The car list** (§7): a read VIN goes first in the list (replacing a VIN-less entry on its protocol). A missed read
     assumes the last car seen on the same protocol (`vinSource: "remembered"`, link event `vin: not read; the last car
     on protocol 6: …`); with none, or a VIN-less one, the car is unknown (`vin: null`). One adapter mostly stays in one
     car, and a car on another protocol is another car. Before, a missed read cleared the adapter's VIN, and with it the
     parked pose, speed scale and compass of the next start (NAVIGATOR-SPEC §7.4): the 2026-10-05 drive home waited
     2 min / 1.2 km in `anchored` under jamming instead of dead reckoning from where the car had parked.
   - The trip log has `vehicle_vin_source` (`read`, `remembered`; empty: unknown) next to `vehicle_vin`, both written
     again when a retry reads the VIN (TRIP-LOGGER-SPEC §6.3).

### 9.2 Pin the speed ECU

Several ECUs may answer `010D` (e.g. ECM `7E8` and TCM `7E9`), which makes the adapter wait for all of them.

1. Send `010D` with headers on; collect the responding addresses.
2. On 11-bit CAN (protocols 6/8): choose `7E8` if present, else the first responder; set `ATSH<id−8>` (physical request to that ECU, e.g. `ATSH7E0`) and `ATCRA<id>` (accept only its replies). Verify `010D` still answers; if not, revert with `ATSH7DF` + `ATAR` and keep functional addressing.
3. Other protocols: keep functional addressing; rely on the response count (§9.3).
4. `ATH0` afterwards (smaller responses), unless needed for multi-ECU diagnostics.

### 9.3 Speed-up probes

Each is measured over ~20 polls and kept only if it is accepted and actually faster/clean:

| Probe            | What                                                                                      | Fallback        |
| ---------------- | ----------------------------------------------------------------------------------------- | --------------- |
| Response count   | `010D1`: the trailing `1` tells the ELM to return after the first response (ELM327 v1.3+). Clones may answer `?` or ignore it. | `010D`          |
| Adaptive timing 2 | `ATAT2` (aggressive). Keep if `NO DATA` rate doesn't increase.                           | `ATAT1`         |
| Timeout          | Only with response count off: lower `ATST` (e.g. `19` ≈ 100 ms) if no responses are lost. | default `ATST`  |

Not used: bare-CR "repeat last command" (it saves nothing on BLE and breaks when RPM polls are interleaved); multi-PID requests (`010D0C`), since many clones mis-handle them; STN batch/monitor commands (Stage 2).

## 10. Polling

### 10.1 Scheduler

- One loop in TS (`src/obd/poller`). On each completed exchange, pick the next job: pending `send`/`exclusive` → due RPM job → speed job. The speed job is always due (back-to-back), subject to its cap.
- Speed timestamp = midpoint of `txUs` and `rxUs` (SPEC §3.1).
- Statistics: EWMA rate, latency p50/p95 over the last 100 exchanges, error counts per status. Exposed in `PollStats` and logged at 1 Hz.

### 10.2 "Maximum meaningful" speed rate

- **Default**: back-to-back polling, so the rate is whatever adapter + BLE + ECU allow. A 50 Hz safety ceiling stops runaway loops if an adapter answers instantly with garbage.
- **Meaningful limit**: polling faster than the ECU refreshes its PID `0D` value only returns duplicates. The refresh period is estimated offline from logs: during acceleration, value changes only happen on multiples of the ECU update period. `tools/triplog` provides this analysis (TRIP-LOGGER-SPEC §8). When an estimate exists for a VIN, the cap is set to `2 / refresh period` (each ECU update is seen within half a period; stored per VIN via `setSpeedCapForVin`), freeing slots for future PIDs and saving battery.
- Dev UI can override the cap (for experiments).
- Every poll is logged, so the rate decision can always be revisited from data.

### 10.3 RPM schedule and ignition probe

| Engine state      | Speed job     | RPM job (`010C`, response count when supported) |
| ----------------- | ------------- | ----------------------------------------------- |
| `engine-running`  | back-to-back  | every 5 s                                       |
| `engine-off`      | 1 Hz while speed is 0; back-to-back once the car rolls (hybrid EV mode, coasting) | every 2 s (catch restarts after auto stop-start) |
| `ignition-off`    | stopped       | every 5 s as the ignition probe                  |
| `unknown`         | stopped       | immediately, then per the resulting state        |

- `standby` (no answer to the vehicle check) probes `0100` every 5 s. On a cached protocol, every 4th check after bus
  errors / `UNABLE TO CONNECT` (not `NO DATA`) is a protocol search instead (`ATSP0` + `0100`, then `ATSPn` again):
  another car on this adapter is found within ~20 s of its ignition (link event `protocol-search`).

### 10.4 Engine / ignition state machine (`src/obd/engine-state`)

| From → To                       | Condition                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| any → `engine-running`          | 2 consecutive RPM samples ≥ 400 rpm, each different from the one before                       |
| `engine-running` → `engine-off` | 2 consecutive RPM samples < 250 rpm (auto stop-start, hybrid EV mode, key in ON position)      |
| `engine-running` → `engine-off` | the same non-zero RPM read 3 times in a row (stale value, see below)                           |
| any → `ignition-off`            | no valid response (`no-data`, `unable-to-connect`, `bus-error`, `timeout`) for ≥ 10 s          |
| `unknown` / `ignition-off` → `engine-off` | first valid RPM response (a high one counts as the first of the 2 for `engine-running`) |
| link lost                       | state becomes `unknown`                                                                        |

- Speed > 0 while `engine-off` is valid (hybrids, coasting with stop-start). Parked with the engine off, speed drops to 1 Hz: it only has to notice the car rolling, and it keeps the parked timeout fed (TRIP-LOGGER-SPEC §4).
- A running engine's RPM never repeats exactly (0.25 rpm resolution, polled seconds apart: 0 repeats in 167 samples over three real trips). Some ECUs answer with the RPM latched at the last shutdown while awake with the engine off: a test car main test car reported 796.50 for 280 s while parked with the engine off, and 724.00 after the engine was stopped. Without the repeat rule that started a trip and blocked the parked timeout.
- `ATRV` is read every 30 s (and logged). Voltage is a hint only (smart alternators make it unreliable for
  engine-state decisions): the main test car read 11.9–12.1 V for 85 % of the driving on 2 of 14 drives, 14.0–14.4 V on the
  rest.
- The main test car reports PID `0D` = 0 while reversing (3 manoeuvres in 14 drives: 2–10 km/h by GNSS, the car turning
  10–20 °/s, the phone still in the mount). Reversing isn't counted as driving forward; it looks like standing.
- Trip start/end on top of these states: TRIP-LOGGER-SPEC §4.

### 10.5 Errors and recovery

- Isolated `no-data`/`timeout` on a speed poll: log it and continue.
- `stopped` / `buffer-full`: send `"\r"`, wait for `>`, retry once.
- 3 consecutive `timeout`s with no bytes at all: the adapter is hung → `ATWS`, re-run §9 from the cached configuration.
- `?` on a command that worked before: the adapter reset itself (`LV RESET`, brown-out at cranking) → re-run §9.

## 11. Link loss, reconnect, background

- BLE link lost → `reconnecting`; issue a pending `connect` (iOS keeps it open with no timeout) and reconnect automatically when the adapter returns (e.g. after cranking brown-out). MFi: wait for `EAAccessoryDidConnect`.
- On reconnect: quick probe (steps 2–4), then §9 with the cached protocol and capabilities.
- Background, first target: polling runs in TS, which keeps running while the app is alive. The trip logger keeps the app alive with background location during a trip and for a linger period after it (TRIP-LOGGER-SPEC §4.3). `bluetooth-central` and `external-accessory` background modes keep the links alive.
- **Later: fully automatic wake** (not in the first target): `CBCentralManager` state restoration (`restoreIdentifier`) + a pending connect to the remembered adapter relaunches the app when the adapter powers up; `EAAccessoryDidConnect` for MFi; significant-location-change as a fallback for adapters that never sleep. Needs "Always" location permission to start location updates from the background. The native API already takes `restoreIdentifier` so this doesn't need a new module shape.

## 12. Android

The same contract with two transports: BLE (same GATT catalog) and Classic SPP (UUID `00001101-0000-1000-8000-00805F9B34FB`, which covers the old non-MFi Classic dongles), in Kotlin ([ANDROID-SPEC.md](ANDROID-SPEC.md) §3). Compile-checked and run against the emulated adapter only so far.

## 13. Testing

- **ELM327 emulator** (`src/obd/emulator`, pure TS) implementing `Transport`: configurable latency per command, echo default on, CR/LF variants, NUL bytes, `SEARCHING...`, multiple responding ECUs, ignition on/off/engine states, and clone profiles (no response-count support, `v2.1` banner, `?` on `AT@1`/`STI`, drops the first command, occasional `STOPPED`). Also selectable in the dev UI as a fake adapter.
- **Unit tests**: response parser (golden strings from real adapters, collected in `src/obd/__tests__/fixtures`), probe outcomes, init fallbacks, scheduler priorities and rate stats, engine-state transitions.
- **Native logic** (`modules/vehicle-link/ios/Logic/LinkLogic.swift`): UART selection, UUID normalization/validation, write chunking, MFi id parsing, and `>` prompt framing are Foundation-only and covered by XCTest in `native-tests/` (run in CI on Linux). The CoreBluetooth/ExternalAccessory glue only compiles in the CI iOS build.
- **JS bridge**: `NativeTransport` and `NativeDiscovery` are tested against a mocked native module; the config plugin is tested for the Info.plist keys.
- **Field**: tested-adapter table below, filled from real drives.

### Tested adapters

| Adapter | Transport | Chip / ELM version | Profile | Car / protocol | Speed rate (Hz) | Latency p50 / p95 | Notes |
| ------- | --------- | ------------------ | ------- | -------------- | --------------- | ----------------- | ----- |
| OBDLink MX+ | MFi (`com.obdlink`) | STN2255 v5.10.3 / ELM327 v1.4b | — | Main test car / 6 (CAN 11-bit 500k) | 25–32 moving, 20 on one drive (`010D1`, `ATSH7E0` or `7E1`, `ATAT1`) | 16–19 / 49–65 ms; 30–49 / 70–86 ms on 4 drives (cause unknown) | 18 drives. Rare stalls: replies arrive one command late, then `STOPPED` → re-init (2–6 s gap). The VIN was missed with `7E1` pinned, and still on 3 of 4 drives with `7E0` (§9.1). |
| OBDLink MX+ | MFi (`com.obdlink`) | STN2255 v5.10.3 / ELM327 v1.4b | — | Second test car / ISO 14230 KWP (K-line, `A5`) | 7–9 (`010D1`) | — | 3 drives. Found by the protocol search (§8.1); VIN read (5-line K-line format). First connect took 77 s: the init tried `ATSP6` again and searched again, which broke the fresh K-line session four times; the protocol found is now cached at once. |
| No-name "OBD II" | Classic SPP (Android) | ELM327 v1.5 (no `AT@1` text beyond the default, no `STI`) | — | A tester's K-line car / `A5` | 5.3 (`010D1`), p50 latency 169 ms | — | 1 drive (2026-10-10). First connect: 2 min 15 s to the first poll, the init searching again after each found session (§9.1, fixed). VIN read. |
| vLinker FD-IOS | BLE | STN1151 v4.3.2 / ELM327 v2.2 | — | Main test car / A6 | 26–30 moving (p50 28), 21 standing | 29 / 45 ms | 2 sessions (2026-10-05), one a 1.75 km drive with a route; VIN read on the drive, not on the first short connect. |

## 14. Verification targets

1. OBDLink MX+ (MFi) and at least one no-name BLE clone: discovered, probed, verified, polling on the main test car.
2. Unknown BLE device that isn't an adapter (e.g. headphones, a watch): rejected with `no-uart-service` or `not-elm327` within 15 s, no crash.
3. Speed rate measured and recorded per adapter; `010D1` and `ATSH` optimizations show a measurable gain or are auto-disabled.
4. Engine state: start → `engine-running` within 5 s; stop-start stop → `engine-off` (not `ignition-off`); key off → `ignition-off` within 15 s of ECU silence.
5. Link loss (unplug adapter while polling) → `reconnecting`; replug → polling again without user action.
6. Emulator-based unit tests pass on Windows; `npx expo lint`, `npx tsc --noEmit` pass.

## 15. Open items

1. Test a vLinker FS/MS over `com.vgatemall` once one is available; until then their BLE+BT mode is the tested path.
2. BLE poll rate measured on the vLinker FD-IOS (26–30 Hz, tested-adapter table): no BLE ceiling at the main test car's rate.
   Still to measure: a cheap no-name clone, and the connection interval itself (§3.5).
3. Verify Expo Modules event payload performance for scan batches; switch to typed arrays if needed.
4. Decide whether a native "repeat mode" (SPEC §3.1) is needed — only if bridge overhead measurably limits the poll rate. With the MX+ the JS loop reaches 25–29 Hz, so not needed so far.
5. The VIN (`0902`): missed on 3 of 4 main test car drives even when sent to the engine ECU. Now retried while polling, with
   the last car on the protocol assumed meanwhile (§9.1). Next drives: the setup in the log (`… s before the log:`)
   shows why the init read misses; `vin: read on retry n` how soon a retry gets it.
6. Verify the auto-connect fix on device: open the app before the car wakes the MX+; it must connect once iOS reports the accessory.
