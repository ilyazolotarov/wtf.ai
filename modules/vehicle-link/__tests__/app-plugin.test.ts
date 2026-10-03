// Config plugin for modules/vehicle-link: Info.plist keys the native code depends on.

jest.mock("expo/config-plugins", () => ({
  // Apply the mod immediately to the in-memory Info.plist.
  withInfoPlist: (config: any, mod: (c: any) => any) => mod({ ...config, modResults: config.modResults ?? {} }),
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
});
