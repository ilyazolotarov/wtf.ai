package ai.wtf.sensorcapture

import ai.wtf.sensorcapture.logic.SensorLogic
import android.Manifest
import com.facebook.react.bridge.ReactContext
import expo.modules.interfaces.permissions.PermissionsResponse
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

// GNSS + IMU capture for the trip logger on Android (docs/ANDROID-SPEC.md §3 B); same JS contract as the iOS module.

class ImuOptions : Record {
  @Field var rateHz: Double = 100.0
  @Field var raw: Boolean = false
  @Field var batchMs: Double = 100.0

  /** Raw magnetometer rate; 0 = off. Logged only, never used for navigation (SPEC §2). */
  @Field var magRateHz: Double = 20.0
}

class SensorCaptureModule : Module() {
  private var capture: SensorCapture? = null

  private val fine = Manifest.permission.ACCESS_FINE_LOCATION
  private val coarse = Manifest.permission.ACCESS_COARSE_LOCATION

  private fun capture(): SensorCapture {
    capture?.let { return it }
    val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
    return SensorCapture(context) { name, body -> sendEvent(name, body) }.also { capture = it }
  }

  /** `{ location, accuracy }` from the permission manager's answer (ask = show the system dialog when needed). */
  private fun permissions(ask: Boolean, done: (Map<String, Any>) -> Unit, promise: Promise) {
    val manager = appContext.permissions ?: return promise.reject("no-permissions", "permissions module missing", null)
    val listener = PermissionsResponseListener { result: Map<String, PermissionsResponse> ->
      val f = result[fine]
      val c = result[coarse]
      val (location, accuracy) = SensorLogic.permissionState(
        fineGranted = f?.status == PermissionsStatus.GRANTED,
        coarseGranted = c?.status == PermissionsStatus.GRANTED,
        canAskAgain = (f?.canAskAgain ?: true) && (c?.canAskAgain ?: true),
        asked = (f?.status ?: PermissionsStatus.UNDETERMINED) != PermissionsStatus.UNDETERMINED,
      )
      val state = mapOf("location" to location, "accuracy" to accuracy)
      if (ask) sendEvent("onAuthorization", state)
      done(state)
    }
    if (ask) manager.askForPermissions(listener, fine, coarse) else manager.getPermissions(listener, fine, coarse)
  }

  override fun definition() = ModuleDefinition {
    Name("SensorCapture")

    Events("onGnss", "onGnssError", "onImuBatch", "onAuthorization", "onMemoryWarning")

    OnCreate {
      AppHealth.onMemoryWarning = { level -> sendEvent("onMemoryWarning", mapOf("level" to level)) }
    }

    OnDestroy {
      AppHealth.onMemoryWarning = null
      capture?.shutdown()
      capture = null
    }

    Function("nowUs") { SensorCapture.nowUs() }

    AsyncFunction("getPermissions") { promise: Promise ->
      permissions(false, { promise.resolve(it) }, promise)
    }

    AsyncFunction("requestLocationPermission") { promise: Promise ->
      permissions(true, { promise.resolve(it["location"]) }, promise)
    }

    AsyncFunction("startGnss") { capture().startGnss() }

    AsyncFunction("stopGnss") { capture?.stopGnss() }

    AsyncFunction("startImu") { options: ImuOptions ->
      capture().startImu(options.rateHz, options.raw, options.batchMs, options.magRateHz)
    }

    AsyncFunction("stopImu") { capture?.stopImu() }

    // Foreground service for a trip in progress (TripService); Android only, absent on iOS. With it, the JS timers keep
    // running while another app is in front (JsKeepAlive).
    AsyncFunction("startTripService") { title: String, text: String, channelName: String, gpsLabel: String? ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val started = TripService.canStart(context) && TripService.start(context, title, text, channelName, gpsLabel)
      if (started) (context as? ReactContext)?.let { JsKeepAlive.start(it) }
      started
    }

    AsyncFunction("stopTripService") {
      appContext.reactContext?.let { TripService.stop(it) }
      JsKeepAlive.stop()
    }

    // The running service's notification, with new words; false when it isn't running (yet).
    Function("updateTripService") { title: String, text: String, channelName: String ->
      val context = appContext.reactContext ?: return@Function false
      TripService.update(context, title, text, channelName)
    }

    Function("isTripServiceRunning") { TripService.running }

    Function("tripServiceHasLocation") { TripService.withLocation }

    // The app process (TRIP-LOGGER-SPEC §4.4).
    Function("launchInfo") { AppHealth.launchInfo() }

    AsyncFunction("processStats") { appState: String, context: String ->
      val ctx = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      AppHealth.stats(ctx, appState, context)
    }

    Function("takeHealthReports") { AppHealth.takeReports() }

    // iOS's background location session; Android keeps a trip alive with TripService instead.
    AsyncFunction("setLocationSession") { _: Boolean -> false }

    // Developer: ends the process as Android would under memory pressure (not a swipe).
    Function("simulateSystemKill") { android.os.Process.killProcess(android.os.Process.myPid()) }
  }
}
