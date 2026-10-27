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
  /** From the car, m, and the time to it at the plan's pace, s (the trip's estimates for the car's other displays). */
  val distanceM: Double,
  val timeS: Double,
  /** The distance from the car as the phone's banner rounds it: a value and "m", "km" or "km1" (one decimal). */
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

/** A destination to pick on the car's screen: a saved place, a recent one, or a search result (`result`). */
data class CarPlace(val id: String, val title: String, val detail: String?, val kind: String)

/** What the car's search found (the JS side's offline search), and the text it answers. */
data class CarSearch(val query: String, val results: List<CarPlace>)

/** The search screen's list for the text typed now. */
sealed interface CarSearchList {
  /** Nothing typed: no list. */
  object Empty : CarSearchList

  /** Typed, not answered yet: the loading list. */
  object Loading : CarSearchList

  /** The answer (empty: the "nothing found" message). */
  data class Results(val places: List<CarPlace>) : CarSearchList
}

/** The car's own words, in the app's language (the JS side's strings; English until it sends them). */
data class CarLabels(
  val endRoute: String = "Stop guidance",
  val destinations: String = "Destinations",
  val saved: String = "Saved",
  val recent: String = "Recent",
  val noDestinations: String = "Saved places and recent destinations from your phone will appear here.",
  val search: String = "Search",
  val searchHint: String = "Search addresses and places",
  val noResults: String = "Nothing found in the downloaded region",
  /** Shown when the car sends the driver to the phone (the permission dialog): quality guideline VI-1. */
  val checkPhone: String = "Check your phone only when it's safe.",
  /** The phone's notification while the car session holds location (CarLocationService). */
  val notification: String = "Tracks your car's position even when another app is open in Android Auto.",
)

/**
 * What the driver must do before the car can guide, shown instead of the route (the JS side decides when):
 * `location`: the app has no location permission (its button asks for it, parked only); `held-route`: a route picked
 * without an adapter waits for the driver's word (its button gives it, the close button drops the route).
 */
data class CarNotice(val kind: String, val title: String, val text: String, val action: String)

/** The navigation template's card. */
enum class CarCard {
  /** The map alone. */
  NONE,
  /** CarNotice's message, its button instead of Destinations. */
  NOTICE,
  /** The next maneuver and the trip's estimate. */
  STEPS,
  /** A route planned, or planned again: the loading card. */
  LOADING,
  /** Arrival or a failed plan: a message. */
  MESSAGE,
}

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

  /** The results shown answer the text typed (an older text's would mislead); none yet while it is searched. */
  fun searchList(search: CarSearch?, typed: String): CarSearchList {
    val text = typed.trim()
    return when {
      text.isEmpty() -> CarSearchList.Empty
      search == null || search.query.trim() != text -> CarSearchList.Loading
      else -> CarSearchList.Results(search.results)
    }
  }

  /** A notice comes first: the route can't be followed until the driver has done what it asks. */
  fun card(route: CarRoute?, notice: CarNotice?): CarCard =
    when {
      notice != null -> CarCard.NOTICE
      route == null -> CarCard.NONE
      showsSteps(route) -> CarCard.STEPS
      route.status == "planning" || route.replanning -> CarCard.LOADING
      else -> CarCard.MESSAGE
    }

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

  /**
   * The car's map is drawn this many times the car's density: Android for Cars asks 36 dp for markers (the dot is
   * 26 dp on the phone) and 24 dp for text off the roads; the map zooms out by as much to show the same ground.
   */
  const val MAP_SCALE = 1.4

  /** The map's display density for the car's: 160 when the host gives none. */
  fun mapDpi(dpi: Int): Int = Math.round((if (dpi > 0) dpi else 160) * MAP_SCALE).toInt()

  /** The visible area as insets from the surface's edges, in the map display's density-independent pixels. */
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
