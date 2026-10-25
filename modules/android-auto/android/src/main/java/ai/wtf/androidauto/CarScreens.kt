package ai.wtf.androidauto

import ai.wtf.androidauto.logic.CarDistanceUnit
import ai.wtf.androidauto.logic.CarGuidanceLogic
import ai.wtf.androidauto.logic.CarManeuverType
import ai.wtf.androidauto.logic.CarPlace
import ai.wtf.androidauto.logic.CarRoute
import ai.wtf.androidauto.logic.CarStep
import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.constraints.ConstraintManager
import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.CarIcon
import androidx.car.app.model.DateTimeWithZone
import androidx.car.app.model.Distance
import androidx.car.app.model.ItemList
import androidx.car.app.model.ListTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.SectionedItemList
import androidx.car.app.model.Template
import androidx.car.app.navigation.model.Destination
import androidx.car.app.navigation.model.Maneuver
import androidx.car.app.navigation.model.MessageInfo
import androidx.car.app.navigation.model.NavigationTemplate
import androidx.car.app.navigation.model.RoutingInfo
import androidx.car.app.navigation.model.Step
import androidx.car.app.navigation.model.TravelEstimate
import androidx.car.app.navigation.model.Trip
import androidx.core.graphics.drawable.IconCompat
import java.util.TimeZone

/**
 * The car's main screen (docs/ANDROID-AUTO-SPEC.md §4): the map under Android Auto's navigation template, with the next
 * maneuver and the one after, the time and distance left, and the buttons: a destination to pick, or the route to end,
 * and the voice.
 */
internal class NavigationScreen(carContext: CarContext) : Screen(carContext) {
  override fun onGetTemplate(): Template {
    val labels = CarLink.labels
    val route = CarLink.route
    val actions = ActionStrip.Builder()
    if (route != null) {
      actions.addAction(
        Action.Builder()
          .setTitle(labels.endRoute)
          .setIcon(CarTemplates.icon(carContext, R.drawable.car_close))
          .setOnClickListener { CarLink.send("end-route") }
          .build(),
      )
    } else {
      actions.addAction(
        Action.Builder()
          .setTitle(labels.destinations)
          .setIcon(CarTemplates.icon(carContext, R.drawable.car_location_on))
          .setOnClickListener { screenManager.push(DestinationsScreen(carContext)) }
          .build(),
      )
    }
    CarLink.voiceMuted?.let { muted ->
      actions.addAction(
        Action.Builder()
          .setIcon(CarTemplates.icon(carContext, if (muted) R.drawable.car_volume_off else R.drawable.car_volume_up))
          .setOnClickListener { CarLink.send("toggle-voice") }
          .build(),
      )
    }
    val template = NavigationTemplate.Builder().setActionStrip(actions.build())
    when {
      route == null -> Unit
      CarGuidanceLogic.showsSteps(route) -> {
        val next = route.steps[0]
        val info = RoutingInfo.Builder()
          .setCurrentStep(CarTemplates.step(carContext, next), CarTemplates.distance(next.shownDistance, next.shownUnit))
        route.steps.getOrNull(1)?.let { info.setNextStep(CarTemplates.step(carContext, it)) }
        template.setNavigationInfo(info.build())
        template.setDestinationTravelEstimate(CarTemplates.estimate(route.remainingShown, route.remainingUnit, route.remainingS))
      }
      route.status == "planning" || route.replanning -> template.setNavigationInfo(RoutingInfo.Builder().setLoading(true).build())
      else -> {
        val message = MessageInfo.Builder(route.message ?: route.destinationName.ifEmpty { " " })
        if (route.status == "arrived") message.setImage(CarTemplates.icon(carContext, R.drawable.car_flag))
        template.setNavigationInfo(message.build())
      }
    }
    return template.build()
  }
}

/** Saved places and recent destinations; picking one routes to it, as on the phone's route screen. */
internal class DestinationsScreen(carContext: CarContext) : Screen(carContext) {
  @Suppress("DEPRECATION") // setTitle / setHeaderAction: Header needs Car API 7.
  override fun onGetTemplate(): Template {
    val labels = CarLink.labels
    val places = CarLink.places
    val template = ListTemplate.Builder().setTitle(labels.destinations).setHeaderAction(Action.BACK)
    if (places.isEmpty()) {
      template.setSingleList(ItemList.Builder().setNoItemsMessage(labels.noDestinations).build())
      return template.build()
    }
    // The car allows this many rows (fewer while driving); saved places first.
    var left = try {
      carContext.getCarService(ConstraintManager::class.java).getContentLimit(ConstraintManager.CONTENT_LIMIT_TYPE_LIST)
    } catch (e: Exception) {
      6
    }
    val (recent, saved) = places.partition { it.kind == "recent" }
    for ((header, list) in listOf(labels.saved to saved, labels.recent to recent)) {
      if (list.isEmpty() || left <= 0) continue
      val items = ItemList.Builder()
      list.take(left).forEach { items.addItem(row(it)) }
      left -= list.size
      template.addSectionedList(SectionedItemList.create(items.build(), header))
    }
    return template.build()
  }

  private fun row(place: CarPlace): Row {
    val row = Row.Builder()
      .setTitle(place.title.ifEmpty { "·" })
      .setImage(CarTemplates.icon(carContext, CarTemplates.placeIcon(place.kind)))
      .setOnClickListener {
        CarLink.send("go", mapOf("id" to place.id))
        screenManager.pop()
      }
    place.detail?.takeIf { it.isNotEmpty() }?.let { row.addText(it) }
    return row.build()
  }
}

/** The Car App Library's models for what the JS side sent. */
internal object CarTemplates {
  fun icon(context: CarContext, res: Int): CarIcon = CarIcon.Builder(IconCompat.createWithResource(context, res)).build()

  fun placeIcon(kind: String): Int =
    when (kind) {
      "home" -> R.drawable.car_home
      "work" -> R.drawable.car_work
      "favorite" -> R.drawable.car_star
      else -> R.drawable.car_history
    }

  fun step(context: CarContext, step: CarStep): Step = Step.Builder(step.instruction.ifEmpty { " " }).setManeuver(maneuver(context, step)).build()

  fun distance(value: Double, unit: String): Distance =
    Distance.create(
      maxOf(0.0, value),
      when (CarGuidanceLogic.distanceUnit(unit)) {
        CarDistanceUnit.METERS -> Distance.UNIT_METERS
        CarDistanceUnit.KILOMETERS -> Distance.UNIT_KILOMETERS
        CarDistanceUnit.KILOMETERS_P1 -> Distance.UNIT_KILOMETERS_P1
      },
    )

  /** `seconds` from now, at the plan's pace. */
  fun estimate(shown: Double, unit: String, seconds: Double): TravelEstimate {
    val s = maxOf(0.0, seconds)
    val arrival = DateTimeWithZone.create(System.currentTimeMillis() + (s * 1000).toLong(), TimeZone.getDefault())
    return TravelEstimate.Builder(distance(shown, unit), arrival).setRemainingTimeSeconds(s.toLong()).build()
  }

  /**
   * The route for the host's own displays (cluster, heads-up display, the rail when another app is in front): the
   * steps ahead with their times, and the destination. Loading while it is planned or planned again.
   */
  fun trip(context: CarContext, route: CarRoute): Trip {
    val trip = Trip.Builder()
    if (!CarGuidanceLogic.showsSteps(route)) return trip.setLoading(true).build()
    var atS = 0.0
    for (step in route.steps) {
      atS += step.timeS
      trip.addStep(step(context, step), estimate(step.shownDistance, step.shownUnit, atS))
    }
    val name = route.destinationName.ifEmpty { route.message ?: " " }
    trip.addDestination(Destination.Builder().setName(name).build(), estimate(route.remainingShown, route.remainingUnit, route.remainingS))
    return trip.build()
  }

  private fun maneuver(context: CarContext, step: CarStep): Maneuver {
    val type = CarGuidanceLogic.maneuverType(step.kind) ?: CarManeuverType.STRAIGHT
    val maneuver = Maneuver.Builder(typeId(type)).setIcon(icon(context, maneuverIcon(type)))
    if (type == CarManeuverType.ROUNDABOUT_CCW) maneuver.setRoundaboutExitNumber(CarGuidanceLogic.roundaboutExit(step.exit))
    return maneuver.build()
  }

  private fun typeId(type: CarManeuverType): Int =
    when (type) {
      CarManeuverType.DEPART -> Maneuver.TYPE_DEPART
      CarManeuverType.STRAIGHT -> Maneuver.TYPE_STRAIGHT
      CarManeuverType.TURN_SLIGHT_LEFT -> Maneuver.TYPE_TURN_SLIGHT_LEFT
      CarManeuverType.TURN_SLIGHT_RIGHT -> Maneuver.TYPE_TURN_SLIGHT_RIGHT
      CarManeuverType.TURN_LEFT -> Maneuver.TYPE_TURN_NORMAL_LEFT
      CarManeuverType.TURN_RIGHT -> Maneuver.TYPE_TURN_NORMAL_RIGHT
      CarManeuverType.TURN_SHARP_LEFT -> Maneuver.TYPE_TURN_SHARP_LEFT
      CarManeuverType.TURN_SHARP_RIGHT -> Maneuver.TYPE_TURN_SHARP_RIGHT
      CarManeuverType.KEEP_LEFT -> Maneuver.TYPE_KEEP_LEFT
      CarManeuverType.KEEP_RIGHT -> Maneuver.TYPE_KEEP_RIGHT
      CarManeuverType.U_TURN_LEFT -> Maneuver.TYPE_U_TURN_LEFT
      CarManeuverType.ROUNDABOUT_CCW -> Maneuver.TYPE_ROUNDABOUT_ENTER_AND_EXIT_CCW
      CarManeuverType.DESTINATION -> Maneuver.TYPE_DESTINATION
    }

  /** The phone banner's icons (MANEUVER_ICON in src/components/route/guidance-text.ts), drawn by scripts/car-icons.py. */
  private fun maneuverIcon(type: CarManeuverType): Int =
    when (type) {
      CarManeuverType.DEPART, CarManeuverType.STRAIGHT -> R.drawable.car_straight
      CarManeuverType.TURN_SLIGHT_LEFT -> R.drawable.car_turn_slight_left
      CarManeuverType.TURN_SLIGHT_RIGHT -> R.drawable.car_turn_slight_right
      CarManeuverType.TURN_LEFT -> R.drawable.car_turn_left
      CarManeuverType.TURN_RIGHT -> R.drawable.car_turn_right
      CarManeuverType.TURN_SHARP_LEFT -> R.drawable.car_turn_sharp_left
      CarManeuverType.TURN_SHARP_RIGHT -> R.drawable.car_turn_sharp_right
      CarManeuverType.KEEP_LEFT -> R.drawable.car_fork_left
      CarManeuverType.KEEP_RIGHT -> R.drawable.car_fork_right
      CarManeuverType.U_TURN_LEFT -> R.drawable.car_u_turn_left
      CarManeuverType.ROUNDABOUT_CCW -> R.drawable.car_roundabout_left
      CarManeuverType.DESTINATION -> R.drawable.car_flag
    }
}
