import ai.wtf.sensorcapture.logic.HealthLogic
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class HealthLogicTest {
  @Test
  fun exitReasonsByTheirPlatformNumbers() {
    assertEquals("low-memory", HealthLogic.exitReason(3))
    assertEquals("user-requested", HealthLogic.exitReason(10))
    assertEquals("crash-native", HealthLogic.exitReason(5))
    assertEquals("unknown", HealthLogic.exitReason(0))
    assertEquals("unknown", HealthLogic.exitReason(99))
  }

  @Test
  fun importanceAndWhetherTheAppWasOnScreen() {
    assertEquals("foreground", HealthLogic.importance(100))
    assertEquals("foreground-service", HealthLogic.importance(125))
    assertEquals("cached", HealthLogic.importance(400))
    assertEquals("gone", HealthLogic.importance(1000))
    assertFalse(HealthLogic.inBackground(100))
    assertTrue(HealthLogic.inBackground(125 + 100))
  }

  @Test
  fun thermalInIosLevels() {
    assertEquals("nominal", HealthLogic.thermal(0))
    assertEquals("fair", HealthLogic.thermal(2))
    assertEquals("serious", HealthLogic.thermal(3))
    assertEquals("critical", HealthLogic.thermal(6))
  }

  @Test
  fun trimLevelsWorthANote() {
    assertEquals("running critical", HealthLogic.trimLevel(15))
    assertNull(HealthLogic.trimLevel(20))
  }
}
