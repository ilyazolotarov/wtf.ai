import ObjectiveC
import UIKit

/**
 * React Native's JS timers keep going while only the car's screen shows the app (docs/CARPLAY-SPEC.md §4, JS timers).
 * `RCTTiming` fires them from a CADisplayLink of the phone's screen, unless the app goes to the background (NSTimers
 * then). The car's screen keeps the app out of the background, so with the phone locked they followed the phone's
 * display, and with its screen dark they stopped: no navigator tick, the dot frozen on the car's map, while MapLibre
 * (on the car screen's own display link) went on drawing. Its `appDidMoveToForeground` now keeps the background mode
 * unless the phone shows the app (`TimerPaceLogic`), and the phone's scenes coming and going move each timing between
 * the two. React Native is prebuilt, so its source can't be patched.
 */
enum ReactTimerPace {
  private typealias Method0 = @convention(c) (AnyObject, Selector) -> Void

  private static let foregroundSelector = NSSelectorFromString("appDidMoveToForeground")
  private static let backgroundSelector = NSSelectorFromString("appDidMoveToBackground")
  private static let setupSelector = NSSelectorFromString("setup")
  private static var originalForeground: Method0?
  private static var background: Method0?
  /** Each RCTTiming, one per JS runtime; touched on the main thread only. */
  private static let timings = NSHashTable<AnyObject>.weakObjects()
  private static var paced: JSTimerPace?

  /** Before React Native starts: its timing is made with the runtime and sets itself up then. */
  static let install: Void = {
    guard let timing = NSClassFromString("RCTTiming"),
      let foreground = class_getInstanceMethod(timing, foregroundSelector),
      let setup = class_getInstanceMethod(timing, setupSelector),
      let background = class_getInstanceMethod(timing, backgroundSelector)
    else {
      carPlayLog.error("RCTTiming's foreground, background or setup not found: JS timers follow the phone's display")
      return
    }
    let originalForeground = unsafeBitCast(method_getImplementation(foreground), to: Method0.self)
    let originalSetup = unsafeBitCast(method_getImplementation(setup), to: Method0.self)
    Self.originalForeground = originalForeground
    Self.background = unsafeBitCast(method_getImplementation(background), to: Method0.self)

    // The app coming out of the background (the car's screen too), the proximity sensor uncovered.
    let toForeground: @convention(block) (AnyObject) -> Void = { timing in pace(timing) }
    method_setImplementation(foreground, imp_implementationWithBlock(toForeground))

    // On the JS thread, as the runtime starts. Started for the car's screen alone, the app is inactive, not in the
    // background: React Native's own check leaves the display's pace on.
    let setUp: @convention(block) (AnyObject) -> Void = { timing in
      originalSetup(timing, setupSelector)
      DispatchQueue.main.async {
        timings.add(timing)
        if UIApplication.shared.applicationState != .background { pace(timing) }
      }
    }
    method_setImplementation(setup, imp_implementationWithBlock(setUp))

    // The phone's screen showing the app or not, which the app's state misses while the car's screen shows it.
    for name in [UIScene.didActivateNotification, UIScene.didEnterBackgroundNotification] {
      NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { note in
        guard note.object is UIWindowScene, UIApplication.shared.applicationState != .background else { return }
        for timing in timings.allObjects { pace(timing) }
      }
    }
  }()

  /** On the main thread, as React Native moves it between its modes. */
  private static func pace(_ timing: AnyObject) {
    let pace = TimerPaceLogic.pace(phoneScenes: phoneScenes())
    if pace != paced {
      paced = pace
      carPlayLog.notice(
        "JS timers \(pace == .phoneDisplay ? "on the phone's display" : "on their own, the phone's screen not showing the app", privacy: .public)"
      )
    }
    switch pace {
    case .phoneDisplay: originalForeground?(timing, foregroundSelector)
    case .ownTimers: background?(timing, backgroundSelector)
    }
  }

  /** The phone's: CarPlay's scene is no window scene. */
  private static func phoneScenes() -> [PhoneSceneState] {
    UIApplication.shared.connectedScenes.compactMap { scene in
      guard scene is UIWindowScene else { return nil }
      switch scene.activationState {
      case .foregroundActive: return .foregroundActive
      case .foregroundInactive: return .foregroundInactive
      case .background: return .background
      default: return .unattached
      }
    }
  }
}
