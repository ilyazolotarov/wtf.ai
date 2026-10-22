package ai.wtf.positionshare.logic

import kotlin.math.PI

/** What the fused provider gets as one location: Android's units (degrees, Float accuracies). */
data class MockFix(
  val latitude: Double,
  val longitude: Double,
  val accuracyM: Float,
  val speedMps: Float?,
  val bearingDeg: Float?,
  val bearingAccuracyDeg: Float?,
)

// The JS payload (SI: radians, m/s) → the fields of an android.location.Location (docs/ANDROID-SPEC.md §8). Plain
// Kotlin, tested on the JVM in native-tests-android/.
object MockFixLogic {
  /** Heading doubt is capped here: Android reads a bearing accuracy as ± degrees, and over 180 says nothing. */
  private const val MAX_BEARING_ACCURACY_DEG = 180f

  /**
   * The fix for the JS payload; null when it can't be a position (NaN or out of range: nothing goes to other apps
   * rather than a wrong place). Optional fields that are missing or not finite are left out.
   */
  fun fromPayload(
    lat: Double,
    lon: Double,
    accuracyM: Double,
    speedMps: Double?,
    courseRad: Double?,
    courseAccRad: Double?,
  ): MockFix? {
    if (!lat.isFinite() || !lon.isFinite() || lat !in -90.0..90.0 || lon !in -180.0..180.0) return null
    if (!accuracyM.isFinite() || accuracyM <= 0) return null
    val speed = speedMps?.takeIf { it.isFinite() }?.let { maxOf(0.0, it).toFloat() }
    val bearing = courseRad?.takeIf { it.isFinite() }?.let { bearingDeg(it) }
    val bearingAcc =
      if (bearing == null) null
      else courseAccRad?.takeIf { it.isFinite() && it >= 0 }?.let { minOf(MAX_BEARING_ACCURACY_DEG, Math.toDegrees(it).toFloat()) }
    return MockFix(lat, lon, accuracyM.toFloat(), speed, bearing, bearingAcc)
  }

  /** A course (radians clockwise from north, any turn) as Android's bearing: degrees in [0, 360). */
  fun bearingDeg(courseRad: Double): Float {
    val turn = 2 * PI
    val r = ((courseRad % turn) + turn) % turn
    val deg = Math.toDegrees(r).toFloat()
    return if (deg >= 360f) 0f else deg
  }

  /**
   * The wall-clock time of the next fix: never at or before the previous one. The fused provider expects increasing
   * times, and a clock change while driving must not run them back.
   */
  fun wallClockMs(nowMs: Long, previousMs: Long?): Long =
    if (previousMs != null && nowMs <= previousMs) previousMs + 1 else nowMs
}
