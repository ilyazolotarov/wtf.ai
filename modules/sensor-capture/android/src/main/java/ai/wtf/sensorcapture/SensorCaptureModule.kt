package ai.wtf.sensorcapture

import android.os.SystemClock
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Placeholder until GNSS + IMU capture lands (docs/ANDROID-SPEC.md, milestone M2): same JS contract as the iOS module,
// reports "unavailable" so the app boots and the navigator simply gets no sensor data.
class SensorCaptureModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SensorCapture")

    Events("onGnss", "onGnssError", "onImuBatch", "onAuthorization")

    Function("nowUs") { SystemClock.elapsedRealtimeNanos() / 1000.0 }

    AsyncFunction("getPermissions") { mapOf("location" to "denied", "accuracy" to "reduced") }
    AsyncFunction("requestLocationPermission") { "denied" }
    AsyncFunction("startGnss") { false }
    AsyncFunction("stopGnss") { }
    AsyncFunction("startImu") { _: Map<String, Any?> -> false }
    AsyncFunction("stopImu") { }
  }
}
