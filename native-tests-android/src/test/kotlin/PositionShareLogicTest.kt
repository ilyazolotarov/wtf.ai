import ai.wtf.positionshare.logic.MockFixLogic
import kotlin.math.PI
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class MockFixTest {
  @Test
  fun convertsTheCourseToDegreesAndKeepsSiFields() {
    val f = assertNotNull(MockFixLogic.fromPayload(50.45, 30.52, 12.0, 13.9, PI / 2, 5 * PI / 180))
    assertEquals(50.45, f.latitude)
    assertEquals(30.52, f.longitude)
    assertEquals(12f, f.accuracyM)
    assertEquals(13.9f, f.speedMps)
    assertEquals(90f, f.bearingDeg!!, 1e-4f)
    assertEquals(5f, f.bearingAccuracyDeg!!, 1e-4f)
  }

  @Test
  fun bearingIsWithinZeroTo360() {
    assertEquals(270f, MockFixLogic.bearingDeg(-PI / 2), 1e-4f)
    assertEquals(0f, MockFixLogic.bearingDeg(2 * PI), 1e-4f)
    assertEquals(45f, MockFixLogic.bearingDeg(4 * PI + PI / 4), 1e-4f)
    assertEquals(0f, MockFixLogic.bearingDeg(-1e-12), 1e-4f)
  }

  @Test
  fun noPositionWithoutAPlaceOrARadius() {
    assertNull(MockFixLogic.fromPayload(Double.NaN, 30.52, 12.0, null, null, null))
    assertNull(MockFixLogic.fromPayload(91.0, 30.52, 12.0, null, null, null))
    assertNull(MockFixLogic.fromPayload(50.45, 181.0, 12.0, null, null, null))
    assertNull(MockFixLogic.fromPayload(50.45, 30.52, Double.NaN, null, null, null))
    assertNull(MockFixLogic.fromPayload(50.45, 30.52, 0.0, null, null, null))
  }

  @Test
  fun leavesOutWhatIsUnknown() {
    val f = assertNotNull(MockFixLogic.fromPayload(50.45, 30.52, 40.0, Double.NaN, null, 0.1))
    assertNull(f.speedMps)
    assertNull(f.bearingDeg)
    // A heading doubt without a heading means nothing.
    assertNull(f.bearingAccuracyDeg)
  }

  @Test
  fun negativeSpeedIsZeroAndHeadingDoubtIsCapped() {
    // CAN wheel speeds are negative in reverse; Android's speed is unsigned.
    val f = assertNotNull(MockFixLogic.fromPayload(50.45, 30.52, 8.0, -1.5, 0.0, 4.0))
    assertEquals(0f, f.speedMps)
    assertEquals(180f, f.bearingAccuracyDeg)
  }

  @Test
  fun wallClockNeverRunsBack() {
    assertEquals(1_000L, MockFixLogic.wallClockMs(1_000, null))
    assertEquals(2_000L, MockFixLogic.wallClockMs(2_000, 1_000))
    // The phone's clock set back while sharing: the fixes keep counting up.
    assertEquals(1_001L, MockFixLogic.wallClockMs(500, 1_000))
    assertEquals(1_001L, MockFixLogic.wallClockMs(1_000, 1_000))
  }
}
