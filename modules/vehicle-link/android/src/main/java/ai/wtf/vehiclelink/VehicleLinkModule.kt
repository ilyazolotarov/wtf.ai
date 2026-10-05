package ai.wtf.vehiclelink

import android.os.SystemClock
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Placeholder until the BLE + Classic SPP transports land (docs/ANDROID-SPEC.md, milestones M3): same JS contract as
// the iOS module, reports Bluetooth "unsupported" so the app boots and offers the emulator adapter only.
class VehicleLinkModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("VehicleLink")

    Events("onScanBatch", "onMfiChange", "onLinkState", "onUnsolicited", "onBluetoothState")

    Function("nowUs") { SystemClock.elapsedRealtimeNanos() / 1000.0 }
    Function("getBluetoothState") { "unsupported" }
    AsyncFunction("initialize") { _: String? -> "unsupported" }
    Function("startScan") { _: List<String> -> }
    Function("stopScan") { }
    Function("getMfiAccessories") { emptyList<Map<String, Any?>>() }
    AsyncFunction("showMfiPicker") { _: String?, promise: Promise -> promise.reject("unsupported", "MFi is iOS-only", null) }
    AsyncFunction("connect") { _: Map<String, Any?>, promise: Promise -> promise.reject("bluetooth-off", "Bluetooth transport not built yet", null) }
    AsyncFunction("disconnect") { }
    AsyncFunction("transact") { _: String, _: Double, promise: Promise -> promise.reject("not-connected", "not connected", null) }
    AsyncFunction("writeRaw") { _: String, promise: Promise -> promise.reject("not-connected", "not connected", null) }
  }
}
