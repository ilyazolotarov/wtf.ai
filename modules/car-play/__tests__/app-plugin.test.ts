// Config plugin for modules/car-play: the CarPlay scene beside the phone's (docs/CARPLAY-SPEC.md §3). The mods'
// order with expo-build-properties is checked by `npx expo config --type introspect`, not here.

jest.mock("expo/config-plugins", () => ({ withBaseMod: jest.fn(), withEntitlementsPlist: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { addCarPlayScene } = require("../app.plugin.js");

/** What expo-build-properties' `ios.enableSceneSupport` writes. */
const PHONE_SCENE = {
  UIApplicationSupportsMultipleScenes: false,
  UISceneConfigurations: {
    UIWindowSceneSessionRoleApplication: [
      { UISceneConfigurationName: "Default Configuration", UISceneDelegateClassName: "EXExpoAppSceneDelegate" },
    ],
  },
};

describe("car-play config plugin", () => {
  test("adds the CarPlay scene beside the phone's, both at once", () => {
    const manifest = addCarPlayScene(PHONE_SCENE);
    expect(manifest.UIApplicationSupportsMultipleScenes).toBe(true);
    expect(manifest.UISceneConfigurations.UIWindowSceneSessionRoleApplication).toEqual(
      PHONE_SCENE.UISceneConfigurations.UIWindowSceneSessionRoleApplication,
    );
    expect(manifest.UISceneConfigurations.CPTemplateApplicationSceneSessionRoleApplication).toEqual([
      {
        UISceneClassName: "CPTemplateApplicationScene",
        UISceneConfigurationName: "CarPlay",
        UISceneDelegateClassName: "WTFCarPlaySceneDelegate",
      },
    ]);
  });

  test("leaves expo-build-properties' manifest as it was: it compares against it", () => {
    const before = JSON.stringify(PHONE_SCENE);
    addCarPlayScene(PHONE_SCENE);
    expect(JSON.stringify(PHONE_SCENE)).toBe(before);
  });

  test("refuses to run without the phone's scene", () => {
    expect(() => addCarPlayScene(undefined)).toThrow(/enableSceneSupport/);
  });
});
