package ai.wtf.positionshare

import ai.wtf.positionshare.logic.MockFix
import android.content.Context
import android.location.Criteria
import android.location.LocationManager
import android.util.Log

// The platform `gps` provider replaced by a test provider (docs/ANDROID-SPEC.md §8), for apps that read it directly
// (Waze). While it is in, Android stops the real GPS provider: wtf.ai's own satellite fixes stop too (those it then
// gets are the mock ones, flagged and dropped). So JS takes it only while GPS isn't trusted, and lets go for probes.
class GpsTakeover(context: Context, private val onError: (code: String, message: String) -> Unit) {
  companion object {
    private const val TAG = "WtfPositionShare"
    private const val GPS = LocationManager.GPS_PROVIDER
  }

  private val manager = context.getSystemService(LocationManager::class.java)

  @Volatile
  var active = false
    private set

  @Volatile
  private var failing = false

  /** Puts the test provider in; the reason it couldn't, or null. */
  fun start(): String? {
    if (active) return null
    return try {
      removeQuietly()
      @Suppress("DEPRECATION")
      manager.addTestProvider(GPS, false, true, false, false, true, true, true, Criteria.POWER_HIGH, Criteria.ACCURACY_FINE)
      manager.setTestProviderEnabled(GPS, true)
      active = true
      failing = false
      Log.i(TAG, "gps taken over")
      null
    } catch (e: Exception) {
      Log.w(TAG, "gps takeover failed: ${e.javaClass.simpleName}: ${e.message}")
      removeQuietly()
      e.message ?: e.javaClass.simpleName
    }
  }

  /** Takes the test provider out: the real GPS provider comes back for every app. Safe when none is in. */
  fun stop() {
    val was = active
    active = false
    removeQuietly()
    if (was) Log.i(TAG, "gps given back")
  }

  fun publish(fix: MockFix, timeMs: Long, elapsedNs: Long) {
    if (!active) return
    try {
      manager.setTestProviderLocation(GPS, sharedLocation(GPS, fix, timeMs, elapsedNs))
      failing = false
    } catch (e: Exception) {
      if (failing) return
      failing = true
      Log.w(TAG, "setTestProviderLocation failed: ${e.javaClass.simpleName}: ${e.message}")
      onError("gps-failed", e.message ?: e.javaClass.simpleName)
    }
  }

  private fun removeQuietly() {
    try {
      manager.removeTestProvider(GPS)
    } catch (e: Exception) {
      // None in: nothing to take out.
    }
  }
}
