// swift-tools-version:5.9
// Unit tests for the Foundation-only logic of the local Expo modules (modules/*/ios/Logic).
// The modules themselves (CoreBluetooth, CoreLocation, ExpoModulesCore) only compile in the
// CI iOS build; this package runs anywhere Swift does: `swift test` (CI: Linux job).
import PackageDescription

let package = Package(
  name: "WtfNativeLogic",
  targets: [
    .target(name: "VehicleLinkLogic", path: "modules/vehicle-link/ios/Logic"),
    .target(name: "SensorCaptureLogic", path: "modules/sensor-capture/ios/Logic"),
    .testTarget(
      name: "VehicleLinkLogicTests",
      dependencies: ["VehicleLinkLogic"],
      path: "native-tests/VehicleLinkLogicTests"
    ),
    .testTarget(
      name: "SensorCaptureLogicTests",
      dependencies: ["SensorCaptureLogic"],
      path: "native-tests/SensorCaptureLogicTests"
    ),
  ],
  swiftLanguageVersions: [.v5]
)
