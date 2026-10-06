// Config plugin for modules/vehicle-link (docs/VEHICLE-LINK-SPEC.md §5.4).
// Never edit ios/ by hand; prebuild applies this.
const { withAndroidManifest, withInfoPlist } = require("expo/config-plugins");

const DEFAULT_PROTOCOLS = ["com.obdlink", "com.vgatemall"];

function addUnique(list, values) {
  const out = Array.isArray(list) ? [...list] : [];
  for (const v of values) if (!out.includes(v)) out.push(v);
  return out;
}

// Android (docs/ANDROID-SPEC.md §2): Bluetooth runtime permissions, foreground service types, sensors, notifications.
// BLUETOOTH_SCAN is `neverForLocation`: scan results are never used to derive a position.
const ANDROID_PERMISSIONS = [
  { name: "android.permission.BLUETOOTH_SCAN", attrs: { "android:usesPermissionFlags": "neverForLocation" } },
  { name: "android.permission.BLUETOOTH_CONNECT" },
  { name: "android.permission.BLUETOOTH", attrs: { "android:maxSdkVersion": "30" } },
  { name: "android.permission.BLUETOOTH_ADMIN", attrs: { "android:maxSdkVersion": "30" } },
  { name: "android.permission.FOREGROUND_SERVICE" },
  { name: "android.permission.FOREGROUND_SERVICE_LOCATION" },
  { name: "android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE" },
  { name: "android.permission.POST_NOTIFICATIONS" },
  { name: "android.permission.WAKE_LOCK" },
  { name: "android.permission.HIGH_SAMPLING_RATE_SENSORS" },
];

const ANDROID_FEATURES = [
  { name: "android.hardware.bluetooth", required: "false" },
  { name: "android.hardware.bluetooth_le", required: "false" },
];

function addAndroidEntries(manifest) {
  const perms = (manifest["uses-permission"] = manifest["uses-permission"] ?? []);
  for (const { name, attrs } of ANDROID_PERMISSIONS) {
    const existing = perms.find((p) => p.$?.["android:name"] === name);
    if (existing) Object.assign(existing.$, attrs);
    else perms.push({ $: { "android:name": name, ...attrs } });
  }
  const features = (manifest["uses-feature"] = manifest["uses-feature"] ?? []);
  for (const { name, required } of ANDROID_FEATURES) {
    const existing = features.find((f) => f.$?.["android:name"] === name);
    if (existing) existing.$["android:required"] = required;
    else features.push({ $: { "android:name": name, "android:required": required } });
  }
}

module.exports = function withVehicleLink(config, props = {}) {
  const protocols = props.mfiProtocols ?? DEFAULT_PROTOCOLS;
  const bluetoothText =
    props.bluetoothPermission ?? "Allow $(PRODUCT_NAME) to connect to your OBD-II adapter to read vehicle speed.";
  config = withAndroidManifest(config, (cfg) => {
    addAndroidEntries(cfg.modResults.manifest);
    return cfg;
  });
  return withInfoPlist(config, (cfg) => {
    const plist = cfg.modResults;
    plist.NSBluetoothAlwaysUsageDescription = plist.NSBluetoothAlwaysUsageDescription ?? bluetoothText;
    plist.UIBackgroundModes = addUnique(plist.UIBackgroundModes, ["bluetooth-central", "external-accessory"]);
    plist.UISupportedExternalAccessoryProtocols = addUnique(plist.UISupportedExternalAccessoryProtocols, protocols);
    return cfg;
  });
};
