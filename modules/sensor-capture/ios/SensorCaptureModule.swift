import CoreLocation
import CoreMotion
import ExpoModulesCore

// GNSS + IMU capture for the trip logger (docs/TRIP-LOGGER-SPEC.md §5).
// Timestamps: monotonic uptime µs, the same clock as CoreMotion and modules/vehicle-link.

struct ImuOptions: Record {
  @Field var rateHz: Double = 100
  @Field var raw: Bool = false
  @Field var batchMs: Double = 100
}

public class SensorCaptureModule: Module {
  private var capture: SensorCapture?

  public func definition() -> ModuleDefinition {
    Name("SensorCapture")

    Events("onGnss", "onGnssError", "onImuBatch", "onAuthorization")

    OnCreate {
      let emit: SensorCapture.Emit = { [weak self] name, body in
        self?.sendEvent(name, body.mapValues { Optional($0) })
      }
      DispatchQueue.main.async {
        self.capture = SensorCapture(emit: emit)
      }
    }

    OnDestroy {
      let capture = self.capture
      DispatchQueue.main.async {
        capture?.stopGnss()
        capture?.stopImu()
      }
    }

    Function("nowUs") { () -> Double in
      return SensorCapture.nowUs()
    }

    AsyncFunction("getPermissions") { () -> [String: Any] in
      return self.capture?.permissions() ?? ["location": "notDetermined", "accuracy": "full"]
    }.runOnQueue(.main)

    AsyncFunction("requestLocationPermission") { (promise: Promise) in
      guard let capture = self.capture else {
        promise.reject("not-ready", "sensor capture not initialized")
        return
      }
      capture.requestWhenInUse { promise.resolve($0) }
    }.runOnQueue(.main)

    AsyncFunction("startGnss") { () -> Bool in
      return self.capture?.startGnss() ?? false
    }.runOnQueue(.main)

    AsyncFunction("stopGnss") { () -> Void in
      self.capture?.stopGnss()
    }.runOnQueue(.main)

    AsyncFunction("startImu") { (options: ImuOptions) -> Bool in
      return self.capture?.startImu(options: options) ?? false
    }.runOnQueue(.main)

    AsyncFunction("stopImu") { () -> Void in
      self.capture?.stopImu()
    }.runOnQueue(.main)
  }
}

final class SensorCapture: NSObject, CLLocationManagerDelegate {
  typealias Emit = (String, [String: Any]) -> Void

  static func nowUs() -> Double {
    return ProcessInfo.processInfo.systemUptime * 1_000_000
  }

  private let emit: Emit
  private let location = CLLocationManager()
  private let motion = CMMotionManager()
  private let motionQueue: OperationQueue = {
    let q = OperationQueue()
    q.maxConcurrentOperationCount = 1
    q.name = "ai.wtf.sensorcapture.motion"
    return q
  }()
  private var permissionWaiters: [(String) -> Void] = []
  private var gnssRunning = false

  // IMU batching (SensorLogic.swift); only touched on motionQueue.
  private var batcher = ImuBatcher(intervalMs: 100, nowUs: 0)
  private var imuRunning = false

  init(emit: @escaping Emit) {
    self.emit = emit
    super.init()
    location.delegate = self
    location.desiredAccuracy = kCLLocationAccuracyBestForNavigation
    location.distanceFilter = kCLDistanceFilterNone
    location.activityType = .automotiveNavigation
    location.pausesLocationUpdatesAutomatically = false
  }

  // MARK: Permissions

  private static func statusString(_ s: CLAuthorizationStatus) -> String {
    switch s {
    case .authorizedAlways: return "always"
    case .authorizedWhenInUse: return "whenInUse"
    case .denied: return "denied"
    case .restricted: return "restricted"
    default: return "notDetermined"
    }
  }

  func permissions() -> [String: Any] {
    return [
      "location": SensorCapture.statusString(location.authorizationStatus),
      "accuracy": location.accuracyAuthorization == .fullAccuracy ? "full" : "reduced",
    ]
  }

  func requestWhenInUse(_ done: @escaping (String) -> Void) {
    if location.authorizationStatus != .notDetermined {
      done(SensorCapture.statusString(location.authorizationStatus))
      return
    }
    permissionWaiters.append(done)
    location.requestWhenInUseAuthorization()
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    let status = SensorCapture.statusString(manager.authorizationStatus)
    emit("onAuthorization", permissions())
    if manager.authorizationStatus != .notDetermined {
      let waiters = permissionWaiters
      permissionWaiters = []
      waiters.forEach { $0(status) }
    }
  }

  // MARK: GNSS

  private static var hasLocationBackgroundMode: Bool {
    let modes = Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String] ?? []
    return modes.contains("location")
  }

  func startGnss() -> Bool {
    let status = location.authorizationStatus
    guard status == .authorizedWhenInUse || status == .authorizedAlways else { return false }
    // Setting this without the `location` background mode crashes, so check the plist first.
    if SensorCapture.hasLocationBackgroundMode {
      location.allowsBackgroundLocationUpdates = true
      location.showsBackgroundLocationIndicator = true
    }
    location.startUpdatingLocation()
    gnssRunning = true
    return true
  }

  func stopGnss() {
    guard gnssRunning else { return }
    location.stopUpdatingLocation()
    if SensorCapture.hasLocationBackgroundMode {
      location.allowsBackgroundLocationUpdates = false
    }
    gnssRunning = false
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    let nowUptime = SensorCapture.nowUs()
    let nowWall = Date().timeIntervalSince1970
    for loc in locations {
      let sample = LocationSample(
        latitude: loc.coordinate.latitude,
        longitude: loc.coordinate.longitude,
        altitude: loc.altitude,
        ellipsoidalAltitude: loc.ellipsoidalAltitude,
        horizontalAccuracy: loc.horizontalAccuracy,
        verticalAccuracy: loc.verticalAccuracy,
        speed: loc.speed,
        speedAccuracy: loc.speedAccuracy,
        course: loc.course,
        courseAccuracy: loc.courseAccuracy,
        timestamp: loc.timestamp.timeIntervalSince1970,
        simulated: loc.sourceInformation?.isSimulatedBySoftware ?? false,
        fromAccessory: loc.sourceInformation?.isProducedByAccessory ?? false)
      emit("onGnss", SensorLogic.gnssEvent(sample, nowUptimeUs: nowUptime, nowWallSeconds: nowWall))
    }
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    emit("onGnssError", ["message": error.localizedDescription, "code": (error as NSError).code])
  }

  // MARK: IMU

  func startImu(options: ImuOptions) -> Bool {
    guard motion.isDeviceMotionAvailable else { return false }
    stopImu()
    let interval = 1.0 / SensorLogic.clampRateHz(options.rateHz)
    let batchMs = options.batchMs
    imuRunning = true
    motionQueue.addOperation { self.batcher = ImuBatcher(intervalMs: batchMs, nowUs: SensorCapture.nowUs()) }

    motion.deviceMotionUpdateInterval = interval
    motion.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: motionQueue) { [weak self] data, _ in
      guard let self = self, let m = data else { return }
      let q = m.attitude.quaternion
      self.append("m", SensorLogic.motionRow(
        timestamp: m.timestamp,
        rotation: (m.rotationRate.x, m.rotationRate.y, m.rotationRate.z),
        userAccelG: (m.userAcceleration.x, m.userAcceleration.y, m.userAcceleration.z),
        gravityG: (m.gravity.x, m.gravity.y, m.gravity.z),
        quaternion: (w: q.w, x: q.x, y: q.y, z: q.z)))
    }

    if options.raw {
      if motion.isGyroAvailable {
        motion.gyroUpdateInterval = interval
        motion.startGyroUpdates(to: motionQueue) { [weak self] data, _ in
          guard let self = self, let d = data else { return }
          self.append("g", SensorLogic.gyroRow(timestamp: d.timestamp, x: d.rotationRate.x, y: d.rotationRate.y, z: d.rotationRate.z))
        }
      }
      if motion.isAccelerometerAvailable {
        motion.accelerometerUpdateInterval = interval
        motion.startAccelerometerUpdates(to: motionQueue) { [weak self] data, _ in
          guard let self = self, let d = data else { return }
          self.append("a", SensorLogic.accelRow(timestamp: d.timestamp, xG: d.acceleration.x, yG: d.acceleration.y, zG: d.acceleration.z))
        }
      }
    }
    return true
  }

  func stopImu() {
    guard imuRunning else { return }
    imuRunning = false
    motion.stopDeviceMotionUpdates()
    motion.stopGyroUpdates()
    motion.stopAccelerometerUpdates()
    motionQueue.addOperation { self.flushBatch() }
  }

  /** motionQueue only. */
  private func append(_ stream: String, _ row: [Double]) {
    if let batch = batcher.append(stream, row, nowUs: SensorCapture.nowUs()) {
      emit("onImuBatch", ImuBatcher.payload(batch))
    }
  }

  /** motionQueue only. */
  private func flushBatch() {
    if let batch = batcher.flush(nowUs: SensorCapture.nowUs()) {
      emit("onImuBatch", ImuBatcher.payload(batch))
    }
  }
}
