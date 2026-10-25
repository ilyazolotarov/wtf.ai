package ai.wtf.androidauto

import ai.wtf.androidauto.logic.CarLabels
import ai.wtf.androidauto.logic.CarPlace
import ai.wtf.androidauto.logic.CarRoute
import ai.wtf.androidauto.logic.CarStep
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

// The car's screen for the JS side (docs/ANDROID-AUTO-SPEC.md §4): what it shows, sent by the car session's task
// (src/services/car-screen), and what the driver did there, as `onCarAction`. Android only; what to show is TypeScript.

class CarStepRecord : Record {
  @Field var kind: String = ""
  @Field var exit: Int? = null
  @Field var instruction: String = ""
  @Field var distanceM: Double = 0.0
  @Field var timeS: Double = 0.0
  @Field var shownDistance: Double = 0.0
  @Field var shownUnit: String = "m"
}

class CarRouteRecord : Record {
  @Field var status: String = "planning"
  @Field var message: String? = null
  @Field var destinationName: String = ""
  @Field var replanning: Boolean = false
  @Field var steps: List<CarStepRecord> = emptyList()
  @Field var remainingM: Double = 0.0
  @Field var remainingS: Double = 0.0
  @Field var remainingShown: Double = 0.0
  @Field var remainingUnit: String = "m"
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
  @Field var voiceOn: String = ""
  @Field var voiceOff: String = ""
  @Field var notification: String = ""
}

class AndroidAutoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AndroidAuto")

    Events("onCarAction")

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
          voiceOn = labels.voiceOn.ifEmpty { d.voiceOn },
          voiceOff = labels.voiceOff.ifEmpty { d.voiceOff },
          notification = labels.notification.ifEmpty { d.notification },
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
            steps = r.steps.map { CarStep(it.kind, it.exit, it.instruction, it.distanceM, it.timeS, it.shownDistance, it.shownUnit) },
            remainingM = r.remainingM,
            remainingS = r.remainingS,
            remainingShown = r.remainingShown,
            remainingUnit = r.remainingUnit,
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
  }
}
