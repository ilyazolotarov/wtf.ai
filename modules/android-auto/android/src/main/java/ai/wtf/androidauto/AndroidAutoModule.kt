package ai.wtf.androidauto

import ai.wtf.androidauto.logic.CarAlternative
import ai.wtf.androidauto.logic.CarLabels
import ai.wtf.androidauto.logic.CarNotice
import ai.wtf.androidauto.logic.CarPlace
import ai.wtf.androidauto.logic.CarRoute
import ai.wtf.androidauto.logic.CarSearch
import ai.wtf.androidauto.logic.CarStep
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

// The car's screen for the JS side (docs/ANDROID-AUTO-SPEC.md §4): what it shows, sent by the car session's task
// (src/components/car-screen), and what the driver did there, as `onCarAction`. Android only; what to show is
// TypeScript.

class CarStepRecord : Record {
  @Field var id: String = ""
  @Field var kind: String = ""
  @Field var exit: Int? = null
  @Field var instruction: String = ""
  @Field var distanceM: Double = 0.0
  @Field var timeS: Double = 0.0
  @Field var shownDistance: Double = 0.0
  @Field var shownUnit: String = "m"
  @Field var distanceText: String = ""
}

class CarRouteRecord : Record {
  @Field var status: String = "planning"
  @Field var message: String? = null
  @Field var destinationName: String = ""
  @Field var replanning: Boolean = false
  @Field var quiet: Boolean = false
  @Field var steps: List<CarStepRecord> = emptyList()
  @Field var remainingM: Double = 0.0
  @Field var remainingS: Double = 0.0
  @Field var remainingShown: Double = 0.0
  @Field var remainingUnit: String = "m"
  @Field var title: String = ""
  @Field var detail: String = ""
  @Field var alternatives: List<CarAlternativeRecord> = emptyList()
}

class CarAlternativeRecord : Record {
  @Field var index: Int = 0
  @Field var title: String = ""
  @Field var detail: String = ""
}

class CarPlaceRecord : Record {
  @Field var id: String = ""
  @Field var title: String = ""
  @Field var detail: String? = null
  @Field var kind: String = "recent"
}

class CarLabelsRecord : Record {
  @Field var endRoute: String = ""
  @Field var destinations: String = ""
  @Field var saved: String = ""
  @Field var recent: String = ""
  @Field var noDestinations: String = ""
  @Field var search: String = ""
  @Field var searchHint: String = ""
  @Field var noResults: String = ""
  @Field var checkPhone: String = ""
  @Field var notification: String = ""
  @Field var routes: String = ""
  @Field var thisRoute: String = ""
}

class CarSearchRecord : Record {
  @Field var query: String = ""
  @Field var results: List<CarPlaceRecord> = emptyList()
}

class CarNoticeRecord : Record {
  @Field var kind: String = ""
  @Field var title: String = ""
  @Field var text: String = ""
  @Field var action: String = ""
}

class AndroidAutoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AndroidAuto")

    Events("onCarAction", "onMapGesture")

    OnCreate {
      CarLink.emit = { event, body -> sendEvent(event, body) }
    }

    OnDestroy {
      CarLink.emit = null
    }

    /** A car's screen is connected to the app now (its session is open). */
    Function("isConnected") { CarLink.session != null }

    AsyncFunction("setLabels") { labels: CarLabelsRecord ->
      val d = CarLabels()
      CarLink.setLabels(
        CarLabels(
          endRoute = labels.endRoute.ifEmpty { d.endRoute },
          destinations = labels.destinations.ifEmpty { d.destinations },
          saved = labels.saved.ifEmpty { d.saved },
          recent = labels.recent.ifEmpty { d.recent },
          noDestinations = labels.noDestinations.ifEmpty { d.noDestinations },
          search = labels.search.ifEmpty { d.search },
          searchHint = labels.searchHint.ifEmpty { d.searchHint },
          noResults = labels.noResults.ifEmpty { d.noResults },
          checkPhone = labels.checkPhone.ifEmpty { d.checkPhone },
          notification = labels.notification.ifEmpty { d.notification },
          routes = labels.routes.ifEmpty { d.routes },
          thisRoute = labels.thisRoute.ifEmpty { d.thisRoute },
        ),
      )
    }.runOnQueue(Queues.MAIN)

    /** The route to show, or null: none. */
    AsyncFunction("setRoute") { route: CarRouteRecord? ->
      CarLink.setRoute(
        route?.let { r ->
          CarRoute(
            status = r.status,
            message = r.message,
            destinationName = r.destinationName,
            replanning = r.replanning,
            quiet = r.quiet,
            steps = r.steps.map {
              CarStep(it.id, it.kind, it.exit, it.instruction, it.distanceM, it.timeS, it.shownDistance, it.shownUnit, it.distanceText)
            },
            remainingM = r.remainingM,
            remainingS = r.remainingS,
            remainingShown = r.remainingShown,
            remainingUnit = r.remainingUnit,
            title = r.title,
            detail = r.detail,
            alternatives = r.alternatives.map { CarAlternative(it.index, it.title, it.detail) },
          )
        },
      )
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("setPlaces") { places: List<CarPlaceRecord> ->
      CarLink.setPlaces(places.map { CarPlace(it.id, it.title, it.detail, it.kind) })
    }.runOnQueue(Queues.MAIN)

    /** Muted or not; null: no voice, no button. */
    AsyncFunction("setVoiceMuted") { muted: Boolean? ->
      CarLink.setVoiceMuted(muted)
    }.runOnQueue(Queues.MAIN)

    /** The recentre button: shown while the driver has moved the car's map or zoomed it from the follow zoom. */
    AsyncFunction("setRecentre") { shown: Boolean ->
      CarLink.setRecentre(shown)
    }.runOnQueue(Queues.MAIN)

    /** What the driver must do first (`location`, `held-route`), shown instead of the route; null: nothing. */
    AsyncFunction("setNotice") { notice: CarNoticeRecord? ->
      CarLink.setNotice(notice?.let { CarNotice(it.kind, it.title, it.text, it.action) })
    }.runOnQueue(Queues.MAIN)

    /** What the search screen's text found; null: nothing searched. */
    AsyncFunction("setSearch") { search: CarSearchRecord? ->
      CarLink.setSearch(search?.let { r -> CarSearch(r.query, r.results.map { CarPlace(it.id, it.title, it.detail, it.kind) }) })
    }.runOnQueue(Queues.MAIN)

    /** The search screen with `query` typed, over the map (after `setSearch` with its answers). */
    AsyncFunction("openSearch") { query: String ->
      CarLink.openSearch(query)
    }.runOnQueue(Queues.MAIN)

    /** The map, with a list or the search open over it gone (a place asked for is gone to). */
    AsyncFunction("showMap") {
      CarLink.showMap()
    }.runOnQueue(Queues.MAIN)

    /** The car's map has drawn its style: the map data credit shows from now (CarMapSurface). */
    AsyncFunction("mapDrawn") {
      CarLink.mapDrawn()
    }.runOnQueue(Queues.MAIN)

    /** A place the car's assistant or another app asked for, once: `{ navigate, uri }`, or null. */
    AsyncFunction("takeRequest") {
      CarLink.takeRequest()?.let { mapOf("navigate" to it.navigate, "uri" to it.uri) }
    }.runOnQueue(Queues.MAIN)

    /** The native side's notes since the last call, for the trip log (`problem`: reported too). */
    AsyncFunction("takeNotes") {
      CarLink.takeNotes().map { mapOf("text" to it.text, "problem" to it.problem) }
    }.runOnQueue(Queues.MAIN)
  }
}
