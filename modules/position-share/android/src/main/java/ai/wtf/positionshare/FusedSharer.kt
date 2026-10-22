package ai.wtf.positionshare

import ai.wtf.positionshare.logic.MockFix
import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.util.Log
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationServices
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks

// Google Play services' fused location provider in mock mode (docs/ANDROID-SPEC.md §8). While it is on, every app
// that gets its location from it (Google Maps) gets only the fixes set here. The platform's GPS provider is untouched,
// so wtf.ai's own GNSS (sensor-capture reads LocationManager) stays the real one; apps reading that provider (Waze)
// need GpsTakeover. Nothing is invented: one published fix is one location, and when none comes the other apps get none.
class FusedSharer(context: Context, private val onError: (code: String, message: String) -> Unit) {
  companion object {
    private const val TAG = "WtfPositionShare"
    private const val PROVIDER = "fused"
  }

  private val client: FusedLocationProviderClient = LocationServices.getFusedLocationProviderClient(context)

  /** Mode changes run one after another, in the order asked: the stop at launch, then a trip's start. */
  private var modeQueue: Task<Void> = Tasks.forResult<Void>(null)

  @Volatile
  var active = false
    private set

  private var published = 0

  /** A failed publish is reported once, not once a second, until one succeeds again. */
  @Volatile
  private var failing = false

  fun start(done: (Exception?) -> Unit) {
    modeQueue = modeQueue.continueWithTask { client.setMockMode(true) }
    modeQueue.addOnCompleteListener { t ->
      active = t.isSuccessful
      Log.i(TAG, "mock mode on: ${t.isSuccessful}${t.exception?.let { " ${it.javaClass.simpleName}: ${it.message}" } ?: ""}")
      done(t.exception)
    }
  }

  fun stop(done: ((Exception?) -> Unit)? = null) {
    active = false
    modeQueue = modeQueue.continueWithTask { client.setMockMode(false) }
    modeQueue.addOnCompleteListener { t ->
      Log.i(TAG, "mock mode off: ${t.isSuccessful}")
      done?.invoke(t.exception)
    }
  }

  fun publish(fix: MockFix, timeMs: Long, elapsedNs: Long) {
    if (!active) return
    client.setMockLocation(sharedLocation(PROVIDER, fix, timeMs, elapsedNs))
      .addOnSuccessListener {
        failing = false
        // Logcat evidence for the emulator check and testers' reports (no coordinates).
        if (published++ % 60 == 0) Log.i(TAG, "fix #$published acc=${fix.accuracyM} speed=${fix.speedMps} bearing=${fix.bearingDeg != null}")
      }
      .addOnFailureListener { e ->
        if (failing) return@addOnFailureListener
        failing = true
        Log.w(TAG, "setMockLocation failed: ${e.javaClass.simpleName}: ${e.message}")
        onError("publish-failed", e.message ?: e.javaClass.simpleName)
      }
  }

  /** The fused provider's last location: while sharing, the last fix set here (the setup page's check). */
  @SuppressLint("MissingPermission")
  fun readBack(done: (Location?) -> Unit) {
    try {
      client.lastLocation.addOnCompleteListener { t -> done(if (t.isSuccessful) t.result else null) }
    } catch (e: SecurityException) {
      done(null)
    }
  }
}
