import { useEffect, useState } from "react";
import { Platform } from "react-native";

import SensorCaptureModule from "../../../modules/sensor-capture/src/SensorCaptureModule";

/**
 * The screen's turn from the device's natural orientation, degrees counter-clockwise: 0, 90, 180 or 270. The app asks
 * for portrait, but Android 16 ignores that on large screens: a tablet turns the window itself, and its natural
 * orientation is landscape. The sensors stay in the device's frame, so the map turn and the compass add this. Always 0
 * on iOS (an iPhone app keeps portrait, on an iPad too) and in builds before it.
 */
export function useDisplayRotation(): number {
  const [degrees, setDegrees] = useState(() =>
    Platform.OS === "android" ? (SensorCaptureModule.displayRotation?.() ?? 0) : 0,
  );

  useEffect(() => {
    if (Platform.OS !== "android" || !SensorCaptureModule.displayRotation) return;
    const subscription = SensorCaptureModule.addListener("onDisplayRotation", (e) => setDegrees(e.degrees));
    return () => subscription.remove();
  }, []);

  return degrees;
}
