import CarPlay

// The CarPlay scene's delegate (docs/CARPLAY-SPEC.md §3), named in Info.plist by app.plugin.js. A navigation app gets
// a window to draw its map in, under the map template's buttons and guidance panel.

@objc(WTFCarPlaySceneDelegate)
public final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
  // From here on the app has a scene that isn't a window scene, which React Native's own code doesn't expect.
  public func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
    _ = ReactSceneGuards.install
    // Opened from the car for a place (a `geo:` link): taken once the session runs.
    for context in options.urlContexts { CarPlaySession.shared.request(context.url) }
  }

  /** A place asked for while CarPlay shows the app (CARPLAY-SPEC §4): a `geo:` or `google.navigation:` link. */
  public func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    for context in URLContexts { CarPlaySession.shared.request(context.url) }
  }

  public func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController,
    to window: CPWindow
  ) {
    CarPlaySession.shared.connect(templateApplicationScene, interfaceController, window: window)
  }

  public func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnect interfaceController: CPInterfaceController,
    from window: CPWindow
  ) {
    CarPlaySession.shared.disconnect()
  }

  // The car's day or night: its map follows.
  public func contentStyleDidChange(_ contentStyle: UIUserInterfaceStyle) {
    carPlayLog.notice("CarPlay content style \(contentStyle == .dark ? "dark" : "light", privacy: .public)")
    CarPlaySession.shared.contentStyleChanged()
  }

  // CarPlay connects the scene in the background as soon as the car's screen comes on; it comes to the foreground when
  // the driver opens the app there, and goes back when another app fills the car's screen.
  public func sceneWillEnterForeground(_ scene: UIScene) {
    carPlayLog.notice("CarPlay scene in the foreground")
    CarPlaySession.shared.shown()
  }

  public func sceneDidBecomeActive(_ scene: UIScene) {
    let app = ["active", "inactive", "background"][UIApplication.shared.applicationState.rawValue]
    carPlayLog.notice("CarPlay scene active (the app \(app, privacy: .public))")
  }

  public func sceneDidEnterBackground(_ scene: UIScene) {
    carPlayLog.notice("CarPlay scene in the background")
    CarPlaySession.shared.hidden()
  }
}
