import CarPlay
import ObjectiveC
import UIKit

/**
 * React Native's appearance module (`Appearance`) made safe for the car's screen. React Native is prebuilt, so its
 * source can't be patched: its methods are replaced, once a CarPlay scene connects.
 *
 * - `-[RCTAppearance setColorScheme:]` (`Appearance.setColorScheme`, the app's theme setting) takes every connected
 *   scene for a `UIWindowScene` and asks it for its windows. CarPlay's `CPTemplateApplicationScene` has none: with the
 *   car's screen connected the app crashed ("unrecognized selector"). Replaced by the same loop over the window scenes
 *   only: the phone's windows take the app's scheme, the car's screen keeps its own day and night (CARPLAY-SPEC §4).
 * - `-[RCTAppearance appearanceChanged:]` takes the scheme of any React root whose traits change, as the app's. The car
 *   map's root follows the car's day and night: a car by day turned the phone's dark theme light until the setting was
 *   switched off and on. A root on the car's screen is left out; the phone's roots alone set the app's scheme.
 */
enum ReactSceneGuards {
  /** The car map's React roots (CarPlaySession): their traits are the car's, not the app's scheme. */
  private static let carRoots = NSHashTable<UIView>.weakObjects()

  /** A React root made for the car's screen. Main thread. */
  static func carRoot(_ view: UIView) {
    carRoots.add(view)
  }

  static let install: Void = {
    guard let appearance = NSClassFromString("RCTAppearance") else {
      carPlayLog.error("RCTAppearance not found, left unguarded")
      return
    }
    if let method = class_getInstanceMethod(appearance, NSSelectorFromString("setColorScheme:")) {
      // RCTConvert's UIUserInterfaceStyle: "light", "dark", anything else unspecified (the system's).
      let setColorScheme: @convention(block) (AnyObject, NSString?) -> Void = { _, style in
        let interfaceStyle: UIUserInterfaceStyle
        switch style as String? {
        case "light": interfaceStyle = .light
        case "dark": interfaceStyle = .dark
        default: interfaceStyle = .unspecified
        }
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
          for window in scene.windows {
            window.overrideUserInterfaceStyle = interfaceStyle
          }
        }
      }
      method_setImplementation(method, imp_implementationWithBlock(setColorScheme))
    } else {
      carPlayLog.error("RCTAppearance setColorScheme: not found, left unguarded")
    }
    let changedSelector = NSSelectorFromString("appearanceChanged:")
    guard let changed = class_getInstanceMethod(appearance, changedSelector) else {
      carPlayLog.error("RCTAppearance appearanceChanged: not found, left unguarded")
      return
    }
    typealias AppearanceChanged = @convention(c) (AnyObject, Selector, NSNotification) -> Void
    let original = unsafeBitCast(method_getImplementation(changed), to: AppearanceChanged.self)
    // The notification's object is the root whose traits changed (RCTSurfaceHostingView, RCTRootView).
    let appearanceChanged: @convention(block) (AnyObject, NSNotification) -> Void = { module, notification in
      if let view = notification.object as? UIView, view.window is CPWindow || carRoots.contains(view) { return }
      original(module, changedSelector, notification)
    }
    method_setImplementation(changed, imp_implementationWithBlock(appearanceChanged))
  }()
}
