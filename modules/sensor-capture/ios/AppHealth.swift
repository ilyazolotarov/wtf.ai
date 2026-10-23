import CoreLocation
import ExpoModulesCore
import MetricKit
import UIKit
import os

// The app process itself (docs/TRIP-LOGGER-SPEC.md §4.4): what it uses, how it was launched, how the previous run
// ended, and what iOS reports about exits and crashes (MetricKit). The trip log and Sentry get it from JS; this side
// only reads and keeps it, since a process that is killed can't say anything afterwards.

public class AppHealthAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    AppHealth.shared.launched(options: launchOptions, inBackground: application.applicationState == .background)
    // Relaunched in the background with a location session that was running: joined at once, or iOS takes the app
    // for no longer interested in location (TRIP-LOGGER-SPEC §4.3).
    LocationKeepAlive.resumeAtLaunch()
    // Relaunched for a significant location change: the event goes only to a manager that starts monitoring again.
    DriveWake.shared.resume()
    return true
  }

  /**
   iOS ends a running app with this call when the driver swipes it away (an app it ends itself, or one suspended, gets
   none): nothing brings it back until it is opened (TRIP-LOGGER-SPEC §4.3). Its location session ends, so iOS doesn't
   relaunch it for location and the next launch shows no indicator; significant changes stop until the next launch.
   */
  public func applicationWillTerminate(_ application: UIApplication) {
    AppHealth.shared.willTerminate()
    LocationKeepAlive.end()
    DriveWake.shared.pause()
  }

  public func applicationDidReceiveMemoryWarning(_ application: UIApplication) {
    AppHealth.shared.memoryWarning()
  }
}

final class AppHealth: NSObject, MXMetricManagerSubscriber, @unchecked Sendable {
  static let shared = AppHealth()

  private static let heartbeatKey = "ai.wtf.health.heartbeat"
  private static let terminateKey = "ai.wtf.health.willTerminateMs"
  private static let pendingKey = "ai.wtf.health.pending"
  /** Pending reports kept for the next trip at most (a phone that never drives again doesn't grow it). */
  private static let maxPending = 20

  private let defaults = UserDefaults.standard
  private let lock = NSLock()
  private var launch: [String: Any] = [:]
  /** JS listens while the module lives; a warning before that is only counted. */
  var onMemoryWarning: (() -> Void)?
  private var memoryWarnings = 0

  func launched(options: [UIApplication.LaunchOptionsKey: Any]?, inBackground: Bool) {
    var reasons: [String] = []
    if options?[.location] != nil { reasons.append("location") }
    if options?[.bluetoothCentrals] != nil { reasons.append("bluetooth") }
    if options?[.remoteNotification] != nil { reasons.append("notification") }
    if options?[.url] != nil { reasons.append("url") }
    var info: [String: Any] = [
      "wallMs": Date().timeIntervalSince1970 * 1000,
      "uptimeUs": SensorCapture.nowUs(),
      "inBackground": inBackground,
      "reasons": reasons,
    ]
    // The previous process: its last heartbeat, and whether iOS told it it was about to end.
    if var previous = defaults.dictionary(forKey: AppHealth.heartbeatKey) {
      let terminated = defaults.double(forKey: AppHealth.terminateKey)
      if terminated > 0 { previous["willTerminateWallMs"] = terminated }
      info["previous"] = previous
    }
    defaults.removeObject(forKey: AppHealth.heartbeatKey)
    defaults.removeObject(forKey: AppHealth.terminateKey)
    lock.lock()
    launch = info
    lock.unlock()
    MXMetricManager.shared.add(self)
  }

  func launchInfo() -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    return launch
  }

  /** Written at once: nothing runs after it. */
  func willTerminate() {
    defaults.set(Date().timeIntervalSince1970 * 1000, forKey: AppHealth.terminateKey)
    defaults.synchronize()
  }

  func memoryWarning() {
    lock.lock()
    memoryWarnings += 1
    let listener = onMemoryWarning
    lock.unlock()
    listener?()
  }

  // MARK: Stats

  /** The process now, and a heartbeat the next launch reads if this one ends without a word. */
  func stats(appState: String, context: String) -> [String: Any] {
    let footprintMb = AppHealth.footprintBytes().map { Double($0) / 1_048_576 } ?? .nan
    let headroom = os_proc_available_memory()
    let headroomMb = headroom > 0 ? Double(headroom) / 1_048_576 : .nan
    let info = ProcessInfo.processInfo
    lock.lock()
    let warnings = memoryWarnings
    lock.unlock()
    let out: [String: Any] = [
      "footprintMb": footprintMb,
      "headroomMb": headroomMb,
      "cpuS": AppHealth.cpuSeconds(),
      "thermal": AppHealth.thermalString(info.thermalState),
      "lowPower": info.isLowPowerModeEnabled,
      "memoryWarnings": warnings,
    ]
    defaults.set(
      [
        "wallMs": Date().timeIntervalSince1970 * 1000,
        "appState": appState,
        "context": context,
        "footprintMb": footprintMb.isFinite ? footprintMb : -1,
        "headroomMb": headroomMb.isFinite ? headroomMb : -1,
        "thermal": out["thermal"] as Any,
        "memoryWarnings": warnings,
      ] as [String: Any],
      forKey: AppHealth.heartbeatKey)
    return out
  }

  private static func footprintBytes() -> UInt64? {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let result = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
      }
    }
    return result == KERN_SUCCESS ? info.phys_footprint : nil
  }

  private static func cpuSeconds() -> Double {
    var usage = rusage()
    guard getrusage(RUSAGE_SELF, &usage) == 0 else { return .nan }
    let user = Double(usage.ru_utime.tv_sec) + Double(usage.ru_utime.tv_usec) / 1e6
    let system = Double(usage.ru_stime.tv_sec) + Double(usage.ru_stime.tv_usec) / 1e6
    return user + system
  }

  private static func thermalString(_ state: ProcessInfo.ThermalState) -> String {
    switch state {
    case .nominal: return "nominal"
    case .fair: return "fair"
    case .serious: return "serious"
    case .critical: return "critical"
    @unknown default: return "nominal"
    }
  }

  // MARK: MetricKit

  /** What iOS reported since the last call (exits by reason a day at a time, crashes and hangs), oldest first. */
  func takeReports() -> [[String: Any]] {
    lock.lock()
    defer { lock.unlock() }
    let pending = defaults.array(forKey: AppHealth.pendingKey) as? [[String: Any]] ?? []
    defaults.removeObject(forKey: AppHealth.pendingKey)
    return pending
  }

  private func keep(_ reports: [[String: Any]]) {
    guard !reports.isEmpty else { return }
    lock.lock()
    defer { lock.unlock() }
    var pending = defaults.array(forKey: AppHealth.pendingKey) as? [[String: Any]] ?? []
    pending.append(contentsOf: reports)
    defaults.set(Array(pending.suffix(AppHealth.maxPending)), forKey: AppHealth.pendingKey)
  }

  func didReceive(_ payloads: [MXMetricPayload]) {
    keep(payloads.compactMap { payload -> [String: Any]? in
      guard let exits = payload.applicationExitMetrics else { return nil }
      let fg = exits.foregroundExitData
      let bg = exits.backgroundExitData
      return [
        "kind": "exits",
        "fromMs": payload.timeStampBegin.timeIntervalSince1970 * 1000,
        "toMs": payload.timeStampEnd.timeIntervalSince1970 * 1000,
        "foreground": [
          "normal": fg.cumulativeNormalAppExitCount,
          "memoryLimit": fg.cumulativeMemoryResourceLimitExitCount,
          "badAccess": fg.cumulativeBadAccessExitCount,
          "abnormal": fg.cumulativeAbnormalExitCount,
          "illegalInstruction": fg.cumulativeIllegalInstructionExitCount,
          "watchdog": fg.cumulativeAppWatchdogExitCount,
        ],
        "background": [
          "normal": bg.cumulativeNormalAppExitCount,
          "memoryLimit": bg.cumulativeMemoryResourceLimitExitCount,
          "cpuLimit": bg.cumulativeCPUResourceLimitExitCount,
          "memoryPressure": bg.cumulativeMemoryPressureExitCount,
          "badAccess": bg.cumulativeBadAccessExitCount,
          "abnormal": bg.cumulativeAbnormalExitCount,
          "illegalInstruction": bg.cumulativeIllegalInstructionExitCount,
          "watchdog": bg.cumulativeAppWatchdogExitCount,
          "lockedFile": bg.cumulativeSuspendedWithLockedFileExitCount,
          "taskTimeout": bg.cumulativeBackgroundTaskAssertionTimeoutExitCount,
        ],
      ]
    })
  }

  func didReceive(_ payloads: [MXDiagnosticPayload]) {
    var reports: [[String: Any]] = []
    for payload in payloads {
      let atMs = payload.timeStampEnd.timeIntervalSince1970 * 1000
      for crash in payload.crashDiagnostics ?? [] {
        var r: [String: Any] = ["kind": "crash", "atMs": atMs]
        if let v = crash.exceptionType { r["exceptionType"] = v.intValue }
        if let v = crash.exceptionCode { r["exceptionCode"] = v.intValue }
        if let v = crash.signal { r["signal"] = v.intValue }
        if let v = crash.terminationReason { r["terminationReason"] = String(v.prefix(300)) }
        r["build"] = crash.metaData.applicationBuildVersion
        reports.append(r)
      }
      for hang in payload.hangDiagnostics ?? [] {
        reports.append(["kind": "hang", "atMs": atMs, "seconds": hang.hangDuration.converted(to: .seconds).value])
      }
      for cpu in payload.cpuExceptionDiagnostics ?? [] {
        reports.append([
          "kind": "cpu", "atMs": atMs,
          "cpuSeconds": cpu.totalCPUTime.converted(to: .seconds).value,
          "sampledSeconds": cpu.totalSampledTime.converted(to: .seconds).value,
        ])
      }
    }
    keep(reports)
  }
}

/**
 A location session (iOS 17+), held from when the app is in front until JS lets it go (`setLocationSession`,
 TRIP-LOGGER-SPEC §4.3). Only one started in the foreground counts, and while it is held a trip starting in the
 background can start GNSS ("When In Use" can't from the background otherwise: 2026-10-21, a whole drive without a
 fix), and iOS relaunches the app after ending it, the app joining the session at launch (Apple: "recreate the session
 immediately upon launch in the background"). Not invalidated when iOS ends the app (an invalidated session can't be
 started again from the background), only when the driver swipes it away (`applicationWillTerminate`).
 */
enum LocationKeepAlive {
  private static let activeKey = "ai.wtf.location.sessionActive"
  /** Joined at a relaunch, then this long for JS to hold it again; else ended (no indicator for nothing). */
  private static let resumeGraceS = 120.0
  nonisolated(unsafe) private static var session: AnyObject?
  nonisolated(unsafe) private static var held = false

  static var active: Bool { UserDefaults.standard.bool(forKey: activeKey) }

  /** On the main thread. Without location permission nothing (a session would ask for it). */
  @discardableResult
  static func begin() -> Bool {
    let status = CLLocationManager().authorizationStatus
    guard status == .authorizedWhenInUse || status == .authorizedAlways else { return false }
    held = true
    UserDefaults.standard.set(true, forKey: activeKey)
    guard #available(iOS 17.0, *) else { return false }
    if session == nil { session = CLBackgroundActivitySession() }
    return true
  }

  /** The indicator goes, and iOS won't relaunch the app for location. */
  static func end() {
    held = false
    UserDefaults.standard.set(false, forKey: activeKey)
    guard #available(iOS 17.0, *), let s = session as? CLBackgroundActivitySession else { return }
    s.invalidate()
    session = nil
  }

  static func resumeAtLaunch() {
    guard active, #available(iOS 17.0, *), session == nil else { return }
    session = CLBackgroundActivitySession()
    DispatchQueue.main.asyncAfter(deadline: .now() + resumeGraceS) {
      if !held { end() }
    }
  }
}

/**
 The opt-in that keeps the driver's position when they forget to open the app (VEHICLE-LINK-SPEC §11): with location
 "Always", significant location changes relaunch the app a few hundred metres into a drive, whatever the adapter, and
 JS connects it and starts GNSS (which "Always" may start from the background). Low power: cell and Wi-Fi changes, no
 GNSS. A swipe in the app switcher, or Background App Refresh off, stops the relaunches until the app is opened.
 */
final class DriveWake: NSObject, CLLocationManagerDelegate, @unchecked Sendable {
  static let shared = DriveWake()
  private static let onKey = "ai.wtf.driveWake.on"
  private var manager: CLLocationManager?
  private let lock = NSLock()
  /** The newest location for the wake: the one iOS relaunched the app for, or the manager's cached one at launch. */
  private var lastFix: CLLocation?

  var enabled: Bool { UserDefaults.standard.bool(forKey: DriveWake.onKey) }

  /** On the main thread. True while monitoring (on, and location "Always" granted). */
  func set(_ on: Bool) -> Bool {
    UserDefaults.standard.set(on, forKey: DriveWake.onKey)
    if on { return resume() }
    manager?.stopMonitoringSignificantLocationChanges()
    manager?.delegate = nil
    manager = nil
    return false
  }

  /** On the main thread: no relaunches until the next launch monitors again (`resume`); the opt-in stays. */
  func pause() {
    manager?.stopMonitoringSignificantLocationChanges()
  }

  /** On the main thread, at every launch: monitoring again keeps the relaunches coming. */
  @discardableResult
  func resume() -> Bool {
    guard enabled, CLLocationManager.significantLocationChangeMonitoringAvailable() else { return false }
    let m = manager ?? CLLocationManager()
    m.delegate = self
    manager = m
    if let cached = m.location { keep(cached) }
    guard m.authorizationStatus == .authorizedAlways else { return false }
    m.startMonitoringSignificantLocationChanges()
    return true
  }

  /** For JS (any thread): whether the car still stands where it was parked (on-the-way.ts). Nil: none yet. */
  func fix() -> [String: Any]? {
    lock.lock()
    defer { lock.unlock() }
    guard let l = lastFix, l.horizontalAccuracy >= 0 else { return nil }
    return [
      "lat": l.coordinate.latitude,
      "lon": l.coordinate.longitude,
      "accuracyM": l.horizontalAccuracy,
      "wallMs": l.timestamp.timeIntervalSince1970 * 1000,
    ]
  }

  private func keep(_ location: CLLocation) {
    lock.lock()
    defer { lock.unlock() }
    if let last = lastFix, last.timestamp >= location.timestamp { return }
    lastFix = location
  }

  // The relaunch is the point: GNSS and the trip start from JS. Delivered while running too, every few hundred metres.
  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    if let last = locations.last { keep(last) }
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}

  // "Always" granted later (in Settings): monitoring starts then.
  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    if enabled && manager.authorizationStatus == .authorizedAlways {
      manager.startMonitoringSignificantLocationChanges()
    }
  }
}
