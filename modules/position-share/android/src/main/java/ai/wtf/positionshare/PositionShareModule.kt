package ai.wtf.positionshare

import ai.wtf.positionshare.logic.MockFixLogic
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

// The car's position for other navigators (docs/ANDROID-SPEC.md §8): what the map draws, set as the fused location
// provider's mock location while a trip records. Android only; the policy (what to share, when) is TypeScript.

class SharedFixRecord : Record {
  @Field var lat: Double = Double.NaN
  @Field var lon: Double = Double.NaN
  @Field var accuracyM: Double = Double.NaN
  @Field var speedMps: Double? = null
  @Field var courseRad: Double? = null
  @Field var courseAccRad: Double? = null
}

class PositionShareModule : Module() {
  private var sharer: FusedSharer? = null
  private var gps: GpsTakeover? = null

  /** The last fix's wall-clock time: the next one is later, whatever the phone's clock does. */
  private var lastTimeMs: Long? = null

  private fun context(): Context = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private fun report(code: String, message: String) {
    sendEvent("onShareError", mapOf("code" to code, "message" to message))
  }

  private fun sharer(): FusedSharer = sharer ?: FusedSharer(context(), ::report).also { sharer = it }

  private fun gps(): GpsTakeover = gps ?: GpsTakeover(context(), ::report).also { gps = it }

  override fun definition() = ModuleDefinition {
    Name("PositionShare")

    Events("onShareError")

    OnCreate {
      // A process killed while sharing leaves the fused provider in mock mode (and maybe the gps test provider in),
      // every navigator frozen at the last fix until it is turned off: turned off at launch. A trip still recording
      // turns it on again.
      val context = appContext.reactContext
      if (context != null && ShareSetup.isMockLocationApp(context)) {
        gps().stop()
        if (ShareSetup.playServices(context)) sharer().stop()
      }
    }

    OnDestroy {
      gps?.stop()
      gps = null
      sharer?.stop()
      sharer = null
    }

    Function("getSetup") { ShareSetup.state(context()) }

    AsyncFunction("start") { promise: Promise ->
      val context = context()
      if (!ShareSetup.playServices(context)) {
        return@AsyncFunction promise.reject("no-play-services", "Google Play services are missing", null)
      }
      if (!ShareSetup.isMockLocationApp(context)) {
        return@AsyncFunction promise.reject("not-mock-app", "wtf.ai is not the mock location app", null)
      }
      sharer().start { e ->
        if (e == null) promise.resolve(null)
        else promise.reject("start-failed", e.message ?: e.javaClass.simpleName, e)
      }
    }

    // One fix, as the location now of the fused provider and, while taken over, the gps provider; false when not
    // sharing or the fix can't be a position.
    Function("publish") { fix: SharedFixRecord ->
      val s = sharer ?: return@Function false
      if (!s.active) return@Function false
      val f = MockFixLogic.fromPayload(fix.lat, fix.lon, fix.accuracyM, fix.speedMps, fix.courseRad, fix.courseAccRad)
        ?: return@Function false
      val time = MockFixLogic.wallClockMs(System.currentTimeMillis(), lastTimeMs)
      lastTimeMs = time
      // The navigator draws the dot where the car is now (extrapolated), so the fix is stamped on arrival.
      val elapsed = SystemClock.elapsedRealtimeNanos()
      s.publish(f, time, elapsed)
      gps?.publish(f, time, elapsed)
      true
    }

    // The platform gps provider replaced (true) or given back (false); null when done, else why it couldn't.
    Function("setGpsTakeover") { on: Boolean ->
      if (!on) {
        gps?.stop()
        return@Function null
      }
      if (!ShareSetup.isMockLocationApp(context())) return@Function "wtf.ai is not the mock location app"
      gps().start()
    }

    AsyncFunction("stop") { promise: Promise ->
      gps?.stop()
      lastTimeMs = null
      val s = sharer ?: return@AsyncFunction promise.resolve(null)
      s.stop { promise.resolve(null) }
    }

    AsyncFunction("readBack") { promise: Promise ->
      sharer().readBack { location ->
        if (location == null) return@readBack promise.resolve(null)
        promise.resolve(
          mapOf(
            "lat" to location.latitude,
            "lon" to location.longitude,
            "accuracyM" to location.accuracy.toDouble(),
            "mock" to if (Build.VERSION.SDK_INT >= 31) location.isMock else @Suppress("DEPRECATION") location.isFromMockProvider,
            "ageMs" to (SystemClock.elapsedRealtimeNanos() - location.elapsedRealtimeNanos) / 1e6,
          ),
        )
      }
    }

    // Opens one of the navigators the setup page names; false when it isn't installed.
    Function("openApp") { packageName: String ->
      if (packageName !in ShareSetup.NAVIGATORS) return@Function false
      val context = appContext.reactContext ?: return@Function false
      val intent = context.packageManager.getLaunchIntentForPackage(packageName) ?: return@Function false
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        (appContext.currentActivity ?: context).startActivity(intent)
        true
      } catch (e: Exception) {
        false
      }
    }
  }
}
