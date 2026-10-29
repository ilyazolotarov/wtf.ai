import Foundation

// What paces React Native's JS timers (setTimeout, setInterval, requestAnimationFrame) on iOS (docs/CARPLAY-SPEC.md §4,
// JS timers), decided without UIKit: ReactTimerPace applies it to React Native's RCTTiming.

/** A phone's window scene, by UIKit's activation state. */
enum PhoneSceneState: Equatable {
  case unattached, foregroundActive, foregroundInactive, background
}

/**
 * The phone's display frames (RCTTiming's CADisplayLink, the phone's screen's) or timers of their own (its background
 * mode, NSTimers).
 */
enum JSTimerPace: Equatable {
  case phoneDisplay, ownTimers
}

enum TimerPaceLogic {
  /**
   * The phone's display only while it shows the app (a scene of the phone's in the foreground). React Native goes by the
   * app's state, which the car's screen keeps out of the background: with only the car showing the app, its timers
   * followed the phone's display, and stopped with it when the phone's screen went dark.
   */
  static func pace(phoneScenes: [PhoneSceneState]) -> JSTimerPace {
    phoneScenes.contains { $0 == .foregroundActive || $0 == .foregroundInactive } ? .phoneDisplay : .ownTimers
  }
}
