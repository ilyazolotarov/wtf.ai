// The app's entry: Expo Router's, plus the wakes for a drive the app wasn't opened for (docs/VEHICLE-LINK-SPEC.md §11):
// Android's task, which runs without a screen, and iOS's relaunch on the way. On Android also the car's screen
// (docs/ANDROID-AUTO-SPEC.md): its session's task, and the map's root that modules/android-auto mounts there.
import "expo-router/entry";
import { AppRegistry, Platform } from "react-native";

import SensorCaptureModule from "./modules/sensor-capture/src/SensorCaptureModule";
import VehicleLinkModule from "./modules/vehicle-link/src/VehicleLinkModule";
import { CarMapRoot } from "@/components/car-screen/car-map-root";
import { CAR_SESSION_TASK, carSessionTask } from "@/components/car-screen/car-session-task";
import { launchedOnTheWay } from "@/services/on-the-way";
import { WAKE_TASK } from "@/services/vehicle-wake";
import { iosDriveWake, vehicleWakeTask } from "@/services/vehicle-wake-task";

AppRegistry.registerHeadlessTask(WAKE_TASK, () => (data) => vehicleWakeTask(data as { how?: string } | undefined));

if (Platform.OS === "android") {
  AppRegistry.registerHeadlessTask(CAR_SESSION_TASK, () => carSessionTask);
  AppRegistry.registerComponent("CarMap", () => CarMapRoot);
}

if (Platform.OS === "ios" && launchedOnTheWay(SensorCaptureModule.launchInfo(), VehicleLinkModule.nowUs())) {
  void iosDriveWake();
}
