package ai.wtf.positionshare

import ai.wtf.positionshare.logic.MockFix
import android.location.Location

/** One shared fix as a `Location` of `provider`, stamped `timeMs` (wall clock) and `elapsedNs` (uptime). */
fun sharedLocation(provider: String, fix: MockFix, timeMs: Long, elapsedNs: Long): Location = Location(provider).apply {
  latitude = fix.latitude
  longitude = fix.longitude
  accuracy = fix.accuracyM
  time = timeMs
  elapsedRealtimeNanos = elapsedNs
  fix.speedMps?.let { speed = it }
  fix.bearingDeg?.let { bearing = it }
  fix.bearingAccuracyDeg?.let { bearingAccuracyDegrees = it }
}
