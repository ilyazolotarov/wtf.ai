import ai.wtf.androidauto.logic.CarDistanceUnit
import ai.wtf.androidauto.logic.CarGuidanceLogic
import ai.wtf.androidauto.logic.CarManeuverType
import ai.wtf.androidauto.logic.CarRoute
import ai.wtf.androidauto.logic.CarStep
import ai.wtf.androidauto.logic.SessionStep
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CarGuidanceLogicTest {
  private val left = CarStep("left", null, "Turn left", 400.0, 36.0, 400.0, "m")

  private fun route(status: String, steps: List<CarStep> = listOf(left), replanning: Boolean = false) =
    CarRoute(status, null, "Kyiv", replanning, steps, 10_000.0, 900.0, 10.0, "km1")

  @Test
  fun everyManeuverKindOfTheAppHasACarType() {
    // MANEUVER_KINDS in src/nav/routing/maneuvers.ts.
    val kinds = listOf(
      "depart", "slight-left", "slight-right", "left", "right", "sharp-left", "sharp-right",
      "keep-left", "keep-right", "u-turn", "roundabout", "arrive",
    )
    assertEquals(kinds.size, kinds.mapNotNull { CarGuidanceLogic.maneuverType(it) }.toSet().size)
    assertEquals(CarManeuverType.ROUNDABOUT_CCW, CarGuidanceLogic.maneuverType("roundabout"))
    assertEquals(CarManeuverType.DESTINATION, CarGuidanceLogic.maneuverType("arrive"))
    assertNull(CarGuidanceLogic.maneuverType("fly"))
  }

  @Test
  fun aRoundaboutWithoutACountedExitIsTheFirst() {
    assertEquals(1, CarGuidanceLogic.roundaboutExit(null))
    assertEquals(1, CarGuidanceLogic.roundaboutExit(0))
    assertEquals(3, CarGuidanceLogic.roundaboutExit(3))
  }

  @Test
  fun distanceUnitsAsTheBannerRoundsThem() {
    assertEquals(CarDistanceUnit.METERS, CarGuidanceLogic.distanceUnit("m"))
    assertEquals(CarDistanceUnit.KILOMETERS_P1, CarGuidanceLogic.distanceUnit("km1"))
    assertEquals(CarDistanceUnit.KILOMETERS, CarGuidanceLogic.distanceUnit("km"))
    assertEquals(CarDistanceUnit.METERS, CarGuidanceLogic.distanceUnit("?"))
  }

  @Test
  fun theCarNavigatesWhileARouteIsPlannedOrFollowed() {
    assertEquals(SessionStep.START, CarGuidanceLogic.sessionStep(false, route("planning")))
    assertEquals(SessionStep.UPDATE, CarGuidanceLogic.sessionStep(true, route("active")))
    assertEquals(SessionStep.START, CarGuidanceLogic.sessionStep(false, route("active")))
    assertEquals(SessionStep.END, CarGuidanceLogic.sessionStep(true, route("arrived")))
    assertEquals(SessionStep.END, CarGuidanceLogic.sessionStep(true, route("failed")))
    assertEquals(SessionStep.END, CarGuidanceLogic.sessionStep(true, null))
    assertEquals(SessionStep.NONE, CarGuidanceLogic.sessionStep(false, null))
    assertEquals(SessionStep.NONE, CarGuidanceLogic.sessionStep(false, route("arrived")))
  }

  @Test
  fun stepsShowOnlyOnAFollowedRoute() {
    assertTrue(CarGuidanceLogic.showsSteps(route("active")))
    assertFalse(CarGuidanceLogic.showsSteps(route("active", replanning = true)))
    assertFalse(CarGuidanceLogic.showsSteps(route("active", steps = emptyList())))
    assertFalse(CarGuidanceLogic.showsSteps(route("planning")))
    assertFalse(CarGuidanceLogic.showsSteps(null))
  }

  @Test
  fun theVisibleAreaAsInsetsInTheCarsDp() {
    // 1280×720 at 160 dpi, the card covering the left 400 px: insets in dp, one dp a pixel.
    assertEquals(listOf(400.0, 0.0, 0.0, 0.0), CarGuidanceLogic.insetsDp(1280, 720, 400, 0, 1280, 720, 160))
    // 320 dpi: two pixels a dp.
    assertEquals(listOf(100.0, 10.0, 20.0, 30.0), CarGuidanceLogic.insetsDp(1000, 600, 200, 20, 960, 540, 320))
    // A dpi the host didn't give: as 160.
    assertEquals(listOf(10.0, 0.0, 0.0, 0.0), CarGuidanceLogic.insetsDp(100, 100, 10, 0, 100, 100, 0))
  }
}
