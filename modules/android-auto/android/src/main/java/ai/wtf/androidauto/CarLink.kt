package ai.wtf.androidauto

import ai.wtf.androidauto.logic.CarLabels
import ai.wtf.androidauto.logic.CarPlace
import ai.wtf.androidauto.logic.CarRoute
import android.util.Log

/**
 * Between the JS side and the car (docs/ANDROID-AUTO-SPEC.md §4): what the car's screen shows, as the car screen's React
 * root last sent it through AndroidAutoModule, and what the driver did there, sent back as the module's events. The
 * car's session and the JS runtime come and go independently, so the state is kept here for whichever comes next.
 * Main thread only.
 */
internal object CarLink {
  const val TAG = "WtfAndroidAuto"

  var labels = CarLabels()
    private set
  var route: CarRoute? = null
    private set
  var places: List<CarPlace> = emptyList()
    private set

  /** Spoken guidance: muted or not; null: no voice (its volume is 0), no button. */
  var voiceMuted: Boolean? = null
    private set

  /** The connected car's session, while there is one. */
  var session: CarScreenSession? = null

  /** The JS side's listener (AndroidAutoModule's events); null while no JS runtime has the module. */
  var emit: ((event: String, body: Map<String, Any?>) -> Unit)? = null

  fun setLabels(value: CarLabels) {
    if (value == labels) return
    labels = value
    session?.refresh()
  }

  fun setRoute(value: CarRoute?) {
    if (value == route) return
    route = value
    session?.routeChanged()
  }

  fun setPlaces(value: List<CarPlace>) {
    if (value == places) return
    places = value
    session?.refresh()
  }

  fun setVoiceMuted(value: Boolean?) {
    if (value == voiceMuted) return
    voiceMuted = value
    session?.refresh()
  }

  /** The driver's action on the car's screen, or the host's, for the JS side. */
  fun send(action: String, body: Map<String, Any?> = emptyMap()) {
    Log.i(TAG, "action $action")
    val emit = emit
    if (emit == null) {
      Log.w(TAG, "no JS runtime for $action")
      return
    }
    emit("onCarAction", body + ("action" to action))
  }
}
