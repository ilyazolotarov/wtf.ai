package ai.wtf.androidauto.logic

// What Android Auto's navigation template and navigation session show of the route (docs/ANDROID-AUTO-SPEC.md §4),
// decided without Android classes: the JS side's route state in, the car's maneuver kinds, distance units and session
// steps out. CarScreen.kt turns them into the Car App Library's types. Tested in native-tests-android.

/** A maneuver as the Car App Library knows it (`Maneuver.TYPE_*`), for the app's maneuver kinds. */
enum class CarManeuverType {
  DEPART,
  STRAIGHT,
  TURN_SLIGHT_LEFT,
  TURN_SLIGHT_RIGHT,
  TURN_LEFT,
  TURN_RIGHT,
  TURN_SHARP_LEFT,
  TURN_SHARP_RIGHT,
  KEEP_LEFT,
  KEEP_RIGHT,
  U_TURN_LEFT,
  /** Counter-clockwise: traffic drives on the right, as everywhere the app has maps. Takes the exit number. */
  ROUNDABOUT_CCW,
  DESTINATION,
}

/** `Distance.UNIT_*`: metres, whole kilometres, kilometres with one decimal. */
enum class CarDistanceUnit { METERS, KILOMETERS, KILOMETERS_P1 }

/** One maneuver ahead, as the JS side sends it (src/components/car-screen/car-guidance.ts). */
data class CarStep(
  /** The app's maneuver kind (src/nav/routing/maneuvers.ts). */
  val kind: String,
  /** Roundabouts: the exit to take, 1-based. */
  val exit: Int?,
  /** "Turn left", in the app's language. */
  val instruction: String,
  /** From the car (the first) or the step before (the second), m and s. */
  val distanceM: Double,
  val timeS: Double,
  /** The distance as the phone's banner rounds it: a value and "m", "km" or "km1" (one decimal). */
  val shownDistance: Double,
  val shownUnit: String,
)

/** The route as the car's screen shows it. */
data class CarRoute(
  /** `planning`, `active`, `arrived` or `failed`. */
  val status: String,
  /** What the screen says instead of a maneuver: planning, a failure, arrival. */
  val message: String?,
  val destinationName: String,
  /** Planning again after leaving the route: the old maneuvers are no guide meanwhile. */
  val replanning: Boolean,
  /** The next maneuver, and the one after when it follows closely. */
  val steps: List<CarStep>,
  val remainingM: Double,
  val remainingS: Double,
  val remainingShown: Double,
  val remainingUnit: String,
)

/** A destination to pick on the car's screen: a saved place or a recent one. */
data class CarPlace(val id: String, val title: String, val detail: String?, val kind: String)

/** The car's own words, in the app's language (the JS side's strings; English until it sends them). */
data class CarLabels(
  val endRoute: String = "End route",
  val destinations: String = "Destinations",
  val saved: String = "Saved",
  val recent: String = "Recent",
  val noDestinations: String = "Saved places and recent destinations show here.",
  val voiceOn: String = "Voice on",
  val voiceOff: String = "Voice off",
  /** The phone's notification while the car session holds location (CarLocationService). */
  val notification: String = "Keeps the car's position while Android Auto shows another app.",
)

/** What the car's navigation session (NavigationManager) is told for a route state. */
enum class SessionStep { NONE, START, UPDATE, END }

object CarGuidanceLogic {
  fun maneuverType(kind: String): CarManeuverType? =
    when (kind) {
      "depart" -> CarManeuverType.DEPART
      "slight-left" -> CarManeuverType.TURN_SLIGHT_LEFT
      "slight-right" -> CarManeuverType.TURN_SLIGHT_RIGHT
      "left" -> CarManeuverType.TURN_LEFT
      "right" -> CarManeuverType.TURN_RIGHT
      "sharp-left" -> CarManeuverType.TURN_SHARP_LEFT
      "sharp-right" -> CarManeuverType.TURN_SHARP_RIGHT
      "keep-left" -> CarManeuverType.KEEP_LEFT
      "keep-right" -> CarManeuverType.KEEP_RIGHT
      "u-turn" -> CarManeuverType.U_TURN_LEFT
      "roundabout" -> CarManeuverType.ROUNDABOUT_CCW
      "arrive" -> CarManeuverType.DESTINATION
      else -> null
    }

  /** A roundabout's exit for the car: 1 when the route didn't count one (the library refuses less). */
  fun roundaboutExit(exit: Int?): Int = maxOf(1, exit ?: 1)

  fun distanceUnit(unit: String): CarDistanceUnit =
    when (unit) {
      "km" -> CarDistanceUnit.KILOMETERS
      "km1" -> CarDistanceUnit.KILOMETERS_P1
      else -> CarDistanceUnit.METERS
    }

  /** The car navigates while a route is planned or followed; arrival and a failed plan end it. */
  fun navigating(route: CarRoute?): Boolean = route != null && (route.status == "planning" || route.status == "active")

  /** Turn-by-turn shows only on a followed route with a maneuver ahead, not while it is planned again. */
  fun showsSteps(route: CarRoute?): Boolean =
    route != null && route.status == "active" && !route.replanning && route.steps.isNotEmpty()

  /**
   * The session's step for a new route state: started when a route begins (the host then shows it in the cluster
   * and stops another app's navigation), the trip sent while it goes on, ended at arrival, a failure or no route.
   */
  fun sessionStep(wasNavigating: Boolean, route: CarRoute?): SessionStep {
    val now = navigating(route)
    return when {
      now && !wasNavigating -> SessionStep.START
      now -> SessionStep.UPDATE
      wasNavigating -> SessionStep.END
      else -> SessionStep.NONE
    }
  }

  /** The visible area as insets from the surface's edges, in the car's density-independent pixels. */
  fun insetsDp(
    width: Int,
    height: Int,
    left: Int,
    top: Int,
    right: Int,
    bottom: Int,
    dpi: Int,
  ): List<Double> {
    val density = (if (dpi > 0) dpi else 160) / 160.0
    return listOf(left, top, width - right, height - bottom).map { maxOf(0, it) / density }
  }
}
