// Config plugin for modules/car-play: the CarPlay scene beside the phone's (docs/CARPLAY-SPEC.md §3). The mods'
// place after the other plugins' Info.plist changes is checked by `npx expo config --type introspect`, not here.

jest.mock("expo/config-plugins", () => ({
  withBaseMod: jest.fn((config: any) => config),
  // Apply the mod immediately to an empty entitlements plist.
  withEntitlementsPlist: jest.fn((config: any, mod: (c: any) => any) => mod({ ...config, modResults: {} })),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const withCarPlay = require("../app.plugin.js");
const { addCarPlayScene, addMapLinks } = withCarPlay;

/** The phone's scene as the prebuild template's Info.plist declares it (SDK 58). */
const PHONE_SCENE = {
  UIApplicationSupportsMultipleScenes: false,
  UISceneConfigurations: {
    UIWindowSceneSessionRoleApplication: [
      { UISceneConfigurationName: "Default Configuration", UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate" },
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

  test("leaves the manifest it was given as it was", () => {
    const before = JSON.stringify(PHONE_SCENE);
    addCarPlayScene(PHONE_SCENE);
    expect(JSON.stringify(PHONE_SCENE)).toBe(before);
  });

  test("takes the map links other apps open a navigator with, beside the app's own scheme, once", () => {
    const own = [{ CFBundleURLSchemes: ["wtfai", "ai.wtf.navigator"] }];
    const links = addMapLinks(own);
    expect(links).toEqual([...own, { CFBundleURLSchemes: ["geo", "google.navigation"] }]);
    expect(addMapLinks(links)).toEqual(links);
    expect(addMapLinks(undefined)).toEqual([{ CFBundleURLSchemes: ["geo", "google.navigation"] }]);
  });

  test("refuses to run without the phone's scene", () => {
    expect(() => addCarPlayScene(undefined)).toThrow(/scene manifest/);
  });

  test("claims the navigation entitlement only with CARPLAY_ENTITLEMENT: signing fails before Apple grants it", () => {
    const was = process.env.CARPLAY_ENTITLEMENT;
    try {
      for (const [value, claimed] of [[undefined, false], ["", false], ["0", false], ["1", true], [" true ", true]] as const) {
        if (value === undefined) delete process.env.CARPLAY_ENTITLEMENT;
        else process.env.CARPLAY_ENTITLEMENT = value;
        const out = withCarPlay({ name: "wtf.ai", slug: "wtf-ai" });
        expect(out.modResults?.["com.apple.developer.carplay-maps"]).toBe(claimed ? true : undefined);
      }
    } finally {
      if (was === undefined) delete process.env.CARPLAY_ENTITLEMENT;
      else process.env.CARPLAY_ENTITLEMENT = was;
    }
  });
});
