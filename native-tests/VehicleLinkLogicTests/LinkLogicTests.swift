import Foundation
import XCTest

@testable import VehicleLinkLogic

// Mirrors the TS catalog (src/obd/catalog.ts GATT_PROFILES) that JS passes to native.
private let profiles: [ProfileSpec] = [
  ProfileSpec(id: "fff0", service: "FFF0", notify: "FFF1", write: "FFF2"),
  ProfileSpec(id: "ffe0", service: "FFE0", notify: "FFE1", write: "FFE1"),
  ProfileSpec(id: "vgate", service: "18F0", notify: "2AF0", write: "2AF1"),
  ProfileSpec(
    id: "e781", service: "E7810A71-73AE-499D-8C15-FAA9AEF0C3F2",
    notify: "BEF8D6C9-9C21-4C9E-B632-BD58C1009F9F", write: "BEF8D6C9-9C21-4C9E-B632-BD58C1009F9F"),
  ProfileSpec(id: "issc", service: "49535343-FE7D-4AE5-8FA9-9FAFD205E455", notify: nil, write: nil),
  ProfileSpec(
    id: "nus", service: "6E400001-B5A3-F393-E0A9-E50E24DCCA9E",
    notify: "6E400003-B5A3-F393-E0A9-E50E24DCCA9E", write: "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"),
]

private func char(_ uuid: String, _ props: String...) -> CharacteristicInfo {
  CharacteristicInfo(uuid: uuid, properties: Set(props))
}

private let deviceInfo = ServiceInfo(uuid: "180A", characteristics: [char("2A29", "read")])

final class UuidTests: XCTestCase {
  func testNormalizesBaseUuidsToShortForm() {
    XCTAssertEqual(LinkLogic.normalizeUUID("0000fff1-0000-1000-8000-00805f9b34fb"), "FFF1")
    XCTAssertEqual(LinkLogic.normalizeUUID(" fff0 "), "FFF0")
    XCTAssertEqual(
      LinkLogic.normalizeUUID("e7810a71-73ae-499d-8c15-faa9aef0c3f2"), "E7810A71-73AE-499D-8C15-FAA9AEF0C3F2")
  }

  func testValidUuidStrings() {
    XCTAssertTrue(LinkLogic.isValidUUIDString("FFF0"))
    XCTAssertTrue(LinkLogic.isValidUUIDString("0000fff0"))
    XCTAssertTrue(LinkLogic.isValidUUIDString("6E400001-B5A3-F393-E0A9-E50E24DCCA9E"))
    XCTAssertFalse(LinkLogic.isValidUUIDString("FFF"))
    XCTAssertFalse(LinkLogic.isValidUUIDString("XYZ0"))
    XCTAssertFalse(LinkLogic.isValidUUIDString(""))
    XCTAssertFalse(LinkLogic.isValidUUIDString("6E400001-B5A3-F393-E0A9"))
  }

  func testSigServices() {
    XCTAssertTrue(LinkLogic.isSigService("1812"))
    XCTAssertTrue(LinkLogic.isSigService("0000180A-0000-1000-8000-00805F9B34FB"))
    XCTAssertFalse(LinkLogic.isSigService("18F0"))
    XCTAssertFalse(LinkLogic.isSigService("FFF0"))
  }
}

final class UartSelectionTests: XCTestCase {
  func testOBDLinkCXLayout() {
    let services = [
      deviceInfo,
      ServiceInfo(uuid: "FFF0", characteristics: [char("FFF1", "notify"), char("FFF2", "write", "writeWithoutResponse")]),
      ServiceInfo(uuid: "FEF5", characteristics: [char("8082CAA8-41A6-4021-91C6-56F9B954CC34", "read", "write")]),
    ]
    XCTAssertEqual(
      LinkLogic.selectUart(services: services, profiles: profiles, preferred: nil),
      UartSelection(profileId: "fff0", service: 1, notify: 0, write: 1))
  }

  func testHM10SingleCharacteristic() {
    let services = [ServiceInfo(uuid: "FFE0", characteristics: [char("FFE1", "notify", "writeWithoutResponse", "read")])]
    XCTAssertEqual(
      LinkLogic.selectUart(services: services, profiles: profiles, preferred: nil),
      UartSelection(profileId: "ffe0", service: 0, notify: 0, write: 0))
  }

  func testLongFormUuidsFromCoreBluetoothMatchShortProfiles() {
    let services = [
      ServiceInfo(
        uuid: "000018F0-0000-1000-8000-00805F9B34FB",
        characteristics: [
          char("00002AF1-0000-1000-8000-00805F9B34FB", "write"),
          char("00002AF0-0000-1000-8000-00805F9B34FB", "notify"),
        ])
    ]
    XCTAssertEqual(
      LinkLogic.selectUart(services: services, profiles: profiles, preferred: nil),
      UartSelection(profileId: "vgate", service: 0, notify: 1, write: 0))
  }

  func testISSCPicksByProperties() {
    let services = [
      ServiceInfo(
        uuid: "49535343-FE7D-4AE5-8FA9-9FAFD205E455",
        characteristics: [
          char("49535343-6DAA-4D02-ABF6-19569ACA69FE", "read"),
          char("49535343-1E4D-4BD9-BA61-23C647249616", "notify"),
          char("49535343-8841-43F4-A8D4-ECBE34729BB3", "writeWithoutResponse"),
        ])
    ]
    XCTAssertEqual(
      LinkLogic.selectUart(services: services, profiles: profiles, preferred: nil),
      UartSelection(profileId: "issc", service: 0, notify: 1, write: 2))
  }

  func testCatalogOrderWinsWhenSeveralProfilesExist() {
    let services = [
      ServiceInfo(
        uuid: "49535343-FE7D-4AE5-8FA9-9FAFD205E455",
        characteristics: [char("A1", "notify"), char("A2", "write")]),
      ServiceInfo(uuid: "FFF0", characteristics: [char("FFF1", "notify"), char("FFF2", "write")]),
    ]
    XCTAssertEqual(LinkLogic.selectUart(services: services, profiles: profiles, preferred: nil)?.profileId, "fff0")
  }

  func testRememberedPairWins() {
    let services = [
      ServiceInfo(uuid: "FFF0", characteristics: [char("FFF1", "notify"), char("FFF2", "write")]),
      ServiceInfo(uuid: "ABCD", characteristics: [char("AB01", "indicate"), char("AB02", "write")]),
    ]
    XCTAssertEqual(
      LinkLogic.selectUart(services: services, profiles: profiles, preferred: ["ABCD", "AB01", "AB02"]),
      UartSelection(profileId: "remembered", service: 1, notify: 0, write: 1))
  }

  func testStaleRememberedPairFallsBackToCatalog() {
    let services = [ServiceInfo(uuid: "FFF0", characteristics: [char("FFF1", "notify"), char("FFF2", "write")])]
    XCTAssertEqual(
      LinkLogic.selectUart(services: services, profiles: profiles, preferred: ["ABCD", "AB01", "AB02"])?.profileId,
      "fff0")
  }

  func testHeuristicForUnknownVendorServiceSkipsSigAndAmbiguous() {
    let services = [
      ServiceInfo(uuid: "1812", characteristics: [char("2A4D", "notify", "write")]),
      ServiceInfo(
        uuid: "12345678-0000-0000-0000-000000000002",
        characteristics: [char("B1", "notify"), char("B2", "notify"), char("B3", "write")]),
      ServiceInfo(
        uuid: "12345678-0000-0000-0000-000000000001",
        characteristics: [char("A1", "notify"), char("A2", "read"), char("A3", "write")]),
    ]
    XCTAssertEqual(
      LinkLogic.selectUart(services: services, profiles: profiles, preferred: nil),
      UartSelection(profileId: "heuristic", service: 2, notify: 0, write: 2))
  }

  func testProfileWithWrongPropertiesIsRejected() {
    // FFF1 doesn't notify → the fff0 profile can't be used; no other candidate.
    let services = [ServiceInfo(uuid: "FFF0", characteristics: [char("FFF1", "read"), char("FFF2", "write")])]
    XCTAssertNil(LinkLogic.selectUart(services: services, profiles: profiles, preferred: nil))
  }

  func testNoUartOnHeadphones() {
    let services = [
      deviceInfo,
      ServiceInfo(uuid: "180F", characteristics: [char("2A19", "read", "notify")]),
      ServiceInfo(uuid: "1800", characteristics: [char("2A00", "read")]),
    ]
    XCTAssertNil(LinkLogic.selectUart(services: services, profiles: profiles, preferred: nil))
  }
}

final class ChunkAndIdTests: XCTestCase {
  func testChunksRespectMtuButNeverBelow20() {
    let data = Data(repeating: 0x41, count: 45)
    XCTAssertEqual(LinkLogic.chunk(data, size: 20).map(\.count), [20, 20, 5])
    XCTAssertEqual(LinkLogic.chunk(data, size: 182).map(\.count), [45])
    XCTAssertEqual(LinkLogic.chunk(data, size: 0).map(\.count), [20, 20, 5])
    XCTAssertEqual(LinkLogic.chunk(Data(), size: 20), [])
    XCTAssertEqual(LinkLogic.chunk(data, size: 20).reduce(Data(), +), data)
  }

  func testChunkLimitIgnoresBogusWithResponseMtu() {
    // iOS claims 512 for .withResponse regardless of the link; OBDLink CX can't do queued writes.
    XCTAssertEqual(LinkLogic.bleChunkLimit(withResponseMax: 512, withoutResponseMax: 182), 182)
    XCTAssertEqual(LinkLogic.bleChunkLimit(withResponseMax: 512, withoutResponseMax: 0), 20)
    let command = Data(repeating: 0x41, count: 300)
    XCTAssertEqual(
      LinkLogic.chunk(command, size: LinkLogic.bleChunkLimit(withResponseMax: 512, withoutResponseMax: 182)).map(\.count),
      [182, 118])
  }

  func testParseMfiId() {
    XCTAssertEqual(LinkLogic.parseMfiId("mfi:ABC123:com.obdlink")?.serial, "ABC123")
    XCTAssertEqual(LinkLogic.parseMfiId("mfi:ABC123:com.obdlink")?.proto, "com.obdlink")
    XCTAssertEqual(LinkLogic.parseMfiId("mfi::com.vgatemall")?.serial, "")
    XCTAssertNil(LinkLogic.parseMfiId("mfi:ABC:"))
    XCTAssertNil(LinkLogic.parseMfiId("6E400001-B5A3-F393-E0A9-E50E24DCCA9E"))
    XCTAssertNil(LinkLogic.parseMfiId("ble:x:y"))
  }
}

final class PromptFramerTests: XCTestCase {
  func testCompletesOnPromptAcrossChunks() {
    var f = PromptFramer()
    XCTAssertNil(f.append(Data("41 0D".utf8)))
    XCTAssertNil(f.append(Data(" 3C\r".utf8)))
    XCTAssertEqual(f.append(Data("\r>".utf8)), "41 0D 3C\r\r>")
    XCTAssertTrue(f.isEmpty)
  }

  func testDropsNulBytesFromClones() {
    var f = PromptFramer()
    XCTAssertEqual(f.append(Data([0x00, 0x4F, 0x4B, 0x00, 0x0D, 0x3E])), "OK\r>")
  }

  func testTextShowsPartialResponseForTimeouts() {
    var f = PromptFramer()
    _ = f.append(Data("SEARCHING...\r".utf8))
    XCTAssertEqual(f.text, "SEARCHING...\r")
    f.reset()
    XCTAssertTrue(f.isEmpty)
  }

  func testInvalidUtf8DoesNotCrash() {
    var f = PromptFramer()
    XCTAssertNotNil(f.append(Data([0xFF, 0xFE, 0x3E])))
  }
}
