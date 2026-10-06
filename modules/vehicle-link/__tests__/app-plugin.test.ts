// Config plugin for modules/vehicle-link: Info.plist keys the native code depends on.

jest.mock("expo/config-plugins", () => ({
  // Apply the mod immediately to the in-memory Info.plist.
  withInfoPlist: (config: any, mod: (c: any) => any) => mod({ ...config, modResults: config.modResults ?? {} }),
  withAndroidManifest: (config: any, mod: (c: any) => any) => {
    const out = mod({ ...config, modResults: config.androidManifest ?? { manifest: {} } });
    return { ...config, androidManifest: out.modResults };
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const withVehicleLink = require("../app.plugin.js");

describe("vehicle-link config plugin", () => {
  test("adds background modes, MFi protocols, and the Bluetooth permission", () => {
    const out = withVehicleLink({ name: "wtf.ai", slug: "wtf-ai" });
    expect(out.modResults.UIBackgroundModes).toEqual(["bluetooth-central", "external-accessory"]);
    expect(out.modResults.UISupportedExternalAccessoryProtocols).toEqual(["com.obdlink", "com.vgatemall"]);
    expect(out.modResults.NSBluetoothAlwaysUsageDescription).toMatch(/OBD-II adapter/);
  });

  test("merges with existing values without duplicates and keeps an existing permission text", () => {
    const out = withVehicleLink(
      {
        name: "wtf.ai",
        slug: "wtf-ai",
        modResults: {
          UIBackgroundModes: ["location", "bluetooth-central"],
          UISupportedExternalAccessoryProtocols: ["com.obdlink"],
          NSBluetoothAlwaysUsageDescription: "custom",
        },
      },
      { mfiProtocols: ["com.obdlink", "com.example.obd"] },
    );
    expect(out.modResults.UIBackgroundModes).toEqual(["location", "bluetooth-central", "external-accessory"]);
    expect(out.modResults.UISupportedExternalAccessoryProtocols).toEqual(["com.obdlink", "com.example.obd"]);
    expect(out.modResults.NSBluetoothAlwaysUsageDescription).toBe("custom");
  });

  test("Android manifest: Bluetooth permissions (scan never for location), service and sensor permissions, optional BLE", () => {
    const out = withVehicleLink({ name: "wtf.ai", slug: "wtf-ai" });
    const manifest = out.androidManifest.manifest;
    const perm = (name: string) => manifest["uses-permission"].find((p: any) => p.$["android:name"] === name)?.$;
    expect(perm("android.permission.BLUETOOTH_SCAN")["android:usesPermissionFlags"]).toBe("neverForLocation");
    expect(perm("android.permission.BLUETOOTH_CONNECT")).toBeDefined();
    expect(perm("android.permission.BLUETOOTH")["android:maxSdkVersion"]).toBe("30");
    expect(perm("android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE")).toBeDefined();
    expect(perm("android.permission.FOREGROUND_SERVICE_LOCATION")).toBeDefined();
    expect(perm("android.permission.POST_NOTIFICATIONS")).toBeDefined();
    expect(manifest["uses-feature"].every((f: any) => f.$["android:required"] === "false")).toBe(true);
  });

  test("Android manifest: running twice adds nothing twice", () => {
    const once = withVehicleLink({ name: "wtf.ai", slug: "wtf-ai" });
    const twice = withVehicleLink({ ...once });
    expect(twice.androidManifest.manifest["uses-permission"]).toHaveLength(
      once.androidManifest.manifest["uses-permission"].length,
    );
  });
});
