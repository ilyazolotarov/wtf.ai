package ai.wtf.sensorcapture.logic

// Pure mapping/batching logic for the Android SensorCaptureModule (docs/ANDROID-SPEC.md §2, §3 B).
// No android.* imports: unit-tested on a plain JVM (native-tests-android/). Payloads match the iOS module
// (modules/sensor-capture/ios/Logic/SensorLogic.swift), so the TypeScript side is the same on both platforms.

/** A location fix as plain values; `null` = the platform says the field is not available (Android `has*()` false). */
data class LocationSample(
  val latitude: Double,
  val longitude: Double,
  /** Android's `altitude` is height above the WGS84 ellipsoid. */
  val altitudeEllipsoid: Double?,
  /** Mean sea level altitude (Android 14+), when known. */
  val altitudeMsl: Double?,
  val horizontalAccuracy: Double?,
  val verticalAccuracy: Double?,
  val speed: Double?,
  val speedAccuracy: Double?,
  /** Degrees. */
  val bearing: Double?,
  /** Degrees. */
  val bearingAccuracy: Double?,
  /** When the fix was made on the `SystemClock.elapsedRealtimeNanos()` clock, in µs. */
  val elapsedRealtimeUs: Double,
  /** Fix time, UTC milliseconds since 1970. */
  val utcMillis: Long,
  val simulated: Boolean,
)

object SensorLogic {
  const val STANDARD_GRAVITY = 9.80665

  /**
   * onGnss event payload. Android stamps fixes on the monotonic clock itself, so no wall-clock mapping is needed
   * (unlike iOS). Fields the platform did not provide are omitted (JS turns them into NaN).
   */
  fun gnssEvent(s: LocationSample, nowUs: Double): Map<String, Any> {
    val e = mutableMapOf<String, Any>(
      "tUs" to s.elapsedRealtimeUs,
      "utcUs" to s.utcMillis * 1000.0,
      "deliveryDelayUs" to maxOf(0.0, nowUs - s.elapsedRealtimeUs),
      "lat" to s.latitude,
      "lon" to s.longitude,
      "simulated" to s.simulated,
      "fromAccessory" to false,
    )
    s.horizontalAccuracy?.let { e["hAcc"] = it }
    s.verticalAccuracy?.let { e["vAcc"] = it }
    s.altitudeMsl?.let { e["altMsl"] = it }
    s.altitudeEllipsoid?.let { e["altEllipsoid"] = it }
    s.speed?.let { e["speed"] = it }
    s.speedAccuracy?.let { e["speedAcc"] = it }
    s.bearing?.let { e["courseRad"] = Math.toRadians(it) }
    s.bearingAccuracy?.let { e["courseAccRad"] = Math.toRadians(it) }
    return e
  }

  /**
   * One `motion` row (14 values) in the iOS convention the TS navigator assumes: t µs, rotation rate rad/s,
   * user acceleration m/s², **gravity as the true gravity direction** (flat on a table: z = −9.81), attitude
   * quaternion w x y z. Android's TYPE_GRAVITY points the other way (flat: z = +9.81), so it is negated here.
   */
  fun motionRow(
    tUs: Double,
    gyro: DoubleArray,
    linearAccel: DoubleArray,
    androidGravity: DoubleArray,
    quaternion: DoubleArray,
  ): DoubleArray = doubleArrayOf(
    tUs,
    gyro[0], gyro[1], gyro[2],
    linearAccel[0], linearAccel[1], linearAccel[2],
    -androidGravity[0], -androidGravity[1], -androidGravity[2],
    quaternion[0], quaternion[1], quaternion[2], quaternion[3],
  )

  /** Raw gyro row (4 values): t µs, x, y, z rad/s. */
  fun gyroRow(tUs: Double, x: Double, y: Double, z: Double) = doubleArrayOf(tUs, x, y, z)

  /** Raw accelerometer row (4 values): t µs, x, y, z m/s² (Android already reports m/s²). */
  fun accelRow(tUs: Double, x: Double, y: Double, z: Double) = doubleArrayOf(tUs, x, y, z)

  /** Raw magnetometer row (4 values): t µs, x, y, z µT. */
  fun magRow(tUs: Double, x: Double, y: Double, z: Double) = doubleArrayOf(tUs, x, y, z)

  /**
   * Android's rotation-vector sensors give [x, y, z, w] (w = cos θ/2 in values[3]); the log stores w x y z.
   * Only logged, never navigated with (the compass uses gravity + raw magnetometer), so the world/device
   * direction of the rotation is not normalized.
   */
  fun quaternionFromRotationVector(v: FloatArray): DoubleArray {
    val x = v[0].toDouble()
    val y = v[1].toDouble()
    val z = v[2].toDouble()
    val w = if (v.size > 3) v[3].toDouble() else Math.sqrt(maxOf(0.0, 1 - x * x - y * y - z * z))
    return doubleArrayOf(w, x, y, z)
  }

  fun clampRateHz(hz: Double): Double = maxOf(1.0, minOf(200.0, hz))

  /** Sensor sampling period in µs for `SensorManager.registerListener`. */
  fun samplingPeriodUs(hz: Double): Int = (1_000_000.0 / clampRateHz(hz)).toInt()

  /** Location permission as the JS contract names it. Coarse only = reduced accuracy (iOS "approximate"). */
  fun permissionState(fineGranted: Boolean, coarseGranted: Boolean, canAskAgain: Boolean, asked: Boolean): Pair<String, String> {
    val accuracy = if (fineGranted) "full" else "reduced"
    val location = when {
      fineGranted || coarseGranted -> "whenInUse"
      !asked -> "notDetermined"
      canAskAgain -> "notDetermined"
      else -> "denied"
    }
    return location to accuracy
  }
}

/**
 * Builds `motion` rows from separate Android sensors: a row per gyro event, with the latest linear acceleration,
 * gravity and rotation vector (iOS CMDeviceMotion delivers all of them fused at one instant).
 */
class MotionAssembler {
  companion object {
    const val GRAVITY_TAU_S = 1.0
  }

  private var linearAccel: DoubleArray? = null
  private var gravity: DoubleArray? = null
  private var quaternion: DoubleArray? = null

  /** Low-pass gravity estimate for phones without TYPE_GRAVITY / TYPE_LINEAR_ACCELERATION (and the emulator). */
  private var derivedGravity: DoubleArray? = null
  private var lastAccelUs: Double? = null

  fun onLinearAcceleration(x: Double, y: Double, z: Double) {
    linearAccel = doubleArrayOf(x, y, z)
  }

  /**
   * Accelerometer sample (m/s2, Android sign: flat on a table z = +9.81) for the derived mode: gravity is its low-pass
   * (time constant [GRAVITY_TAU_S]), linear acceleration the remainder. Use instead of the two dedicated sensors.
   */
  fun onAccelerometer(tUs: Double, x: Double, y: Double, z: Double) {
    val a = doubleArrayOf(x, y, z)
    val prev = derivedGravity
    val last = lastAccelUs
    lastAccelUs = tUs
    val g = if (prev == null || last == null) {
      a
    } else {
      val k = minOf(1.0, maxOf(0.0, (tUs - last) / 1e6 / GRAVITY_TAU_S))
      doubleArrayOf(prev[0] + (x - prev[0]) * k, prev[1] + (y - prev[1]) * k, prev[2] + (z - prev[2]) * k)
    }
    derivedGravity = g
    gravity = g
    linearAccel = doubleArrayOf(x - g[0], y - g[1], z - g[2])
  }

  fun onGravity(x: Double, y: Double, z: Double) {
    gravity = doubleArrayOf(x, y, z)
  }

  fun onRotationVector(v: FloatArray) {
    quaternion = SensorLogic.quaternionFromRotationVector(v)
  }

  /** The row for a gyro sample, or null until the other sensors have reported at least once. */
  fun onGyro(tUs: Double, x: Double, y: Double, z: Double): DoubleArray? {
    val g = gravity ?: return null
    val a = linearAccel ?: doubleArrayOf(0.0, 0.0, 0.0)
    val q = quaternion ?: doubleArrayOf(1.0, 0.0, 0.0, 0.0)
    return SensorLogic.motionRow(tUs, doubleArrayOf(x, y, z), a, g, q)
  }
}

/** Collects flat IMU rows per stream ("m", "g", "a", "f" magnetic field) and emits a batch every `intervalUs`. */
class ImuBatcher(intervalMs: Double, nowUs: Double) {
  companion object {
    val STREAMS = listOf("m", "g", "a", "f")

    /** Event payload keys used by JS (`motion`, `gyro`, `accel`, `mag`). */
    fun payload(batch: Map<String, List<Double>>): Map<String, Any> = mapOf(
      "motion" to (batch["m"] ?: emptyList()),
      "gyro" to (batch["g"] ?: emptyList()),
      "accel" to (batch["a"] ?: emptyList()),
      "mag" to (batch["f"] ?: emptyList()),
    )
  }

  val intervalUs: Double = maxOf(20.0, intervalMs) * 1000
  var startUs: Double = nowUs
    private set
  private var rows: MutableMap<String, MutableList<Double>> = fresh()

  private fun fresh() = STREAMS.associateWith { mutableListOf<Double>() }.toMutableMap()

  val pending: Map<String, List<Double>> get() = rows

  /** Append a row; returns a batch when the interval has elapsed. */
  fun append(stream: String, row: DoubleArray, nowUs: Double): Map<String, List<Double>>? {
    rows.getOrPut(stream) { mutableListOf() }.addAll(row.toList())
    return if (nowUs - startUs >= intervalUs) flush(nowUs) else null
  }

  /** Returns the pending rows (null if empty) and starts a new batch. */
  fun flush(nowUs: Double): Map<String, List<Double>>? {
    val out = rows
    rows = fresh()
    startUs = nowUs
    return if (STREAMS.all { out[it].isNullOrEmpty() }) null else out
  }
}
