package ai.wtf.androidauto

import ai.wtf.androidauto.logic.CarLabels
import ai.wtf.androidauto.logic.CarNotice
import ai.wtf.androidauto.logic.CarPlace
import ai.wtf.androidauto.logic.CarRoute
import android.util.Log

/**
 * Between the JS side and the car (docs/ANDROID-AUTO-SPEC.md §4): what the car's screen shows, as the car session's
 * task last sent it through AndroidAutoModule, and what the driver did there, sent back as the module's events. The
 * car's session and the JS runtime come and go independently, so the state is kept here for whichever comes next.
 * Main thread only, but for `session`, which the JS thread reads.
 */
internal object CarLink {
  const val TAG = "WtfAndroidAuto"

  /** Notes kept for the JS side at most: the oldest go first. */
  private const val MAX_NOTES = 50

  var labels = CarLabels()
    private set
  var route: CarRoute? = null
    private set
  var places: List<CarPlace> = emptyList()
    private set

  /** Spoken guidance: muted or not; null: no voice (its volume is 0), no button. */
  var voiceMuted: Boolean? = null
    private set

  /** What the driver must do first, shown instead of the route; null: nothing. */
  var notice: CarNotice? = null
    private set

  /** The connected car's session, while there is one. */
  @Volatile
  var session: CarScreenSession? = null

  /** The JS side's listener (AndroidAutoModule's events); null while no JS runtime has the module. */
  var emit: ((event: String, body: Map<String, Any?>) -> Unit)? = null

  /** What happened on the native side, for the trip log; `problem`: also reported (Sentry). */
  data class Note(val text: String, val problem: Boolean)

  private val notes = ArrayDeque<Note>()

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

  fun setNotice(value: CarNotice?) {
    if (value == notice) return
    val wasLocation = notice?.kind == NOTICE_LOCATION
    notice = value
    val session = session ?: return
    // Allowed now (on the phone, or by the car's button): the session holds location from here.
    if (wasLocation && value?.kind != NOTICE_LOCATION) session.locationAllowed()
    session.refresh()
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

  /**
   * A note for the trip log, kept until the JS side takes it (`takeNotes`): the session's task may not run yet, or
   * not listen yet. `problem`: what went wrong, reported too.
   */
  fun note(text: String, problem: Boolean = false) {
    if (problem) Log.w(TAG, text) else Log.i(TAG, text)
    notes.addLast(Note(text, problem))
    while (notes.size > MAX_NOTES) notes.removeFirst()
    emit?.invoke("onCarAction", mapOf("action" to "notes"))
  }

  /** The notes since the last call, oldest first. */
  fun takeNotes(): List<Note> {
    val taken = notes.toList()
    notes.clear()
    return taken
  }

  /** `CarNotice.kind`s. */
  const val NOTICE_LOCATION = "location"
  const val NOTICE_HELD_ROUTE = "held-route"
}
