package ai.wtf.vehiclelink

import ai.wtf.vehiclelink.logic.ProfileSpec
import android.Manifest
import android.os.Build
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

// Thin transport for ELM327 adapters on Android (docs/ANDROID-SPEC.md §3 C); same JS contract as the iOS module,
// with a `spp` transport (Classic Bluetooth serial) in place of MFi.

class GattProfileRecord : Record {
  @Field var id: String = ""
  @Field var service: String = ""
  @Field var notify: String? = null
  @Field var write: String? = null
}

class ConnectOptions : Record {
  @Field var id: String = ""
  @Field var transport: String = "ble"
  @Field var profiles: List<GattProfileRecord> = emptyList()

  /** UART remembered from a previous connection: [service, notify, write]. */
  @Field var preferred: List<String>? = null

  /** 0 = no timeout (pending connect, used for reconnects). */
  @Field var timeoutMs: Double = 15000.0
}

class VehicleLinkModule : Module() {
  private var core: LinkCore? = null

  private fun core(): LinkCore {
    core?.let { return it }
    val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
    return LinkCore(context) { name, body -> sendEvent(name, body) }.also { core = it }
  }

  /** The system dialog is shown at most once per process: a denial must not turn into a prompt on every foreground. */
  private var askedForPermissions = false

  /** Android 12+ asks for the two Bluetooth permissions; before that scanning needs location. */
  private fun ensurePermissions(done: (Boolean) -> Unit) {
    val core = core()
    if (core.hasConnectPermission() && core.hasScanPermission()) return done(true)
    if (askedForPermissions) return done(false)
    askedForPermissions = true
    val manager = appContext.permissions ?: return done(false)
    val wanted = if (Build.VERSION.SDK_INT >= 31) {
      arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
    } else {
      arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }
    manager.askForPermissions({ result -> done(wanted.all { result[it]?.status == PermissionsStatus.GRANTED }) }, *wanted)
  }

  override fun definition() = ModuleDefinition {
    Name("VehicleLink")

    Events("onScanBatch", "onMfiChange", "onLinkState", "onUnsolicited", "onBluetoothState")

    OnDestroy {
      core?.shutdown()
      core = null
    }

    Function("nowUs") { LinkCore.nowUs() }

    Function("getBluetoothState") { core().bluetoothState() }

    // The first call on Android shows the Bluetooth permission dialog; auto-connect checks the state first and skips it.
    AsyncFunction("initialize") { _: String?, promise: Promise ->
      if (core().bluetoothState() == "unsupported") {
        promise.resolve("unsupported") // no adapter (an emulator, a tablet): nothing to ask permission for
      } else {
        ensurePermissions { granted ->
          if (!granted) promise.resolve("unauthorized") else core().initialize(promise)
        }
      }
    }

    Function("startScan") { _: List<String> -> core().startScan() }

    Function("stopScan") { core?.stopScan() }

    // MFi is an iOS accessory framework: nothing to list or pick on Android.
    Function("getMfiAccessories") { emptyList<Map<String, Any?>>() }

    AsyncFunction("showMfiPicker") { _: String?, promise: Promise ->
      promise.reject("unsupported", "MFi accessories do not exist on Android; pair the adapter in the system Bluetooth settings", null)
    }

    AsyncFunction("connect") { options: ConnectOptions, promise: Promise ->
      val request = ConnectRequest(
        id = options.id,
        transport = options.transport,
        profiles = options.profiles.map { ProfileSpec(it.id, it.service, it.notify, it.write) },
        preferred = options.preferred,
        timeoutMs = options.timeoutMs.toLong(),
      )
      core().connect(request, promise)
    }

    AsyncFunction("disconnect") { promise: Promise -> core().disconnect(promise) }

    AsyncFunction("transact") { command: String, timeoutMs: Double, promise: Promise -> core().transact(command, timeoutMs, promise) }

    AsyncFunction("writeRaw") { text: String, promise: Promise -> core().writeRaw(text, promise) }
  }
}
