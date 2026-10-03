import Foundation

// Pure transport logic for VehicleLinkModule (docs/VEHICLE-LINK-SPEC.md §5.3, §8.2).
// Foundation only — no CoreBluetooth/ExpoModulesCore — so it is unit-tested with SwiftPM on
// Linux (Package.swift at the repo root, tests in native-tests/).

struct CharacteristicInfo: Equatable {
  var uuid: String
  /** "read", "write", "writeWithoutResponse", "notify", "indicate" */
  var properties: Set<String>

  var canNotify: Bool { properties.contains("notify") || properties.contains("indicate") }
  var canWrite: Bool { properties.contains("write") || properties.contains("writeWithoutResponse") }
}

struct ServiceInfo: Equatable {
  var uuid: String
  var characteristics: [CharacteristicInfo]
}

struct ProfileSpec: Equatable {
  var id: String
  var service: String
  var notify: String?
  var write: String?
}

/** Indices into the service list / characteristic lists passed to `selectUart`. */
struct UartSelection: Equatable {
  var profileId: String
  var service: Int
  var notify: Int
  var write: Int
}

enum LinkLogic {
  static let bluetoothBaseSuffix = "-0000-1000-8000-00805F9B34FB"
  static let ignoredServices: Set<String> = ["1800", "1801", "180A", "180F", "FEF5"]

  /** Upper case; SIG base UUIDs ("0000FFF0-0000-1000-8000-00805F9B34FB") → short form ("FFF0"). */
  static func normalizeUUID(_ uuid: String) -> String {
    let u = uuid.trimmingCharacters(in: .whitespaces).uppercased()
    if u.count == 36, u.hasPrefix("0000"), u.hasSuffix(bluetoothBaseSuffix) {
      let start = u.index(u.startIndex, offsetBy: 4)
      let end = u.index(u.startIndex, offsetBy: 8)
      return String(u[start..<end])
    }
    return u
  }

  /** 16/32-bit hex or a full UUID — the only strings CBUUID(string:) accepts without raising. */
  static func isValidUUIDString(_ s: String) -> Bool {
    let t = s.trimmingCharacters(in: .whitespaces)
    let hex = CharacterSet(charactersIn: "0123456789abcdefABCDEF")
    if (t.count == 4 || t.count == 8) && t.unicodeScalars.allSatisfy({ hex.contains($0) }) { return true }
    return UUID(uuidString: t) != nil
  }

  /** Bluetooth SIG GATT services live in 0x1800–0x18FF (18F0 is Vgate's, not SIG). */
  static func isSigService(_ uuid: String) -> Bool {
    let u = normalizeUUID(uuid)
    return u.count == 4 && u.hasPrefix("18") && u != "18F0"
  }

  /**
   * Pick the UART (VEHICLE-LINK-SPEC §8.2): remembered pair, then catalog profiles in order,
   * then a non-SIG service with exactly one notify and one write characteristic.
   */
  static func selectUart(services: [ServiceInfo], profiles: [ProfileSpec], preferred: [String]?) -> UartSelection? {
    func find(_ chars: [CharacteristicInfo], _ uuid: String?, _ fallback: (CharacteristicInfo) -> Bool) -> Int? {
      if let uuid = uuid {
        let target = normalizeUUID(uuid)
        return chars.firstIndex { normalizeUUID($0.uuid) == target }
      }
      return chars.firstIndex(where: fallback)
    }

    func pick(_ serviceUuid: String, _ notify: String?, _ write: String?, _ id: String) -> UartSelection? {
      let target = normalizeUUID(serviceUuid)
      guard let s = services.firstIndex(where: { normalizeUUID($0.uuid) == target }) else { return nil }
      let chars = services[s].characteristics
      guard let n = find(chars, notify, { $0.canNotify }), let w = find(chars, write, { $0.canWrite }) else { return nil }
      guard chars[n].canNotify && chars[w].canWrite else { return nil }
      return UartSelection(profileId: id, service: s, notify: n, write: w)
    }

    if let pref = preferred, pref.count == 3, let hit = pick(pref[0], pref[1], pref[2], "remembered") {
      return hit
    }
    for profile in profiles {
      if let hit = pick(profile.service, profile.notify, profile.write, profile.id) { return hit }
    }
    for (s, service) in services.enumerated() {
      let id = normalizeUUID(service.uuid)
      if ignoredServices.contains(id) || isSigService(id) { continue }
      let notifies = service.characteristics.indices.filter { service.characteristics[$0].canNotify }
      let writes = service.characteristics.indices.filter { service.characteristics[$0].canWrite }
      if notifies.count == 1 && writes.count == 1 {
        return UartSelection(profileId: "heuristic", service: s, notify: notifies[0], write: writes[0])
      }
    }
    return nil
  }

  /**
   * Largest single-PDU write. iOS reports the real ATT MTU only for `.withoutResponse`; for
   * `.withResponse` it always claims 512, which needs queued (long) writes — unsupported by e.g.
   * the OBDLink CX, which then silently drops bytes (noted in CornucopiaStreams). So the
   * without-response limit is used for both write types and the with-response value is ignored.
   */
  static func bleChunkLimit(withResponseMax: Int, withoutResponseMax: Int) -> Int {
    _ = withResponseMax
    return Swift.max(20, withoutResponseMax)
  }

  /** Split a write into BLE-sized chunks (never smaller than the 20-byte ATT minimum). */
  static func chunk(_ data: Data, size: Int) -> [Data] {
    let n = Swift.max(20, size)
    var out: [Data] = []
    var offset = 0
    while offset < data.count {
      let end = Swift.min(offset + n, data.count)
      out.append(data.subdata(in: offset..<end))
      offset = end
    }
    return out
  }

  /** "mfi:<serial>:<protocol>" → (serial, protocol). Serial may be empty; protocol may not. */
  static func parseMfiId(_ id: String) -> (serial: String, proto: String)? {
    let parts = id.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false).map(String.init)
    guard parts.count == 3, parts[0] == "mfi", !parts[2].isEmpty else { return nil }
    return (parts[1], parts[2])
  }
}

/** Accumulates adapter bytes until the ELM `>` prompt (VEHICLE-LINK-SPEC §5.3). */
struct PromptFramer {
  private(set) var buffer = Data()

  var text: String { String(decoding: buffer, as: UTF8.self) }
  var isEmpty: Bool { buffer.isEmpty }

  mutating func reset() {
    buffer.removeAll()
  }

  /** Clone adapters may send NULs; drop them. */
  static func clean(_ data: Data) -> Data {
    return data.filter { $0 != 0 }
  }

  /** Appends cleaned bytes; returns the full response text once `>` has arrived (and resets). */
  mutating func append(_ data: Data) -> String? {
    buffer.append(PromptFramer.clean(data))
    guard buffer.contains(0x3E) else { return nil }
    let raw = text
    buffer.removeAll()
    return raw
  }
}
