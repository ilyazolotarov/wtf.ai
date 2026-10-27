// Config plugin for modules/car-play (docs/CARPLAY-SPEC.md §3). Never edit ios/ by hand; prebuild applies this.
// The phone's scene comes from expo-build-properties' `ios.enableSceneSupport` (SDK 57; the template's own from SDK 58);
// this adds the CarPlay scene beside it, the navigation app's entitlement when `CARPLAY_ENTITLEMENT` is set, and the
// map links another app opens a navigator with.
const { withBaseMod, withEntitlementsPlist } = require("expo/config-plugins");

/**
 * Apple adds it to the App ID on request (§2). A signed build that claims it before then fails to sign, so it is
 * claimed only with `CARPLAY_ENTITLEMENT=1` (the repository variable, once granted; the simulator build). Without it
 * the scene stays and CarPlay doesn't list the app. The unsigned sideloaded build carries no entitlements either way.
 */
const ENTITLEMENT = "com.apple.developer.carplay-maps";
const claimEntitlement = () => ["1", "true"].includes(process.env.CARPLAY_ENTITLEMENT?.trim() ?? "");

const CARPLAY_SCENE = {
  UISceneClassName: "CPTemplateApplicationScene",
  UISceneConfigurationName: "CarPlay",
  // `@objc(WTFCarPlaySceneDelegate)` in ios/CarPlaySceneDelegate.swift: a pod's Swift class has no module prefix to
  // resolve, so it is found by its Objective-C name, as Expo's own EXExpoAppSceneDelegate is.
  UISceneDelegateClassName: "WTFCarPlaySceneDelegate",
};

/**
 * Links a place is handed to a navigator with (SEARCH-SPEC §4.6), as Android's intent filters take them: `geo:` to look
 * for it, `google.navigation:` to go there. The phone's route screen searches them (+native-intent.tsx); the car's
 * screen, while CarPlay shows the app, searches or routes (CARPLAY-SPEC §4).
 */
const MAP_LINK_SCHEMES = ["geo", "google.navigation"];

/** The Info.plist's URL types with the map links added, once. */
function addMapLinks(urlTypes) {
  const types = urlTypes ?? [];
  const missing = MAP_LINK_SCHEMES.filter((s) => !types.some((t) => t.CFBundleURLSchemes?.includes(s)));
  return missing.length ? [...types, { CFBundleURLSchemes: missing }] : types;
}

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
  if (claimEntitlement()) {
    config = withEntitlementsPlist(config, (cfg) => {
      cfg.modResults[ENTITLEMENT] = true;
      return cfg;
    });
  }
  // After every other plugin's Info.plist change, whatever the order in app.json: expo-build-properties refuses a scene
  // manifest it didn't write, so the CarPlay scene goes in once it has written its own.
  return withBaseMod(config, {
    platform: "ios",
    mod: "infoPlist",
    action: async ({ modRequest: { nextMod, ...modRequest }, ...cfg }) => {
      const results = await nextMod({ ...cfg, modRequest });
      results.modResults.UIApplicationSceneManifest = addCarPlayScene(results.modResults.UIApplicationSceneManifest);
      results.modResults.CFBundleURLTypes = addMapLinks(results.modResults.CFBundleURLTypes);
      return results;
    },
  });
};

module.exports.addCarPlayScene = addCarPlayScene;
module.exports.addMapLinks = addMapLinks;
