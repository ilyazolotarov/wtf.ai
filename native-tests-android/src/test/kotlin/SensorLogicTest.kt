import ai.wtf.sensorcapture.logic.ImuBatcher
import ai.wtf.sensorcapture.logic.LocationSample
import ai.wtf.sensorcapture.logic.MotionAssembler
import ai.wtf.sensorcapture.logic.SensorLogic
import kotlin.math.PI
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private fun sample(
  hAcc: Double? = 4.5, vAcc: Double? = 6.0, speed: Double? = 13.9, speedAcc: Double? = 0.5,
  bearing: Double? = 90.0, bearingAcc: Double? = 5.0, elapsedUs: Double = 4_999_750_000.0,
  msl: Double? = 180.0, ellipsoid: Double? = 210.0,
) = LocationSample(
  latitude = 50.45, longitude = 30.52, altitudeEllipsoid = ellipsoid, altitudeMsl = msl,
  horizontalAccuracy = hAcc, verticalAccuracy = vAcc, speed = speed, speedAccuracy = speedAcc,
  bearing = bearing, bearingAccuracy = bearingAcc, elapsedRealtimeUs = elapsedUs,
  utcMillis = 1_791_000_000_000, simulated = false,
)

class GnssEventTest {
  @Test
  fun mapsValidFixAndConvertsUnits() {
    // Same vector as the Swift test: the fix is 0.25 s old at delivery, uptime now = 5000 s.
    val e = SensorLogic.gnssEvent(sample(), nowUs = 5_000_000_000.0)
    assertEquals(4_999_750_000.0, e["tUs"] as Double, 1.0)
    assertEquals(1_791_000_000_000_000.0, e["utcUs"] as Double, 1.0)
    assertEquals(250_000.0, e["deliveryDelayUs"] as Double, 1.0)
    assertEquals(50.45, e["lat"])
    assertEquals(4.5, e["hAcc"])
    assertEquals(180.0, e["altMsl"])
    assertEquals(210.0, e["altEllipsoid"])
    assertEquals(13.9, e["speed"])
    assertEquals(PI / 2, e["courseRad"] as Double, 1e-12)
    assertEquals(5 * PI / 180, e["courseAccRad"] as Double, 1e-12)
    assertEquals(false, e["fromAccessory"])
    assertEquals(false, e["simulated"])
  }

  @Test
  fun omitsUnavailableFields() {
    val e = SensorLogic.gnssEvent(
      sample(hAcc = null, vAcc = null, speed = null, speedAcc = null, bearing = null, bearingAcc = null, msl = null, ellipsoid = null),
      nowUs = 5_000_000_000.0,
    )
    for (key in listOf("hAcc", "vAcc", "altMsl", "altEllipsoid", "speed", "speedAcc", "courseRad", "courseAccRad")) {
      assertNull(e[key], key)
    }
    assertNotNull(e["lat"])
  }

  @Test
  fun coarseNetworkFixHasNoSpeed() {
    // A network-provider fix: accuracy only. JS reads "no speed" as "not a satellite fix" (SPEC section 3.3 item 5).
    val e = SensorLogic.gnssEvent(
      sample(hAcc = 800.0, vAcc = null, speed = null, speedAcc = null, bearing = null, bearingAcc = null),
      5_000_000_000.0,
    )
    assertEquals(800.0, e["hAcc"])
    assertNull(e["speed"])
  }

  @Test
  fun fixFromTheFutureGivesZeroDelay() {
    val e = SensorLogic.gnssEvent(sample(elapsedUs = 2_000_000.0), nowUs = 1_000_000.0)
    assertEquals(0.0, e["deliveryDelayUs"])
  }
}

class RowTest {
  private val g = SensorLogic.STANDARD_GRAVITY

  @Test
  fun motionRowLayoutAndGravityIsTheTrueGravityDirection() {
    // Phone flat, face up, at rest: Android TYPE_GRAVITY reads +9.81 on z. The iOS convention (and src/nav, which
    // computes up = -gravity/|gravity|) wants the true gravity direction: z = -9.81.
    val row = SensorLogic.motionRow(
      tUs = 12_500_000.0,
      gyro = doubleArrayOf(0.1, 0.2, 0.3),
      linearAccel = doubleArrayOf(9.80665, 0.0, 0.0),
      androidGravity = doubleArrayOf(0.0, 0.0, g),
      quaternion = doubleArrayOf(1.0, 0.0, 0.0, 0.0),
    )
    assertEquals(14, row.size)
    assertEquals(12_500_000.0, row[0])
    assertEquals(listOf(0.1, 0.2, 0.3), row.slice(1..3))
    assertEquals(g, row[4], 1e-12)
    assertEquals(0.0, row[8], 0.0)
    assertEquals(-g, row[9], 1e-12)
    assertEquals(listOf(1.0, 0.0, 0.0, 0.0), row.slice(10..13))
  }

  @Test
  fun counterClockwiseTurnOnATableGivesTheSameYawAsIos() {
    // Phone flat, turned counter-clockwise seen from above: gyro z > 0 on both platforms (right-hand rule, z out of
    // the screen). The navigator's yaw rate is gyro . up with up = -gravity/|gravity|, so it must come out the same.
    val row = SensorLogic.motionRow(
      0.0, doubleArrayOf(0.0, 0.0, 0.5), doubleArrayOf(0.0, 0.0, 0.0), doubleArrayOf(0.0, 0.0, g), doubleArrayOf(1.0, 0.0, 0.0, 0.0),
    )
    val gyro = row.slice(1..3)
    val grav = row.slice(7..9)
    val norm = Math.sqrt(grav.sumOf { it * it })
    val yaw = (0..2).sumOf { gyro[it] * (-grav[it] / norm) }
    // iOS reference: gravity (0, 0, -1 g) gives up (0, 0, 1), so yaw = gyro.z. Same value here.
    assertEquals(0.5, yaw, 1e-12)
  }

  @Test
  fun rawRows() {
    assertEquals(listOf(1.0, 1.0, 2.0, 3.0), SensorLogic.gyroRow(1.0, 1.0, 2.0, 3.0).toList())
    assertEquals(listOf(3.0, 20.0, -5.0, -45.0), SensorLogic.magRow(3.0, 20.0, -5.0, -45.0).toList())
    assertEquals(4, SensorLogic.accelRow(2.0, 0.0, 0.0, g).size)
  }

  @Test
  fun rotationVectorToQuaternion() {
    // Android: [x, y, z, w]; the log: w x y z.
    val q = SensorLogic.quaternionFromRotationVector(floatArrayOf(0.1f, 0.2f, 0.3f, 0.5f))
    assertEquals(0.5, q[0], 1e-6)
    assertEquals(0.1, q[1], 1e-6)
    assertEquals(0.3, q[3], 1e-6)
    // Three-value form (older devices): w is derived.
    assertEquals(0.8, SensorLogic.quaternionFromRotationVector(floatArrayOf(0f, 0f, 0.6f))[0], 1e-6)
  }

  @Test
  fun rateClampAndSamplingPeriod() {
    assertEquals(1.0, SensorLogic.clampRateHz(0.0))
    assertEquals(100.0, SensorLogic.clampRateHz(100.0))
    assertEquals(200.0, SensorLogic.clampRateHz(1000.0))
    assertEquals(10_000, SensorLogic.samplingPeriodUs(100.0))
    assertEquals(5_000, SensorLogic.samplingPeriodUs(1000.0))
  }

  @Test
  fun permissionStates() {
    assertEquals("whenInUse" to "full", SensorLogic.permissionState(true, true, true, true))
    assertEquals("whenInUse" to "reduced", SensorLogic.permissionState(false, true, true, true))
    assertEquals("notDetermined" to "reduced", SensorLogic.permissionState(false, false, true, false))
    assertEquals("notDetermined" to "reduced", SensorLogic.permissionState(false, false, true, true))
    assertEquals("denied" to "reduced", SensorLogic.permissionState(false, false, false, true))
  }
}

class MotionAssemblerTest {
  @Test
  fun waitsForGravityThenEmitsARowPerGyroSample() {
    val m = MotionAssembler()
    assertNull(m.onGyro(1.0, 0.0, 0.0, 0.1))
    m.onGravity(0.0, 0.0, 9.8)
    val row = m.onGyro(2.0, 0.0, 0.0, 0.2)!!
    assertEquals(14, row.size)
    assertEquals(0.2, row[3])
    assertEquals(-9.8, row[9])
    // Defaults until the other sensors report: no linear acceleration, identity attitude.
    assertEquals(0.0, row[4])
    assertEquals(listOf(1.0, 0.0, 0.0, 0.0), row.slice(10..13))
    m.onLinearAcceleration(1.0, 2.0, 3.0)
    m.onRotationVector(floatArrayOf(0f, 0f, 0f, 1f))
    val next = m.onGyro(3.0, 0.0, 0.0, 0.3)!!
    assertEquals(listOf(1.0, 2.0, 3.0), next.slice(4..6))
  }
}

class DerivedGravityTest {
  @Test
  fun lowPassGravityAndLinearRemainder() {
    val m = MotionAssembler()
    // Phone flat at rest for 3 s at 100 Hz: gravity settles on the reading, linear acceleration on zero.
    for (i in 0..300) m.onAccelerometer(i * 10_000.0, 0.0, 0.0, 9.80665)
    val rest = m.onGyro(3_000_000.0, 0.0, 0.0, 0.0)!!
    assertEquals(-9.80665, rest[9], 1e-9) // true gravity direction, as with the dedicated sensor
    assertEquals(0.0, rest[4], 1e-9)
    // A 2 m/s2 push along x: shows up as linear acceleration at once, gravity barely moves.
    m.onAccelerometer(3_010_000.0, 2.0, 0.0, 9.80665)
    val push = m.onGyro(3_010_000.0, 0.0, 0.0, 0.0)!!
    assertTrue(push[4] > 1.9)
    assertEquals(0.0, push[7], 0.05)
  }

  @Test
  fun firstSampleSeedsGravity() {
    val m = MotionAssembler()
    m.onAccelerometer(0.0, 1.0, 2.0, 9.0)
    val row = m.onGyro(0.0, 0.0, 0.0, 0.0)!!
    assertEquals(listOf(-1.0, -2.0, -9.0), row.slice(7..9))
    assertEquals(listOf(0.0, 0.0, 0.0), row.slice(4..6))
  }
}

class ImuBatcherTest {
  @Test
  fun emitsBatchAfterInterval() {
    val b = ImuBatcher(100.0, 0.0)
    assertNull(b.append("m", doubleArrayOf(1.0, 2.0), 50_000.0))
    assertNull(b.append("g", doubleArrayOf(3.0), 90_000.0))
    val batch = b.append("m", doubleArrayOf(4.0), 100_000.0)!!
    assertEquals(listOf(1.0, 2.0, 4.0), batch["m"])
    assertEquals(listOf(3.0), batch["g"])
    assertEquals(emptyList(), batch["a"])
    assertEquals(100_000.0, b.startUs)
    assertTrue(b.pending.values.all { it.isEmpty() })
  }

  @Test
  fun flushEmptyReturnsNull() {
    val b = ImuBatcher(100.0, 0.0)
    assertNull(b.flush(10.0))
    b.append("a", doubleArrayOf(1.0, 2.0, 3.0, 4.0), 20.0)
    assertEquals(listOf(1.0, 2.0, 3.0, 4.0), b.flush(30.0)!!["a"])
    b.append("f", doubleArrayOf(5.0, 6.0, 7.0, 8.0), 40.0)
    assertEquals(listOf(5.0, 6.0, 7.0, 8.0), b.flush(50.0)!!["f"])
  }

  @Test
  fun minimumInterval() {
    assertEquals(20_000.0, ImuBatcher(5.0, 0.0).intervalUs)
  }

  @Test
  fun payloadKeysMatchJs() {
    val p = ImuBatcher.payload(mapOf("m" to listOf(1.0), "g" to listOf(2.0), "a" to listOf(3.0), "f" to listOf(4.0)))
    assertEquals(listOf(1.0), p["motion"])
    assertEquals(listOf(2.0), p["gyro"])
    assertEquals(listOf(3.0), p["accel"])
    assertEquals(listOf(4.0), p["mag"])
  }
}
