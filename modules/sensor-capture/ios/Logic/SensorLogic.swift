import Foundation

// Pure mapping/batching logic for SensorCaptureModule (docs/TRIP-LOGGER-SPEC.md §5).
// Foundation only, unit-tested with SwiftPM on Linux (Package.swift at the repo root).

/** CLLocation fields as plain values (negative accuracy/speed/course = invalid, per CoreLocation). */
struct LocationSample {
  var latitude: Double
  var longitude: Double
  var altitude: Double
  var ellipsoidalAltitude: Double
  var horizontalAccuracy: Double
  var verticalAccuracy: Double
  var speed: Double
  var speedAccuracy: Double
  /** Degrees. */
  var course: Double
  /** Degrees. */
  var courseAccuracy: Double
  /** Fix time, seconds since 1970. */
  var timestamp: Double
  var simulated: Bool
  var fromAccessory: Bool
}

enum SensorLogic {
  static let standardGravity = 9.80665

  /**
   * onGnss event payload. The fix's wall-clock time is mapped onto the monotonic uptime clock
   * using "now" on both clocks; invalid fields are omitted (JS turns them into NaN).
   */
  static func gnssEvent(_ s: LocationSample, nowUptimeUs: Double, nowWallSeconds: Double) -> [String: Any] {
    let ageUs = (nowWallSeconds - s.timestamp) * 1_000_000
    var e: [String: Any] = [
      "tUs": nowUptimeUs - ageUs,
      "utcUs": s.timestamp * 1_000_000,
      "deliveryDelayUs": Swift.max(0, ageUs),
      "lat": s.latitude,
      "lon": s.longitude,
      "simulated": s.simulated,
      "fromAccessory": s.fromAccessory,
    ]
    if s.horizontalAccuracy >= 0 { e["hAcc"] = s.horizontalAccuracy }
    if s.verticalAccuracy >= 0 {
      e["vAcc"] = s.verticalAccuracy
      e["altMsl"] = s.altitude
      e["altEllipsoid"] = s.ellipsoidalAltitude
    }
    if s.speed >= 0 { e["speed"] = s.speed }
    if s.speedAccuracy >= 0 { e["speedAcc"] = s.speedAccuracy }
    if s.course >= 0 { e["courseRad"] = s.course * Double.pi / 180 }
    if s.courseAccuracy >= 0 { e["courseAccRad"] = s.courseAccuracy * Double.pi / 180 }
    return e
  }

  /**
   * One `motion` row (14 values): t µs, rotation rate rad/s, user acceleration and gravity
   * converted from g to m/s², attitude quaternion w x y z.
   */
  static func motionRow(
    timestamp: Double,
    rotation: (Double, Double, Double),
    userAccelG: (Double, Double, Double),
    gravityG: (Double, Double, Double),
    quaternion: (w: Double, x: Double, y: Double, z: Double)
  ) -> [Double] {
    let g = standardGravity
    return [
      timestamp * 1_000_000,
      rotation.0, rotation.1, rotation.2,
      userAccelG.0 * g, userAccelG.1 * g, userAccelG.2 * g,
      gravityG.0 * g, gravityG.1 * g, gravityG.2 * g,
      quaternion.w, quaternion.x, quaternion.y, quaternion.z,
    ]
  }

  /** Raw gyro row (4 values): t µs, x, y, z rad/s. */
  static func gyroRow(timestamp: Double, x: Double, y: Double, z: Double) -> [Double] {
    return [timestamp * 1_000_000, x, y, z]
  }

  /** Raw accelerometer row (4 values): t µs, x, y, z converted from g to m/s². */
  static func accelRow(timestamp: Double, xG: Double, yG: Double, zG: Double) -> [Double] {
    let g = standardGravity
    return [timestamp * 1_000_000, xG * g, yG * g, zG * g]
  }

  /** Raw magnetometer row (4 values): t µs, x, y, z µT (uncalibrated: includes the phone's own field). */
  static func magRow(timestamp: Double, x: Double, y: Double, z: Double) -> [Double] {
    return [timestamp * 1_000_000, x, y, z]
  }

  static func clampRateHz(_ hz: Double) -> Double {
    return Swift.max(1, Swift.min(200, hz))
  }
}

/** Collects flat IMU rows per stream ("m", "g", "a", "f" magnetic field) and emits a batch every `intervalUs`. */
struct ImuBatcher {
  static let streams = ["m", "g", "a", "f"]

  var intervalUs: Double
  private(set) var rows: [String: [Double]] = ["m": [], "g": [], "a": [], "f": []]
  private(set) var startUs: Double

  init(intervalMs: Double, nowUs: Double) {
    self.intervalUs = Swift.max(20, intervalMs) * 1000
    self.startUs = nowUs
  }

  /** Append a row; returns a batch when the interval has elapsed. */
  mutating func append(_ stream: String, _ row: [Double], nowUs: Double) -> [String: [Double]]? {
    rows[stream, default: []].append(contentsOf: row)
    return nowUs - startUs >= intervalUs ? flush(nowUs: nowUs) : nil
  }

  /** Returns the pending rows (nil if empty) and starts a new batch. */
  mutating func flush(nowUs: Double) -> [String: [Double]]? {
    let out = rows
    rows = ["m": [], "g": [], "a": [], "f": []]
    startUs = nowUs
    if ImuBatcher.streams.allSatisfy({ (out[$0] ?? []).isEmpty }) { return nil }
    return out
  }

  /** Event payload keys used by JS (`motion`, `gyro`, `accel`, `mag`). */
  static func payload(_ batch: [String: [Double]]) -> [String: Any] {
    return ["motion": batch["m"] ?? [], "gyro": batch["g"] ?? [], "accel": batch["a"] ?? [], "mag": batch["f"] ?? []]
  }
}
