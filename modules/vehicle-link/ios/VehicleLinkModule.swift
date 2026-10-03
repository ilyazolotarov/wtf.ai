import CoreBluetooth
import ExpoModulesCore
import ExternalAccessory

// Thin transport for ELM327 adapters (docs/VEHICLE-LINK-SPEC.md §5):
// BLE (CoreBluetooth) + MFi (ExternalAccessory). Scan, connect, write, frame on the
// ELM `>` prompt, timestamp with the monotonic uptime clock. No protocol logic here.

struct GattProfileRecord: Record {
  @Field var id: String = ""
  @Field var service: String = ""
  @Field var notify: String?
  @Field var write: String?
}

struct ConnectOptions: Record {
  @Field var id: String = ""
  @Field var transport: String = "ble"
  @Field var profiles: [GattProfileRecord] = []
  /** UART remembered from a previous connection: [service, notify, write]. */
  @Field var preferred: [String]?
  /** 0 = no timeout (pending connect, used for reconnects). */
  @Field var timeoutMs: Double = 15000
}

public class VehicleLinkModule: Module {
  private var core: LinkCore?

  public func definition() -> ModuleDefinition {
    Name("VehicleLink")

    Events("onScanBatch", "onMfiChange", "onLinkState", "onUnsolicited", "onBluetoothState")

    OnCreate {
      self.core = LinkCore(emit: { [weak self] name, body in
        self?.sendEvent(name, body.mapValues { Optional($0) })
      })
    }

    OnDestroy {
      self.core?.shutdown()
    }

    Function("nowUs") { () -> Double in
      return LinkCore.nowUs()
    }

    Function("getBluetoothState") { () -> String in
      return self.core?.bluetoothState() ?? "unknown"
    }

    AsyncFunction("initialize") { (restoreIdentifier: String?, promise: Promise) in
      self.core?.initialize(restoreIdentifier: restoreIdentifier, promise: promise)
    }

    Function("startScan") { (serviceUuids: [String]) -> Void in
      self.core?.startScan(serviceUuids: serviceUuids)
    }

    Function("stopScan") { () -> Void in
      self.core?.stopScan()
    }

    Function("getMfiAccessories") { () -> [[String: Any]] in
      return LinkCore.mfiAccessories()
    }

    AsyncFunction("showMfiPicker") { (nameFilter: String?, promise: Promise) in
      let predicate: NSPredicate? = (nameFilter?.isEmpty == false)
        ? NSPredicate(format: "SELF CONTAINS[c] %@", nameFilter!)
        : nil
      EAAccessoryManager.shared().showBluetoothAccessoryPicker(withNameFilter: predicate) { error in
        if let error = error as NSError?, error.code != EABluetoothAccessoryPickerError.Code.alreadyConnected.rawValue,
           error.code != EABluetoothAccessoryPickerError.Code.resultCancelled.rawValue {
          promise.reject("picker-failed", error.localizedDescription)
        } else {
          promise.resolve(nil)
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("connect") { (options: ConnectOptions, promise: Promise) in
      self.core?.connect(options: options, promise: promise)
    }

    AsyncFunction("disconnect") { (promise: Promise) in
      self.core?.disconnect(promise: promise)
    }

    AsyncFunction("transact") { (command: String, timeoutMs: Double, promise: Promise) in
      self.core?.transact(command: command, timeoutMs: timeoutMs, promise: promise)
    }

    AsyncFunction("writeRaw") { (text: String, promise: Promise) in
      self.core?.writeRaw(text: text, promise: promise)
    }
  }
}

// MARK: - Core

final class LinkCore: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate, StreamDelegate {
  typealias Emit = (String, [String: Any]) -> Void

  static func nowUs() -> Double {
    return ProcessInfo.processInfo.systemUptime * 1_000_000
  }

  private let queue = DispatchQueue(label: "ai.wtf.vehiclelink")
  private let emit: Emit

  // BLE
  private var central: CBCentralManager?
  private var stateWaiters: [(String) -> Void] = []
  private var scanning = false
  private var catalogServices: [CBUUID] = []
  private var scanBuffer: [String: [String: Any]] = [:]
  private var scanTimer: DispatchSourceTimer?
  private var known: [UUID: CBPeripheral] = [:]

  // Active link
  private enum Kind { case none, ble, mfi }
  private var kind: Kind = .none
  private var linkUp = false
  private var connectPromise: Promise?
  private var connectTimer: DispatchWorkItem?
  private var connectOptions: ConnectOptions?

  private var peripheral: CBPeripheral?
  private var notifyChar: CBCharacteristic?
  private var writeChar: CBCharacteristic?
  private var servicesPending = 0
  private var gattDump: [[String: Any]] = []

  private var eaSession: EASession?
  private var eaAccessory: EAAccessory?
  private var eaProtocol: String?
  /** Touched on the main thread only (MFi streams live on the main run loop). */
  private var eaOutput = Data()
  private var mainOutputStream: OutputStream?

  // Transactions
  private struct Pending {
    let id: Int
    let promise: Promise
    let txUs: Double
    var rxFirstUs: Double?
  }
  private var pending: Pending?
  private var pendingSeq = 0
  private var framer = PromptFramer()
  private var bleChunks: [Data] = []
  private var bleAwaitingWriteAck = false

  init(emit: @escaping Emit) {
    self.emit = emit
    super.init()
    DispatchQueue.main.async { EAAccessoryManager.shared().registerForLocalNotifications() }
    NotificationCenter.default.addObserver(
      self, selector: #selector(accessoryDidConnect(_:)), name: .EAAccessoryDidConnect, object: nil)
    NotificationCenter.default.addObserver(
      self, selector: #selector(accessoryDidDisconnect(_:)), name: .EAAccessoryDidDisconnect, object: nil)
  }

  func shutdown() {
    NotificationCenter.default.removeObserver(self)
    queue.async {
      self.closeLink(reason: "module destroyed", notify: false)
      self.stopScanLocked()
    }
  }

  // MARK: Bluetooth state

  private static func stateString(_ state: CBManagerState) -> String {
    switch state {
    case .poweredOn: return "poweredOn"
    case .poweredOff: return "poweredOff"
    case .unauthorized: return "unauthorized"
    case .unsupported: return "unsupported"
    case .resetting: return "resetting"
    default: return "unknown"
    }
  }

  func bluetoothState() -> String {
    if let central = central { return LinkCore.stateString(central.state) }
    switch CBManager.authorization {
    case .notDetermined: return "notDetermined"
    case .denied, .restricted: return "unauthorized"
    default: return "unknown"
    }
  }

  func initialize(restoreIdentifier: String?, promise: Promise) {
    queue.async {
      if self.central == nil {
        var options: [String: Any] = [CBCentralManagerOptionShowPowerAlertKey: true]
        if let id = restoreIdentifier, !id.isEmpty {
          options[CBCentralManagerOptionRestoreIdentifierKey] = id
        }
        self.central = CBCentralManager(delegate: self, queue: self.queue, options: options)
      }
      self.whenStateKnown { state in promise.resolve(state) }
    }
  }

  /** Calls back once the central leaves the unknown/resetting state (max 5 s). */
  private func whenStateKnown(_ done: @escaping (String) -> Void) {
    guard let central = central else { done("unknown"); return }
    if central.state != .unknown && central.state != .resetting {
      done(LinkCore.stateString(central.state))
      return
    }
    var finished = false
    let wrapped: (String) -> Void = { state in
      if finished { return }
      finished = true
      done(state)
    }
    stateWaiters.append(wrapped)
    queue.asyncAfter(deadline: .now() + 5) {
      wrapped(LinkCore.stateString(central.state))
    }
  }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    let state = LinkCore.stateString(central.state)
    emit("onBluetoothState", ["state": state])
    if central.state != .unknown && central.state != .resetting {
      let waiters = stateWaiters
      stateWaiters = []
      waiters.forEach { $0(state) }
    }
    if central.state == .poweredOn && scanning {
      startScanLocked()
    }
    if central.state != .poweredOn && kind == .ble {
      closeLink(reason: "bluetooth \(state)", notify: true)
    }
  }

  func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
    if let peripherals = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] {
      for p in peripherals { known[p.identifier] = p }
    }
  }

  // MARK: Scan

  /** `serviceUuids`: catalog services, used to find adapters already connected to iOS (they don't advertise). */
  func startScan(serviceUuids: [String]) {
    queue.async {
      self.scanning = true
      self.catalogServices = serviceUuids.filter(LinkLogic.isValidUUIDString).map { CBUUID(string: $0) }
      self.startScanLocked()
    }
  }

  func stopScan() {
    queue.async { self.stopScanLocked() }
  }

  private func startScanLocked() {
    guard let central = central, central.state == .poweredOn else { return }
    // A peripheral already connected at the system level (app relaunch, another app) stops
    // advertising, so a scan never sees it — list those explicitly (noted in CornucopiaStreams).
    if !catalogServices.isEmpty {
      for p in central.retrieveConnectedPeripherals(withServices: catalogServices) {
        known[p.identifier] = p
        var entry: [String: Any] = [
          "id": p.identifier.uuidString,
          "serviceUuids": [String](),
          "connectable": true,
          "systemConnected": true,
          "seenUs": LinkCore.nowUs(),
        ]
        if let name = p.name { entry["name"] = name }
        scanBuffer[p.identifier.uuidString] = entry
      }
    }
    central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
    if scanTimer == nil {
      let timer = DispatchSource.makeTimerSource(queue: queue)
      timer.schedule(deadline: .now() + 0.25, repeating: 0.25)
      timer.setEventHandler { [weak self] in self?.flushScan() }
      timer.resume()
      scanTimer = timer
    }
  }

  private func stopScanLocked() {
    scanning = false
    if let central = central, central.state == .poweredOn { central.stopScan() }
    scanTimer?.cancel()
    scanTimer = nil
    flushScan()
  }

  private func flushScan() {
    if scanBuffer.isEmpty { return }
    let batch = Array(scanBuffer.values)
    scanBuffer.removeAll()
    emit("onScanBatch", ["devices": batch])
  }

  func centralManager(
    _ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any], rssi RSSI: NSNumber
  ) {
    known[peripheral.identifier] = peripheral
    var services: [String] = []
    if let uuids = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] {
      services += uuids.map { $0.uuidString }
    }
    if let uuids = advertisementData[CBAdvertisementDataOverflowServiceUUIDsKey] as? [CBUUID] {
      services += uuids.map { $0.uuidString }
    }
    var entry: [String: Any] = [
      "id": peripheral.identifier.uuidString,
      "rssi": RSSI.intValue,
      "serviceUuids": services,
      "connectable": (advertisementData[CBAdvertisementDataIsConnectable] as? NSNumber)?.boolValue ?? true,
      "seenUs": LinkCore.nowUs(),
    ]
    let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name
    if let name = name { entry["name"] = name }
    if let data = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data {
      entry["manufacturerDataHex"] = data.map { String(format: "%02X", $0) }.joined()
    }
    scanBuffer[peripheral.identifier.uuidString] = entry
  }

  // MARK: MFi listing

  static func mfiAccessories() -> [[String: Any]] {
    let declared = (Bundle.main.object(forInfoDictionaryKey: "UISupportedExternalAccessoryProtocols") as? [String]) ?? []
    return EAAccessoryManager.shared().connectedAccessories.compactMap { accessory in
      guard let proto = accessory.protocolStrings.first(where: { declared.contains($0) }) else { return nil }
      return [
        "id": "mfi:\(accessory.serialNumber):\(proto)",
        "name": accessory.name,
        "manufacturer": accessory.manufacturer,
        "modelNumber": accessory.modelNumber,
        "serialNumber": accessory.serialNumber,
        "firmwareRevision": accessory.firmwareRevision,
        "hardwareRevision": accessory.hardwareRevision,
        "protocol": proto,
        "protocolStrings": accessory.protocolStrings,
      ]
    }
  }

  @objc private func accessoryDidConnect(_ note: Notification) {
    emit("onMfiChange", ["accessories": LinkCore.mfiAccessories()])
  }

  @objc private func accessoryDidDisconnect(_ note: Notification) {
    let accessory = note.userInfo?[EAAccessoryKey] as? EAAccessory
    queue.async {
      if self.kind == .mfi, let accessory = accessory, accessory.connectionID == self.eaAccessory?.connectionID {
        self.closeLink(reason: "accessory disconnected", notify: true)
      }
    }
    emit("onMfiChange", ["accessories": LinkCore.mfiAccessories()])
  }

  // MARK: Connect / disconnect

  func connect(options: ConnectOptions, promise: Promise) {
    queue.async {
      self.closeLink(reason: "new connection", notify: false)
      self.connectOptions = options
      self.connectPromise = promise
      if options.timeoutMs > 0 {
        let timer = DispatchWorkItem { [weak self] in
          self?.failConnect(code: "timeout", message: "connect timed out")
        }
        self.connectTimer = timer
        self.queue.asyncAfter(deadline: .now() + options.timeoutMs / 1000, execute: timer)
      }
      if options.transport == "mfi" {
        self.connectMfi(options: options)
      } else {
        self.connectBle(options: options)
      }
    }
  }

  func disconnect(promise: Promise) {
    queue.async {
      self.failConnect(code: "cancelled", message: "disconnect requested")
      self.closeLink(reason: "disconnect requested", notify: false)
      promise.resolve(nil)
    }
  }

  private func failConnect(code: String, message: String) {
    guard let promise = connectPromise else { return }
    connectPromise = nil
    connectTimer?.cancel()
    connectTimer = nil
    if let p = peripheral, kind == .ble { central?.cancelPeripheralConnection(p) }
    kind = .none
    peripheral = nil
    promise.reject(code, message)
  }

  private func succeedConnect(_ info: [String: Any]) {
    guard let promise = connectPromise else { return }
    connectPromise = nil
    connectTimer?.cancel()
    connectTimer = nil
    linkUp = true
    emit("onLinkState", ["state": "connected"])
    promise.resolve(info)
  }

  private func closeLink(reason: String, notify: Bool) {
    let wasUp = linkUp
    linkUp = false
    if let pending = pending {
      self.pending = nil
      pending.promise.reject("link-lost", reason)
    }
    framer.reset()
    bleChunks.removeAll()
    bleAwaitingWriteAck = false
    if kind == .ble, let p = peripheral {
      central?.cancelPeripheralConnection(p)
    }
    if kind == .mfi, let session = eaSession {
      DispatchQueue.main.async {
        for stream in [session.inputStream as Stream?, session.outputStream as Stream?].compactMap({ $0 }) {
          stream.delegate = nil
          stream.close()
          stream.remove(from: RunLoop.main, forMode: .default)
        }
        self.eaOutput.removeAll()
        self.mainOutputStream = nil
      }
    }
    if connectPromise == nil { kind = .none }
    peripheral = nil
    notifyChar = nil
    writeChar = nil
    eaSession = nil
    eaAccessory = nil
    if notify && wasUp {
      emit("onLinkState", ["state": "disconnected", "reason": reason])
    }
  }

  // MARK: BLE connect

  private func connectBle(options: ConnectOptions) {
    whenStateKnown { state in
      guard let central = self.central else {
        self.failConnect(code: "bluetooth-off", message: "Bluetooth not initialized")
        return
      }
      if central.state == .unauthorized {
        self.failConnect(code: "bluetooth-unauthorized", message: "Bluetooth permission denied")
        return
      }
      guard central.state == .poweredOn else {
        self.failConnect(code: "bluetooth-off", message: "Bluetooth is \(state)")
        return
      }
      guard let uuid = UUID(uuidString: options.id) else {
        self.failConnect(code: "device-not-found", message: "invalid peripheral id")
        return
      }
      let target = self.known[uuid] ?? central.retrievePeripherals(withIdentifiers: [uuid]).first
      guard let p = target else {
        self.failConnect(code: "device-not-found", message: "peripheral not found")
        return
      }
      self.known[uuid] = p
      self.kind = .ble
      self.peripheral = p
      p.delegate = self
      central.connect(p, options: nil)
    }
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    guard peripheral == self.peripheral, connectPromise != nil else { return }
    gattDump = []
    peripheral.discoverServices(nil)
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    guard peripheral == self.peripheral else { return }
    failConnect(code: "connect-failed", message: error?.localizedDescription ?? "failed to connect")
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    guard peripheral == self.peripheral else { return }
    if connectPromise != nil {
      failConnect(code: "connect-failed", message: error?.localizedDescription ?? "disconnected during setup")
    } else {
      closeLink(reason: error?.localizedDescription ?? "peripheral disconnected", notify: true)
    }
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    guard peripheral == self.peripheral else { return }
    let services = peripheral.services ?? []
    if let error = error { failConnect(code: "connect-failed", message: error.localizedDescription); return }
    if services.isEmpty { selectUart(); return }
    servicesPending = services.count
    for service in services { peripheral.discoverCharacteristics(nil, for: service) }
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    guard peripheral == self.peripheral else { return }
    let chars = (service.characteristics ?? []).map { c -> [String: Any] in
      return ["uuid": c.uuid.uuidString, "properties": LinkCore.propertyNames(c.properties)]
    }
    gattDump.append(["uuid": service.uuid.uuidString, "characteristics": chars])
    servicesPending -= 1
    if servicesPending <= 0 { selectUart() }
  }

  static func propertyNames(_ p: CBCharacteristicProperties) -> [String] {
    var names: [String] = []
    if p.contains(.read) { names.append("read") }
    if p.contains(.write) { names.append("write") }
    if p.contains(.writeWithoutResponse) { names.append("writeWithoutResponse") }
    if p.contains(.notify) { names.append("notify") }
    if p.contains(.indicate) { names.append("indicate") }
    return names
  }

  /** UART selection lives in LinkLogic (unit-tested); this maps CoreBluetooth objects in and out. */
  private func selectUart() {
    guard let p = peripheral, let options = connectOptions else { return }
    let services = p.services ?? []
    let infos = services.map { service in
      ServiceInfo(
        uuid: service.uuid.uuidString,
        characteristics: (service.characteristics ?? []).map {
          CharacteristicInfo(uuid: $0.uuid.uuidString, properties: Set(LinkCore.propertyNames($0.properties)))
        })
    }
    let specs = options.profiles.map { ProfileSpec(id: $0.id, service: $0.service, notify: $0.notify, write: $0.write) }
    guard let sel = LinkLogic.selectUart(services: infos, profiles: specs, preferred: options.preferred),
          let chars = services[sel.service].characteristics else {
      let dump = (try? JSONSerialization.data(withJSONObject: gattDump)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
      failConnect(code: "no-uart-service", message: dump)
      return
    }
    let service = services[sel.service]
    let n = chars[sel.notify]
    let w = chars[sel.write]
    notifyChar = n
    writeChar = w
    gattDump.insert(["selected": ["profileId": sel.profileId, "service": service.uuid.uuidString, "notify": n.uuid.uuidString, "write": w.uuid.uuidString]], at: 0)
    p.setNotifyValue(true, for: n)
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
    guard peripheral == self.peripheral, characteristic == notifyChar, connectPromise != nil else { return }
    if let error = error {
      failConnect(code: "connect-failed", message: "subscribe failed: \(error.localizedDescription)")
      return
    }
    var selected: [String: Any] = [:]
    var dump = gattDump
    if let first = dump.first, let sel = first["selected"] as? [String: Any] {
      selected = sel
      dump.removeFirst()
    }
    succeedConnect([
      "gatt": selected,
      "gattDump": dump,
      "deviceInfo": ["name": peripheral.name ?? ""],
    ])
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    guard peripheral == self.peripheral, characteristic == notifyChar, let data = characteristic.value else { return }
    onBytes(data)
  }

  func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
    guard peripheral == self.peripheral else { return }
    bleAwaitingWriteAck = false
    pumpBle()
  }

  func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
    guard peripheral == self.peripheral else { return }
    pumpBle()
  }

  private func pumpBle() {
    guard let p = peripheral, let w = writeChar else { return }
    let withResponse = w.properties.contains(.write)
    while !bleChunks.isEmpty {
      if withResponse {
        if bleAwaitingWriteAck { return }
        bleAwaitingWriteAck = true
        p.writeValue(bleChunks.removeFirst(), for: w, type: .withResponse)
        return
      }
      if !p.canSendWriteWithoutResponse { return }
      p.writeValue(bleChunks.removeFirst(), for: w, type: .withoutResponse)
    }
  }

  // MARK: MFi connect

  private func connectMfi(options: ConnectOptions) {
    // id = "mfi:<serial>:<protocol>"
    guard let parsed = LinkLogic.parseMfiId(options.id) else {
      failConnect(code: "device-not-found", message: "invalid MFi accessory id")
      return
    }
    let serial = parsed.serial
    let proto = parsed.proto
    DispatchQueue.main.async {
      let accessory = EAAccessoryManager.shared().connectedAccessories.first { a in
        a.protocolStrings.contains(proto) && (serial.isEmpty || a.serialNumber == serial)
      }
      guard let accessory = accessory, let session = EASession(accessory: accessory, forProtocol: proto),
            let input = session.inputStream, let output = session.outputStream else {
        self.queue.async { self.failConnect(code: "device-not-found", message: "MFi accessory not connected") }
        return
      }
      self.mainOutputStream = output
      for stream in [input as Stream, output as Stream] {
        stream.delegate = self
        stream.schedule(in: RunLoop.main, forMode: .default)
        stream.open()
      }
      self.queue.async {
        self.kind = .mfi
        self.eaSession = session
        self.eaAccessory = accessory
        self.eaProtocol = proto
        self.succeedConnect([
          "protocol": proto,
          "deviceInfo": [
            "name": accessory.name,
            "manufacturer": accessory.manufacturer,
            "modelNumber": accessory.modelNumber,
            "serialNumber": accessory.serialNumber,
            "firmwareRevision": accessory.firmwareRevision,
            "hardwareRevision": accessory.hardwareRevision,
          ],
        ])
      }
    }
  }

  /** MFi stream events arrive on the main thread. */
  func stream(_ aStream: Stream, handle eventCode: Stream.Event) {
    switch eventCode {
    case .hasBytesAvailable:
      guard let input = aStream as? InputStream else { return }
      var buffer = [UInt8](repeating: 0, count: 1024)
      var data = Data()
      while input.hasBytesAvailable {
        let n = input.read(&buffer, maxLength: buffer.count)
        if n <= 0 { break }
        data.append(buffer, count: n)
      }
      if !data.isEmpty { queue.async { self.onBytes(data) } }
    case .hasSpaceAvailable:
      pumpMfiOnMain()
    case .errorOccurred, .endEncountered:
      queue.async { self.closeLink(reason: "accessory stream closed", notify: true) }
    default:
      break
    }
  }

  private func pumpMfiOnMain() {
    guard let output = mainOutputStream else { return }
    while !eaOutput.isEmpty && output.hasSpaceAvailable {
      let written = eaOutput.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Int in
        guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return 0 }
        return output.write(base, maxLength: raw.count)
      }
      if written <= 0 { return }
      eaOutput.removeFirst(written)
    }
  }

  // MARK: Transactions

  private func write(_ data: Data) {
    switch kind {
    case .ble:
      guard let p = peripheral, writeChar != nil else { return }
      // Real ATT MTU for both write types; the .withResponse value is a bogus 512 (see LinkLogic).
      let limit = LinkLogic.bleChunkLimit(
        withResponseMax: p.maximumWriteValueLength(for: .withResponse),
        withoutResponseMax: p.maximumWriteValueLength(for: .withoutResponse))
      bleChunks.append(contentsOf: LinkLogic.chunk(data, size: limit))
      pumpBle()
    case .mfi:
      DispatchQueue.main.async {
        self.eaOutput.append(data)
        self.pumpMfiOnMain()
      }
    case .none:
      break
    }
  }

  func transact(command: String, timeoutMs: Double, promise: Promise) {
    queue.async {
      guard self.linkUp else { promise.reject("not-connected", "no adapter link"); return }
      guard self.pending == nil else { promise.reject("busy", "a command is already in flight"); return }
      self.framer.reset()
      self.pendingSeq += 1
      let id = self.pendingSeq
      let txUs = LinkCore.nowUs()
      self.pending = Pending(id: id, promise: promise, txUs: txUs, rxFirstUs: nil)
      self.queue.asyncAfter(deadline: .now() + Swift.max(0.05, timeoutMs / 1000)) {
        guard let p = self.pending, p.id == id else { return }
        self.pending = nil
        let raw = self.framer.text
        self.framer.reset()
        var result: [String: Any] = ["raw": raw, "status": "timeout", "txUs": p.txUs, "rxUs": LinkCore.nowUs()]
        if let first = p.rxFirstUs { result["rxFirstUs"] = first }
        p.promise.resolve(result)
      }
      self.write(Data((command + "\r").utf8))
    }
  }

  func writeRaw(text: String, promise: Promise) {
    queue.async {
      guard self.linkUp else { promise.reject("not-connected", "no adapter link"); return }
      self.write(Data(text.utf8))
      promise.resolve(nil)
    }
  }

  /** Runs on `queue`. */
  private func onBytes(_ data: Data) {
    let now = LinkCore.nowUs()
    let clean = PromptFramer.clean(data)
    if clean.isEmpty { return }
    guard var p = pending else {
      emit("onUnsolicited", ["text": String(decoding: clean, as: UTF8.self), "rxUs": now])
      return
    }
    if p.rxFirstUs == nil {
      p.rxFirstUs = now
      pending = p
    }
    if let raw = framer.append(clean) {
      pending = nil
      var result: [String: Any] = ["raw": raw, "status": "ok", "txUs": p.txUs, "rxUs": now]
      if let first = p.rxFirstUs { result["rxFirstUs"] = first }
      p.promise.resolve(result)
    }
  }
}
