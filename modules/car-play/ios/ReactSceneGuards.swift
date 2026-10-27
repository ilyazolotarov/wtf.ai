import ObjectiveC
import UIKit

/**
 * React Native's `-[RCTAppearance setColorScheme:]` (`Appearance.setColorScheme`, the app's theme setting) takes every
 * connected scene for a `UIWindowScene` and asks it for its windows. CarPlay's `CPTemplateApplicationScene` has none:
 * with the car's screen connected the app crashed ("unrecognized selector"). Replaced, once a CarPlay scene connects,
 * by the same loop over the window scenes only: the phone's windows take the app's scheme, the car's screen keeps its
 * own day and night (CARPLAY-SPEC §4). React Native is prebuilt, so its source can't be patched.
 */
enum ReactSceneGuards {
  static let install: Void = {
    guard let appearance = NSClassFromString("RCTAppearance"),
      let method = class_getInstanceMethod(appearance, NSSelectorFromString("setColorScheme:"))
    else {
      carPlayLog.error("RCTAppearance setColorScheme: not found, left unguarded")
      return
    }
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
  }()
}
