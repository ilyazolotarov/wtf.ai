// Config plugin for modules/car-play (docs/CARPLAY-SPEC.md §3). Never edit ios/ by hand; prebuild applies this.
// The phone's scene comes from expo-build-properties' `ios.enableSceneSupport` (SDK 57; the template's own from SDK 58);
// this adds the CarPlay scene beside it and the navigation app's entitlement.
const { withBaseMod, withEntitlementsPlist } = require("expo/config-plugins");

/** Apple grants it per app, on request, to a paid developer account; the simulator takes it without (§2). */
const ENTITLEMENT = "com.apple.developer.carplay-maps";

const CARPLAY_SCENE = {
  UISceneClassName: "CPTemplateApplicationScene",
  UISceneConfigurationName: "CarPlay",
  // `@objc(WTFCarPlaySceneDelegate)` in ios/CarPlaySceneDelegate.swift: a pod's Swift class has no module prefix to
  // resolve, so it is found by its Objective-C name, as Expo's own EXExpoAppSceneDelegate is.
  UISceneDelegateClassName: "WTFCarPlaySceneDelegate",
};

/** The scene manifest with the CarPlay scene added; throws without the phone's scene. */
function addCarPlayScene(manifest) {
  if (!manifest?.UISceneConfigurations?.UIWindowSceneSessionRoleApplication) {
    throw new Error(
      "modules/car-play needs the scene life cycle: set ios.enableSceneSupport in expo-build-properties (SDK 57).",
    );
  }
  // A copy: expo-build-properties hands over its own constant, which it compares against on the next run.
  return {
    ...manifest,
    // Phone and car screens at once.
    UIApplicationSupportsMultipleScenes: true,
    UISceneConfigurations: {
      ...manifest.UISceneConfigurations,
      CPTemplateApplicationSceneSessionRoleApplication: [CARPLAY_SCENE],
    },
  };
}

module.exports = function withCarPlay(config) {
  config = withEntitlementsPlist(config, (cfg) => {
    cfg.modResults[ENTITLEMENT] = true;
    return cfg;
  });
  // After every other plugin's Info.plist change, whatever the order in app.json: expo-build-properties refuses a scene
  // manifest it didn't write, so the CarPlay scene goes in once it has written its own.
  return withBaseMod(config, {
    platform: "ios",
    mod: "infoPlist",
    action: async ({ modRequest: { nextMod, ...modRequest }, ...cfg }) => {
      const results = await nextMod({ ...cfg, modRequest });
      results.modResults.UIApplicationSceneManifest = addCarPlayScene(results.modResults.UIApplicationSceneManifest);
      return results;
    },
  });
};

module.exports.addCarPlayScene = addCarPlayScene;
