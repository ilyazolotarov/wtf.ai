package ai.wtf.sensorcapture

import ai.wtf.sensorcapture.logic.ImuBatcher
import ai.wtf.sensorcapture.logic.LocationSample
import ai.wtf.sensorcapture.logic.MotionAssembler
import ai.wtf.sensorcapture.logic.SensorLogic
import android.annotation.SuppressLint
import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.util.Log

// GNSS + IMU capture for the trip logger on Android (docs/ANDROID-SPEC.md §3 B). Same events as the iOS module.
// Timestamps: SystemClock.elapsedRealtimeNanos() in µs, the clock that sensor events and Location fixes already use.
// Mapping and batching live in logic/ (plain Kotlin, unit-tested on the JVM).
class SensorCapture(private val context: Context, private val emit: (String, Map<String, Any?>) -> Unit) {
  companion object {
    private const val TAG = "WtfSensorCapture"

    fun nowUs(): Double = SystemClock.elapsedRealtimeNanos() / 1000.0
  }

  private val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
  private val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager

  // --- GNSS -----------------------------------------------------------------------------------------------------

  private var gnssRunning = false
  private var gnssFixes = 0

  // LocationListener's other callbacks are default methods only from API 30; older Android needs them implemented.
  private val locationListener = object : LocationListener {
    override fun onLocationChanged(location: Location) = emitFix(location)
    override fun onProviderEnabled(provider: String) {}
    override fun onProviderDisabled(provider: String) {
      emit("onGnssError", mapOf("message" to "location provider $provider disabled", "code" to 1))
    }

    @Deprecated("Never called on Android 12+")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
  }

  /**
   * Satellite fixes (`gps`: have speed and course) and coarse Wi-Fi/cell fixes (`network`: accuracy only), the same two
   * kinds iOS delivers under jamming. No Google Play services needed.
   */
  @SuppressLint("MissingPermission")
  fun startGnss(): Boolean {
    if (gnssRunning) return true
    var started = false
    try {
      if (locationManager.allProviders.contains(LocationManager.GPS_PROVIDER)) {
        locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 0L, 0f, locationListener, Looper.getMainLooper())
        started = true
      }
      if (locationManager.allProviders.contains(LocationManager.NETWORK_PROVIDER)) {
        locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 1000L, 0f, locationListener, Looper.getMainLooper())
        started = true
      }
    } catch (e: SecurityException) {
      emit("onGnssError", mapOf("message" to (e.message ?: "location permission missing"), "code" to 2))
      return false
    }
    gnssRunning = started
    gnssFixes = 0
    Log.i(TAG, "startGnss started=$started providers=${locationManager.allProviders}")
    return started
  }

  fun stopGnss() {
    if (!gnssRunning) return
    locationManager.removeUpdates(locationListener)
    gnssRunning = false
  }

  private fun emitFix(l: Location) {
    val api = Build.VERSION.SDK_INT
    val sample = LocationSample(
      latitude = l.latitude,
      longitude = l.longitude,
      altitudeEllipsoid = if (l.hasAltitude()) l.altitude else null,
      altitudeMsl = if (api >= 34 && l.hasMslAltitude()) l.mslAltitudeMeters else null,
      horizontalAccuracy = if (l.hasAccuracy()) l.accuracy.toDouble() else null,
      verticalAccuracy = if (l.hasVerticalAccuracy()) l.verticalAccuracyMeters.toDouble() else null,
      speed = if (l.hasSpeed()) l.speed.toDouble() else null,
      speedAccuracy = if (l.hasSpeedAccuracy()) l.speedAccuracyMetersPerSecond.toDouble() else null,
      bearing = if (l.hasBearing()) l.bearing.toDouble() else null,
      bearingAccuracy = if (l.hasBearingAccuracy()) l.bearingAccuracyDegrees.toDouble() else null,
      elapsedRealtimeUs = l.elapsedRealtimeNanos / 1000.0,
      utcMillis = l.time,
      simulated = if (api >= 31) l.isMock else @Suppress("DEPRECATION") l.isFromMockProvider,
    )
    emit("onGnss", SensorLogic.gnssEvent(sample, nowUs()))
    // Logcat evidence for the emulator smoke test and for testers' bug reports (no coordinates).
    if (gnssFixes++ % 30 == 0) {
      Log.i(TAG, "gnss fix #$gnssFixes provider=${l.provider} hasSpeed=${l.hasSpeed()} acc=${if (l.hasAccuracy()) l.accuracy else -1f}")
    }
  }

  // --- IMU ------------------------------------------------------------------------------------------------------

  private var thread: HandlerThread? = null
  private var handler: Handler? = null
  private var imuListener: SensorEventListener? = null

  // Only touched on the sensor thread (batchers are created there too).
  private var batcher = ImuBatcher(100.0, 0.0)
  private val assembler = MotionAssembler()

  /**
   * `motion` rows need a gyroscope (the yaw source) and gravity. Gravity and linear acceleration come from their
   * sensors, or are derived from the accelerometer on phones (and the emulator) that lack them.
   */
  fun startImu(rateHz: Double, raw: Boolean, batchMs: Double, magRateHz: Double): Boolean {
    if (sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE) == null) return false
    val derived = sensorManager.getDefaultSensor(Sensor.TYPE_GRAVITY) == null ||
      sensorManager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION) == null
    if (derived && sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) == null) return false
    stopImu()
    imuBatches = 0
    Log.i(TAG, "startImu rate=$rateHz raw=$raw derivedGravity=$derived")

    val t = HandlerThread("ai.wtf.sensorcapture.imu").also { it.start() }
    val h = Handler(t.looper)
    thread = t
    handler = h
    h.post { batcher = ImuBatcher(batchMs, nowUs()) }

    val period = SensorLogic.samplingPeriodUs(rateHz)
    val listener = object : SensorEventListener {
      override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
      override fun onSensorChanged(event: SensorEvent) {
        val tUs = event.timestamp / 1000.0
        val v = event.values
        when (event.sensor.type) {
          Sensor.TYPE_GRAVITY -> if (!derived) assembler.onGravity(v[0].toDouble(), v[1].toDouble(), v[2].toDouble())
          Sensor.TYPE_LINEAR_ACCELERATION -> if (!derived) assembler.onLinearAcceleration(v[0].toDouble(), v[1].toDouble(), v[2].toDouble())
          Sensor.TYPE_GAME_ROTATION_VECTOR -> assembler.onRotationVector(v)
          Sensor.TYPE_GYROSCOPE -> assembler.onGyro(tUs, v[0].toDouble(), v[1].toDouble(), v[2].toDouble())?.let { append("m", it) }
          Sensor.TYPE_GYROSCOPE_UNCALIBRATED -> append("g", SensorLogic.gyroRow(tUs, v[0].toDouble(), v[1].toDouble(), v[2].toDouble()))
          Sensor.TYPE_ACCELEROMETER -> {
            if (derived) assembler.onAccelerometer(tUs, v[0].toDouble(), v[1].toDouble(), v[2].toDouble())
            if (raw) append("a", SensorLogic.accelRow(tUs, v[0].toDouble(), v[1].toDouble(), v[2].toDouble()))
          }
          Sensor.TYPE_MAGNETIC_FIELD_UNCALIBRATED, Sensor.TYPE_MAGNETIC_FIELD ->
            append("f", SensorLogic.magRow(tUs, v[0].toDouble(), v[1].toDouble(), v[2].toDouble()))
        }
      }
    }
    imuListener = listener

    fun register(type: Int, periodUs: Int = period): Boolean {
      val s = sensorManager.getDefaultSensor(type) ?: return false
      return sensorManager.registerListener(listener, s, periodUs, h)
    }
    if (!derived) {
      register(Sensor.TYPE_GRAVITY)
      register(Sensor.TYPE_LINEAR_ACCELERATION)
    }
    register(Sensor.TYPE_GAME_ROTATION_VECTOR)
    register(Sensor.TYPE_GYROSCOPE)
    if (derived || raw) register(Sensor.TYPE_ACCELEROMETER)
    if (raw) register(Sensor.TYPE_GYROSCOPE_UNCALIBRATED)
    if (magRateHz > 0) {
      val magPeriod = SensorLogic.samplingPeriodUs(magRateHz)
      if (!register(Sensor.TYPE_MAGNETIC_FIELD_UNCALIBRATED, magPeriod)) register(Sensor.TYPE_MAGNETIC_FIELD, magPeriod)
    }
    return true
  }

  fun stopImu() {
    val listener = imuListener ?: return
    sensorManager.unregisterListener(listener)
    imuListener = null
    val h = handler
    val t = thread
    handler = null
    thread = null
    // Flush what is pending, then end the thread.
    h?.post {
      batcher.flush(nowUs())?.let { emit("onImuBatch", ImuBatcher.payload(it)) }
      t?.quitSafely()
    }
  }

  private var imuBatches = 0

  /** Sensor thread only. */
  private fun append(stream: String, row: DoubleArray) {
    batcher.append(stream, row, nowUs())?.let {
      emit("onImuBatch", ImuBatcher.payload(it))
      if (imuBatches++ % 100 == 0) {
        Log.i(TAG, "imu batch #$imuBatches motion=${it["m"]?.size?.div(14)} gyro=${it["g"]?.size?.div(4)} mag=${it["f"]?.size?.div(4)}")
      }
    }
  }

  fun shutdown() {
    stopGnss()
    stopImu()
  }
}
