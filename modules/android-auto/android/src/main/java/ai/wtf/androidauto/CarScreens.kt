package ai.wtf.androidauto

import ai.wtf.androidauto.logic.CarAlternative
import ai.wtf.androidauto.logic.CarCard
import ai.wtf.androidauto.logic.CarDistanceUnit
import ai.wtf.androidauto.logic.CarGuidanceLogic
import ai.wtf.androidauto.logic.CarManeuverType
import ai.wtf.androidauto.logic.CarNoticeButtons
import ai.wtf.androidauto.logic.CarPlace
import ai.wtf.androidauto.logic.CarRoute
import ai.wtf.androidauto.logic.CarSearchList
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
import androidx.car.app.model.ParkedOnlyOnClickListener
import androidx.car.app.model.Row
import androidx.car.app.model.SearchTemplate
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
 * maneuver and the one after, the time and distance left, and the buttons: a place to search for or pick, or the route
 * to end, and the voice. What the driver must do first (download a map, allow location, agree to a route without an
 * adapter) comes before.
 */
internal class NavigationScreen(carContext: CarContext) : Screen(carContext) {
  override fun onGetTemplate(): Template {
    val labels = CarLink.labels
    val route = CarLink.route
    val notice = CarLink.shownNotice
    val card = CarGuidanceLogic.card(route, notice)
    val actions = ActionStrip.Builder()
    if (card == CarCard.NOTICE && notice != null) {
      noticeActions(notice.kind, notice.action).forEach { actions.addAction(it) }
    } else if (route != null) {
      actions.addAction(
        Action.Builder()
          .setTitle(labels.endRoute)
          .setIcon(CarTemplates.icon(carContext, R.drawable.car_close))
          .setOnClickListener { CarLink.send("end-route") }
          .build(),
      )
      if (CarGuidanceLogic.showsRoutes(route, card)) {
        actions.addAction(
          Action.Builder()
            .setIcon(CarTemplates.icon(carContext, R.drawable.car_alt_route))
            .setOnClickListener { screenManager.push(RoutesScreen(carContext)) }
            .build(),
        )
      }
    } else {
      actions.addAction(
        Action.Builder()
          .setIcon(CarTemplates.icon(carContext, R.drawable.car_search))
          .setOnClickListener { screenManager.push(SearchScreen(carContext, "", keyboard = true)) }
          .build(),
      )
      actions.addAction(
        Action.Builder()
          .setTitle(labels.destinations)
          .setIcon(CarTemplates.icon(carContext, R.drawable.car_location_on))
          .setOnClickListener { screenManager.push(DestinationsScreen(carContext)) }
          .build(),
      )
    }
    // No route to speak while a notice shows; its buttons need the room.
    CarLink.voiceMuted?.takeIf { card != CarCard.NOTICE }?.let { muted ->
      actions.addAction(
        Action.Builder()
          .setIcon(CarTemplates.icon(carContext, if (muted) R.drawable.car_volume_off else R.drawable.car_volume_up))
          .setOnClickListener { CarLink.send("toggle-voice") }
          .build(),
      )
    }
    val template = NavigationTemplate.Builder()
      .setActionStrip(actions.build())
      .setMapActionStrip(mapActions())
      // The host's pan mode (rotary and touchpad cars): its gestures come as on a touch screen; the camera is the JS map's.
      .setPanModeListener { panning -> CarLink.note("map pan mode ${if (panning) "on" else "off"}") }
    when (card) {
      CarCard.NONE -> Unit
      CarCard.NOTICE -> {
        val n = notice!!
        val icon = when (n.kind) {
          CarLink.NOTICE_LOCATION -> R.drawable.car_location_off
          CarLink.NOTICE_NO_MAP -> R.drawable.car_map
          else -> R.drawable.car_alt_route
        }
        val message = MessageInfo.Builder(n.title.ifEmpty { " " }).setImage(CarTemplates.icon(carContext, icon))
        if (n.text.isNotEmpty()) message.setText(n.text)
        template.setNavigationInfo(message.build())
      }
      CarCard.STEPS -> {
        val r = route!!
        val next = r.steps[0]
        val info = RoutingInfo.Builder()
          .setCurrentStep(CarTemplates.step(carContext, next), CarTemplates.distance(next.shownDistance, next.shownUnit))
        r.steps.getOrNull(1)?.let { info.setNextStep(CarTemplates.step(carContext, it)) }
        template.setNavigationInfo(info.build())
        template.setDestinationTravelEstimate(CarTemplates.estimate(r.remainingShown, r.remainingUnit, r.remainingS))
      }
      CarCard.LOADING -> template.setNavigationInfo(RoutingInfo.Builder().setLoading(true).build())
      CarCard.MESSAGE -> {
        val r = route!!
        val message = MessageInfo.Builder(r.message ?: r.destinationName.ifEmpty { " " })
        if (r.status == "arrived") message.setImage(CarTemplates.icon(carContext, R.drawable.car_flag))
        template.setNavigationInfo(message.build())
      }
    }
    return template.build()
  }

  /**
   * The map's buttons (ANDROID-AUTO-SPEC §4): pan (on a touch screen the host shows none, the map takes the finger),
   * zoom in and out, and recentre while the driver has moved the map or zoomed it from the follow zoom. The camera is the JS map's (`onMapGesture`).
   */
  private fun mapActions(): ActionStrip {
    val strip = ActionStrip.Builder().addAction(Action.PAN)
    if (CarLink.recentre) strip.addAction(mapAction(R.drawable.car_my_location, mapOf("kind" to "recentre")))
    strip.addAction(mapAction(R.drawable.car_add, mapOf("kind" to "zoom", "by" to 1)))
    strip.addAction(mapAction(R.drawable.car_remove, mapOf("kind" to "zoom", "by" to -1)))
    return strip.build()
  }

  private fun mapAction(icon: Int, gesture: Map<String, Any?>) =
    Action.Builder().setIcon(CarTemplates.icon(carContext, icon)).setOnClickListener { CarLink.gesture(gesture) }.build()

  /**
   * The notice's buttons, never none (the action strip throws). Location: Android's permission dialog on the phone,
   * parked only (the host says so while the car moves). A route without an adapter: the driver's word, or the route
   * dropped. No map, or a kind this build doesn't know: Close, the map and its buttons back.
   */
  private fun noticeActions(kind: String, title: String): List<Action> =
    when (CarGuidanceLogic.noticeButtons(kind)) {
      CarNoticeButtons.ALLOW -> listOf(
        Action.Builder()
          .setTitle(title)
          .setIcon(CarTemplates.icon(carContext, R.drawable.car_location_on))
          .setOnClickListener(ParkedOnlyOnClickListener.create { CarLink.session?.requestLocation() })
          .build(),
      )
      CarNoticeButtons.CONFIRM_OR_CANCEL -> listOf(
        Action.Builder()
          .setTitle(title)
          .setIcon(CarTemplates.icon(carContext, R.drawable.car_navigation))
          .setOnClickListener { CarLink.send("confirm-held") }
          .build(),
        Action.Builder()
          .setIcon(CarTemplates.icon(carContext, R.drawable.car_close))
          .setOnClickListener { CarLink.send("cancel-held") }
          .build(),
      )
      CarNoticeButtons.CLOSE -> listOf(
        Action.Builder()
          .apply { if (title.isNotEmpty()) setTitle(title) }
          .setIcon(CarTemplates.icon(carContext, R.drawable.car_close))
          .setOnClickListener { CarLink.closeNotice() }
          .build(),
      )
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
    // Saved places first.
    var left = CarTemplates.listLimit(carContext)
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

/**
 * The route's other ways (ROUTING-SPEC §8.7, docs/ANDROID-AUTO-SPEC.md §4): the route followed first, then each
 * alternative, each by the street it goes by, its time against the route and its own; one picked is followed instead.
 */
internal class RoutesScreen(carContext: CarContext) : Screen(carContext) {
  @Suppress("DEPRECATION") // setTitle / setHeaderAction: Header needs Car API 7.
  override fun onGetTemplate(): Template {
    val labels = CarLink.labels
    val route = CarLink.route
    val template = ListTemplate.Builder().setTitle(labels.routes).setHeaderAction(Action.BACK)
    val items = ItemList.Builder()
    // The route followed, even once its alternatives are gone (then nothing else to pick).
    val current = Row.Builder().setTitle(route?.title?.ifEmpty { null } ?: labels.thisRoute).setImage(CarTemplates.icon(carContext, R.drawable.car_navigation))
    route?.detail?.takeIf { it.isNotEmpty() }?.let { current.addText(it) }
    items.addItem(current.setOnClickListener { screenManager.pop() }.build())
    route?.alternatives?.take(CarTemplates.listLimit(carContext) - 1)?.forEach { items.addItem(row(it)) }
    return template.setSingleList(items.build()).build()
  }

  private fun row(alternative: CarAlternative): Row =
    Row.Builder()
      .setTitle(alternative.title.ifEmpty { "·" })
      .addText(alternative.detail.ifEmpty { " " })
      .setImage(CarTemplates.icon(carContext, R.drawable.car_alt_route))
      .setOnClickListener {
        CarLink.send("choose-alternative", mapOf("index" to alternative.index))
        screenManager.pop()
      }
      .build()
}

/**
 * Search (docs/ANDROID-AUTO-SPEC.md §4): the phone's offline search as the driver types, or the answers to a place the
 * car's assistant asked for (`typed` given, no keyboard); with nothing typed, the destinations. The host offers the
 * keyboard only while parked; picking a result routes to it, as a destination does.
 */
internal class SearchScreen(carContext: CarContext, private var typed: String, private val keyboard: Boolean) : Screen(carContext) {
  init {
    if (typed.isNotBlank()) CarLink.send("search", mapOf("text" to typed))
  }

  override fun onGetTemplate(): Template {
    val labels = CarLink.labels
    val template = SearchTemplate.Builder(
      object : SearchTemplate.SearchCallback {
        override fun onSearchTextChanged(searchText: String) = search(searchText)

        override fun onSearchSubmitted(searchText: String) = search(searchText)
      },
    )
      .setHeaderAction(Action.BACK)
      .setSearchHint(labels.searchHint)
      .setInitialSearchText(typed)
      .setShowKeyboardByDefault(keyboard)
    when (val list = CarGuidanceLogic.searchList(CarLink.search, typed)) {
      CarSearchList.Empty -> {
        val items = ItemList.Builder().setNoItemsMessage(labels.noDestinations)
        CarLink.places.take(CarTemplates.listLimit(carContext)).forEach { items.addItem(row(it)) }
        template.setItemList(items.build())
      }
      CarSearchList.Loading -> template.setLoading(true)
      is CarSearchList.Results -> {
        val items = ItemList.Builder().setNoItemsMessage(labels.noResults)
        list.places.take(CarTemplates.listLimit(carContext)).forEach { items.addItem(row(it)) }
        template.setItemList(items.build())
      }
    }
    return template.build()
  }

  private fun search(text: String) {
    if (text == typed) return
    typed = text
    CarLink.send("search", mapOf("text" to text))
    invalidate()
  }

  private fun row(place: CarPlace): Row {
    val row = Row.Builder()
      .setTitle(place.title.ifEmpty { "·" })
      .setImage(CarTemplates.icon(carContext, CarTemplates.placeIcon(place.kind)))
      .setOnClickListener {
        CarLink.send("go", mapOf("id" to place.id))
        screenManager.popToRoot()
      }
    place.detail?.takeIf { it.isNotEmpty() }?.let { row.addText(it) }
    return row.build()
  }
}

/** The Car App Library's models for what the JS side sent. */
internal object CarTemplates {
  fun icon(context: CarContext, res: Int): CarIcon = CarIcon.Builder(IconCompat.createWithResource(context, res)).build()

  /** The rows a list may have in this car (fewer while driving). */
  fun listLimit(context: CarContext): Int =
    try {
      context.getCarService(ConstraintManager::class.java).getContentLimit(ConstraintManager.CONTENT_LIMIT_TYPE_LIST)
    } catch (e: Exception) {
      6
    }

  fun placeIcon(kind: String): Int =
    when (kind) {
      "home" -> R.drawable.car_home
      "work" -> R.drawable.car_work
      "favorite" -> R.drawable.car_star
      "result" -> R.drawable.car_location_on
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
   * steps ahead, each with its distance and time from the car, and the destination. Loading while it is planned or
   * planned again.
   */
  fun trip(context: CarContext, route: CarRoute): Trip {
    val trip = Trip.Builder()
    if (!CarGuidanceLogic.showsSteps(route)) return trip.setLoading(true).build()
    for (step in route.steps) {
      trip.addStep(step(context, step), estimate(step.shownDistance, step.shownUnit, step.timeS))
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
  fun maneuverIcon(type: CarManeuverType): Int =
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
