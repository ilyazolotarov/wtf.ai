import ai.wtf.androidauto.logic.CarAlternative
import ai.wtf.androidauto.logic.CarCard
import ai.wtf.androidauto.logic.CarDistanceUnit
import ai.wtf.androidauto.logic.CarGuidanceLogic
import ai.wtf.androidauto.logic.CarManeuverType
import ai.wtf.androidauto.logic.CarNotice
import ai.wtf.androidauto.logic.CarNoticeButtons
import ai.wtf.androidauto.logic.CarPlace
import ai.wtf.androidauto.logic.CarRoute
import ai.wtf.androidauto.logic.CarSearch
import ai.wtf.androidauto.logic.CarSearchList
import ai.wtf.androidauto.logic.CarStep
import ai.wtf.androidauto.logic.CarTurnNotification
import ai.wtf.androidauto.logic.SessionStep
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CarGuidanceLogicTest {
  private val left = step("left", 400.0, 36.0)

  private fun step(kind: String, distanceM: Double, timeS: Double, id: String = "$kind@50.45,30.52") =
    CarStep(id, kind, null, "Turn ${kind.replace('-', ' ')}", distanceM, timeS, distanceM, "m", "${distanceM.toInt()} m")

  private fun route(
    status: String,
    steps: List<CarStep> = listOf(left),
    replanning: Boolean = false,
    message: String? = null,
    quiet: Boolean = false,
    alternatives: List<CarAlternative> = emptyList(),
  ) = CarRoute(status, message, "Kyiv", replanning, quiet, steps, 10_000.0, 900.0, 10.0, "km1", "Khreshchatyk Street", "15 min · 10 km", alternatives)

  @Test
  fun theRoutesButtonOnlyWithOtherWaysWhileFollowed() {
    val other = listOf(CarAlternative(0, "+2 min", "17 min · 11 km"))
    val followed = route("active", alternatives = other)
    assertTrue(CarGuidanceLogic.showsRoutes(followed, CarGuidanceLogic.card(followed, null)))
    assertFalse(CarGuidanceLogic.showsRoutes(route("active"), CarCard.STEPS))
    val again = route("active", replanning = true, alternatives = other)
    assertFalse(CarGuidanceLogic.showsRoutes(again, CarGuidanceLogic.card(again, null)))
    val notice = CarNotice("location", "Location off", "", "Allow")
    assertFalse(CarGuidanceLogic.showsRoutes(followed, CarGuidanceLogic.card(followed, notice)))
  }

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
  fun everyNoticeHasAButtonNoMapAndUnknownKindsOnlyClose() {
    assertEquals(CarNoticeButtons.ALLOW, CarGuidanceLogic.noticeButtons("location"))
    assertEquals(CarNoticeButtons.CONFIRM_OR_CANCEL, CarGuidanceLogic.noticeButtons("held-route"))
    assertEquals(CarNoticeButtons.CLOSE, CarGuidanceLogic.noticeButtons("no-map"))
    assertEquals(CarNoticeButtons.CLOSE, CarGuidanceLogic.noticeButtons("from-a-newer-js"))
  }

  @Test
  fun aClosedNoticeStaysClosedUntilAnotherComes() {
    val noMap = CarNotice("no-map", "No offline map", "Download a region in Offline maps on your phone.", "Close")
    val location = CarNotice("location", "Location is off", "Allow it on the phone.", "Allow")
    assertEquals(noMap, CarGuidanceLogic.shownNotice(noMap, null))
    assertNull(CarGuidanceLogic.shownNotice(noMap, noMap.copy()))
    assertEquals(location, CarGuidanceLogic.shownNotice(location, noMap))
    assertNull(CarGuidanceLogic.shownNotice(null, noMap))
  }

  @Test
  fun aNoticeComesBeforeTheRoute() {
    val notice = CarNotice("location", "Location is off", "Allow it on the phone.", "Allow")
    assertEquals(CarCard.NOTICE, CarGuidanceLogic.card(route("active"), notice))
    assertEquals(CarCard.NOTICE, CarGuidanceLogic.card(null, notice))
    assertEquals(CarCard.NONE, CarGuidanceLogic.card(null, null))
    assertEquals(CarCard.STEPS, CarGuidanceLogic.card(route("active"), null))
    assertEquals(CarCard.LOADING, CarGuidanceLogic.card(route("planning", steps = emptyList()), null))
    assertEquals(CarCard.LOADING, CarGuidanceLogic.card(route("active", replanning = true), null))
    assertEquals(CarCard.MESSAGE, CarGuidanceLogic.card(route("arrived", steps = emptyList()), null))
    assertEquals(CarCard.MESSAGE, CarGuidanceLogic.card(route("failed", steps = emptyList()), null))
  }

  @Test
  fun theTurnNotificationShowsTheNextManeuverWhileTheCarNavigates() {
    val far = CarGuidanceLogic.turnNotification(route("active", listOf(step("left", 900.0, 81.0))), null)
    assertEquals(CarTurnNotification("900 m", "Turn left", CarManeuverType.TURN_LEFT, null), far)
    // Planned (again): the message, no maneuver, no pop-up.
    assertEquals(
      CarTurnNotification("Planning route…", "", null, null),
      CarGuidanceLogic.turnNotification(route("active", replanning = true, message = "Planning route…"), null),
    )
    assertEquals(CarTurnNotification("Kyiv", "", null, null), CarGuidanceLogic.turnNotification(route("planning", emptyList()), null))
    // Arrival, a failed plan, no route: taken down.
    assertNull(CarGuidanceLogic.turnNotification(route("arrived", emptyList(), message = "You've arrived"), null))
    assertNull(CarGuidanceLogic.turnNotification(route("failed", emptyList()), null))
    assertNull(CarGuidanceLogic.turnNotification(null, null))
  }

  @Test
  fun aManeuverPopsUpOnceAsItComesNear() {
    val near = step("right", 290.0, 26.0)
    assertEquals(near.id, CarGuidanceLogic.turnNotification(route("active", listOf(near)), null)?.alertFor)
    // Popped up already: the rail updates, nothing pops up again (a re-plan keeping the maneuver keeps its id).
    assertNull(CarGuidanceLogic.turnNotification(route("active", listOf(step("right", 120.0, 11.0))), near.id)?.alertFor)
    // Near by time on a fast road, not yet by distance.
    val fast = step("keep-right", 550.0, 18.0)
    assertEquals(fast.id, CarGuidanceLogic.turnNotification(route("active", listOf(fast)), near.id)?.alertFor)
    // Far: not yet.
    assertNull(CarGuidanceLogic.turnNotification(route("active", listOf(step("left", 650.0, 40.0))), near.id)?.alertFor)
    // The same turn again at the next junction is another maneuver.
    val again = step("right", 200.0, 18.0, id = "right@50.46,30.53")
    assertEquals(again.id, CarGuidanceLogic.turnNotification(route("active", listOf(again)), near.id)?.alertFor)
    // The departure: the driver has just started.
    assertNull(CarGuidanceLogic.turnNotification(route("active", listOf(step("depart", 20.0, 2.0))), null)?.alertFor)
  }

  @Test
  fun nothingPopsUpWhileTheDriverKeepsToTheirOwnWay() {
    val near = step("right", 120.0, 11.0)
    val quiet = CarGuidanceLogic.turnNotification(route("active", listOf(near), quiet = true), null)
    // The rail still shows the turn; it doesn't pop up.
    assertEquals(CarTurnNotification("120 m", "Turn right", CarManeuverType.TURN_RIGHT, null), quiet)
    // Following the route again: the turn ahead pops up.
    assertEquals(near.id, CarGuidanceLogic.turnNotification(route("active", listOf(near)), null)?.alertFor)
  }

  @Test
  fun theSearchScreenShowsOnlyResultsForTheTextTyped() {
    val found = listOf(CarPlace("search:a1", "Khreshchatyk, 22", "Kyiv · 1.2 km", "result"))
    assertEquals(CarSearchList.Empty, CarGuidanceLogic.searchList(CarSearch("khresh", found), "  "))
    // Typed on: the last answer was for less, the next one is on its way.
    assertEquals(CarSearchList.Loading, CarGuidanceLogic.searchList(CarSearch("khresh", found), "khreshch"))
    assertEquals(CarSearchList.Loading, CarGuidanceLogic.searchList(null, "khresh"))
    assertEquals(CarSearchList.Results(found), CarGuidanceLogic.searchList(CarSearch("khresh ", found), "khresh"))
    assertEquals(CarSearchList.Results(emptyList()), CarGuidanceLogic.searchList(CarSearch("zzz", emptyList()), "zzz"))
  }

  @Test
  fun theCarsMapIsDrawnBiggerThanTheCarsDensity() {
    assertEquals(224, CarGuidanceLogic.mapDpi(160))
    assertEquals(336, CarGuidanceLogic.mapDpi(240))
    // A dpi the host didn't give: as 160.
    assertEquals(224, CarGuidanceLogic.mapDpi(0))
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
