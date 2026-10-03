import Foundation
import XCTest

@testable import SensorCaptureLogic

private func sample(
  hAcc: Double = 4.5, vAcc: Double = 6, speed: Double = 13.9, speedAcc: Double = 0.5,
  course: Double = 90, courseAcc: Double = 5, timestamp: Double = 1_791_000_000
) -> LocationSample {
  LocationSample(
    latitude: 50.45, longitude: 30.52, altitude: 180, ellipsoidalAltitude: 210,
    horizontalAccuracy: hAcc, verticalAccuracy: vAcc, speed: speed, speedAccuracy: speedAcc,
    course: course, courseAccuracy: courseAcc, timestamp: timestamp, simulated: false, fromAccessory: true)
}

final class GnssEventTests: XCTestCase {
  func testMapsValidFixAndConvertsUnits() {
    // Fix 0.25 s old at delivery; uptime now = 5000 s.
    let e = SensorLogic.gnssEvent(sample(), nowUptimeUs: 5_000_000_000, nowWallSeconds: 1_791_000_000.25)
    XCTAssertEqual(e["tUs"] as? Double ?? 0, 4_999_750_000, accuracy: 1)
    XCTAssertEqual(e["utcUs"] as? Double ?? 0, 1_791_000_000_000_000, accuracy: 1)
    XCTAssertEqual(e["deliveryDelayUs"] as? Double ?? 0, 250_000, accuracy: 1)
    XCTAssertEqual(e["lat"] as? Double, 50.45)
    XCTAssertEqual(e["hAcc"] as? Double, 4.5)
    XCTAssertEqual(e["altMsl"] as? Double, 180)
    XCTAssertEqual(e["altEllipsoid"] as? Double, 210)
    XCTAssertEqual(e["speed"] as? Double, 13.9)
    XCTAssertEqual(e["courseRad"] as? Double ?? 0, Double.pi / 2, accuracy: 1e-12)
    XCTAssertEqual(e["courseAccRad"] as? Double ?? 0, 5 * Double.pi / 180, accuracy: 1e-12)
    XCTAssertEqual(e["fromAccessory"] as? Bool, true)
    XCTAssertEqual(e["simulated"] as? Bool, false)
  }

  func testOmitsInvalidFields() {
    let e = SensorLogic.gnssEvent(
      sample(hAcc: -1, vAcc: -1, speed: -1, speedAcc: -1, course: -1, courseAcc: -1),
      nowUptimeUs: 1_000_000, nowWallSeconds: 1_791_000_000)
    for key in ["hAcc", "vAcc", "altMsl", "altEllipsoid", "speed", "speedAcc", "courseRad", "courseAccRad"] {
      XCTAssertNil(e[key], key)
    }
    XCTAssertNotNil(e["lat"])
  }

  func testFutureTimestampGivesZeroDelay() {
    let e = SensorLogic.gnssEvent(sample(timestamp: 101), nowUptimeUs: 1_000_000, nowWallSeconds: 100)
    XCTAssertEqual(e["deliveryDelayUs"] as? Double, 0)
  }
}

final class RowTests: XCTestCase {
  func testMotionRowLayoutAndGravityConversion() {
    let row = SensorLogic.motionRow(
      timestamp: 12.5, rotation: (0.1, 0.2, 0.3), userAccelG: (1, 0, 0), gravityG: (0, 0, -1),
      quaternion: (w: 1, x: 0, y: 0, z: 0))
    XCTAssertEqual(row.count, 14)
    XCTAssertEqual(row[0], 12_500_000)
    XCTAssertEqual(Array(row[1...3]), [0.1, 0.2, 0.3])
    XCTAssertEqual(row[4], 9.80665, accuracy: 1e-12)
    XCTAssertEqual(row[9], -9.80665, accuracy: 1e-12)
    XCTAssertEqual(Array(row[10...13]), [1, 0, 0, 0])
  }

  func testRawRows() {
    XCTAssertEqual(SensorLogic.gyroRow(timestamp: 1, x: 1, y: 2, z: 3), [1_000_000, 1, 2, 3])
    let a = SensorLogic.accelRow(timestamp: 2, xG: 0, yG: 0, zG: 1)
    XCTAssertEqual(a.count, 4)
    XCTAssertEqual(a[3], 9.80665, accuracy: 1e-12)
  }

  func testRateClamp() {
    XCTAssertEqual(SensorLogic.clampRateHz(0), 1)
    XCTAssertEqual(SensorLogic.clampRateHz(100), 100)
    XCTAssertEqual(SensorLogic.clampRateHz(1000), 200)
  }
}

final class ImuBatcherTests: XCTestCase {
  func testEmitsBatchAfterInterval() {
    var b = ImuBatcher(intervalMs: 100, nowUs: 0)
    XCTAssertNil(b.append("m", [1, 2], nowUs: 50_000))
    XCTAssertNil(b.append("g", [3], nowUs: 90_000))
    let batch = b.append("m", [4], nowUs: 100_000)
    XCTAssertEqual(batch?["m"], [1, 2, 4])
    XCTAssertEqual(batch?["g"], [3])
    XCTAssertEqual(batch?["a"], [])
    XCTAssertEqual(b.startUs, 100_000)
    XCTAssertTrue(b.rows.values.allSatisfy { $0.isEmpty })
  }

  func testFlushEmptyReturnsNil() {
    var b = ImuBatcher(intervalMs: 100, nowUs: 0)
    XCTAssertNil(b.flush(nowUs: 10))
    _ = b.append("a", [1, 2, 3, 4], nowUs: 20)
    XCTAssertEqual(b.flush(nowUs: 30)?["a"], [1, 2, 3, 4])
  }

  func testMinimumInterval() {
    XCTAssertEqual(ImuBatcher(intervalMs: 5, nowUs: 0).intervalUs, 20_000)
  }

  func testPayloadKeysMatchJs() {
    let p = ImuBatcher.payload(["m": [1], "g": [2], "a": [3]])
    XCTAssertEqual(p["motion"] as? [Double], [1])
    XCTAssertEqual(p["gyro"] as? [Double], [2])
    XCTAssertEqual(p["accel"] as? [Double], [3])
  }
}
