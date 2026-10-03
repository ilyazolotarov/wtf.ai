// Config plugin for modules/vehicle-link (docs/VEHICLE-LINK-SPEC.md §5.4).
// Never edit ios/ by hand; prebuild applies this.
const { withInfoPlist } = require("expo/config-plugins");

const DEFAULT_PROTOCOLS = ["com.obdlink", "com.vgatemall"];

function addUnique(list, values) {
  const out = Array.isArray(list) ? [...list] : [];
  for (const v of values) if (!out.includes(v)) out.push(v);
  return out;
}

module.exports = function withVehicleLink(config, props = {}) {
  const protocols = props.mfiProtocols ?? DEFAULT_PROTOCOLS;
  const bluetoothText =
    props.bluetoothPermission ?? "Allow $(PRODUCT_NAME) to connect to your OBD-II adapter to read vehicle speed.";
  return withInfoPlist(config, (cfg) => {
    const plist = cfg.modResults;
    plist.NSBluetoothAlwaysUsageDescription = plist.NSBluetoothAlwaysUsageDescription ?? bluetoothText;
    plist.UIBackgroundModes = addUnique(plist.UIBackgroundModes, ["bluetooth-central", "external-accessory"]);
    plist.UISupportedExternalAccessoryProtocols = addUnique(plist.UISupportedExternalAccessoryProtocols, protocols);
    return cfg;
  });
};
