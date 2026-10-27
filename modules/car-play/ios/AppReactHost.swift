import ExpoModulesCore
import UIKit

/**
 * The app's one React Native host, seen from the car's screen (docs/CARPLAY-SPEC.md §3 point 2, §4). Views are made
 * only on a running host: making one starts the host when there is none, past Expo's React delegate handlers, and
 * expo-updates is then asked for the bundle before it is set up (an assertion in Debug, a force-unwrap in Release).
 * The phone's scene starts the host (Expo's scene delegate); without it, the app opened from the car with the phone
 * locked, `startWithoutPhone` starts it the same way, through the handlers.
 */
enum AppReactHost {
  /** The root a start without the phone's screen asks for: it renders nothing (index.ts). */
  static let noScreenModuleName = "NoScreen"

  /**
   * The template AppDelegate's `reactNativeFactory` (Expo's ExpoReactNativeFactoryProvider, in the Expo pod, which a
   * module can't depend on): an ExpoReactNativeFactory, reached through ExpoModulesCore's protocol. Nil: no such
   * AppDelegate.
   */
  private static var factory: ExpoReactNativeFactoryProtocol? {
    guard let delegate = UIApplication.shared.delegate else { return nil }
    let factory = Mirror(reflecting: delegate).children.first { $0.label == "reactNativeFactory" }?.value
    return factory as? ExpoReactNativeFactoryProtocol
  }

  private static var rootViewFactory: NSObject? {
    (factory as? NSObject)?.value(forKey: "rootViewFactory") as? NSObject
  }

  /**
   * The running host (RCTHost), nil before one: expo-updates makes it once it has chosen the bundle, the development
   * launcher once it has loaded one, and a new one at each load. A reload (Metro, the dev menu, an update's relaunch)
   * keeps the host and restarts its roots on the new runtime.
   */
  static var host: AnyObject? {
    rootViewFactory?.value(forKey: "reactHost") as AnyObject?
  }

  static var isRunning: Bool { host != nil }

  /** Holds the start's view, the handlers' placeholder until they replace it with the `NoScreen` root. */
  private static var startWindow: UIWindow?

  /**
   * Starts the host when nothing has and the phone's scene won't: Expo's scene delegate starts it as that scene
   * connects. Through the handlers, as the phone's scene does: expo-updates chooses the bundle (the update), the
   * development launcher loads the last one. They put the root in place of the view they returned, found through its
   * view controller and the app's window, so the view is held by a child controller in a window of its own, which
   * stands in as the app delegate's until the phone's scene sets its own: without one expo-updates stops the app
   * ("Cannot find the current window"). That window is never shown: a window needs a window scene for that.
   */
  static func startWithoutPhone() {
    let phoneScene = UIApplication.shared.connectedScenes.contains { $0.session.role == .windowApplication }
    guard !isRunning, startWindow == nil, !phoneScene else { return }
    guard let reactDelegate = rootViewFactory?.value(forKey: "reactDelegate") as? ExpoReactDelegate else {
      carPlayLog.error("React Native not started: no Expo React delegate")
      return
    }
    carPlayLog.notice("React Native started without the phone's scene")
    let window = UIWindow(frame: .zero)
    let container = UIViewController()
    window.rootViewController = container
    startWindow = window
    if let appDelegate = UIApplication.shared.delegate as? NSObject,
      appDelegate.responds(to: NSSelectorFromString("setWindow:")),
      appDelegate.value(forKey: "window") == nil
    {
      appDelegate.setValue(window, forKey: "window")
    }
    let holder = UIViewController()
    holder.view = reactDelegate.createReactRootView(
      moduleName: noScreenModuleName, initialProperties: nil, launchOptions: nil)
    container.addChild(holder)
    container.view.addSubview(holder.view)
    holder.didMove(toParent: container)
  }

  /**
   * A root view of `moduleName` on the running host; nil while there is none. Made without the app delegate
   * subscribers' root view customizations (RCTRootViewFactoryConfiguration's customizeRootView, read the way
   * ExpoReactNativeFactory reads it): expo-splash-screen's would put the launch screen over the car's map for good, and
   * move its one splash to this view, so the phone's would never go if CarPlay connected while it showed.
   */
  static func rootView(moduleName: String) -> UIView? {
    guard isRunning, let factory else { return nil }
    let configuration = rootViewFactory?.value(forKey: "_configuration") as? NSObject
    let customize = configuration?.value(forKey: "customizeRootView")
    configuration?.setValue(nil, forKey: "customizeRootView")
    defer { configuration?.setValue(customize, forKey: "customizeRootView") }
    return factory.recreateRootView(withBundleURL: nil, moduleName: moduleName, initialProps: nil, launchOptions: nil)
  }
}
