import CarPlay

// The CarPlay scene's delegate (docs/CARPLAY-SPEC.md §3), named in Info.plist by app.plugin.js. A navigation app gets
// a window to draw its map in, under the map template's buttons and guidance panel.

@objc(WTFCarPlaySceneDelegate)
public final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
  public func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController,
    to window: CPWindow
  ) {
    CarPlaySession.shared.connect(interfaceController, window: window)
  }

  public func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnect interfaceController: CPInterfaceController,
    from window: CPWindow
  ) {
    CarPlaySession.shared.disconnect()
  }

  // CarPlay connects the scene in the background as soon as the car's screen comes on; it becomes active when the
  // driver opens the app there.
  public func sceneDidBecomeActive(_ scene: UIScene) {
    carPlayLog.notice("CarPlay scene active")
  }

  public func sceneDidEnterBackground(_ scene: UIScene) {
    carPlayLog.notice("CarPlay scene in the background")
  }
}
