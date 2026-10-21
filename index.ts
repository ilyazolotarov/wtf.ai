// The app's entry: Expo Router's, plus the wakes for a drive the app wasn't opened for (docs/VEHICLE-LINK-SPEC.md §11):
// Android's task, which runs without a screen, and iOS's relaunch on the way.
import "expo-router/entry";
import { AppRegistry, Platform } from "react-native";

import SensorCaptureModule from "./modules/sensor-capture/src/SensorCaptureModule";
import VehicleLinkModule from "./modules/vehicle-link/src/VehicleLinkModule";
import { launchedOnTheWay } from "@/services/on-the-way";
import { WAKE_TASK } from "@/services/vehicle-wake";
import { iosDriveWake, vehicleWakeTask } from "@/services/vehicle-wake-task";

AppRegistry.registerHeadlessTask(WAKE_TASK, () => (data) => vehicleWakeTask(data as { how?: string } | undefined));

if (Platform.OS === "ios" && launchedOnTheWay(SensorCaptureModule.launchInfo(), VehicleLinkModule.nowUs())) {
  void iosDriveWake();
}
