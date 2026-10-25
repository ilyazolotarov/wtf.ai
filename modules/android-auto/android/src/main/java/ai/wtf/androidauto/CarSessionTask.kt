package ai.wtf.androidauto

import android.app.Application
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext

/**
 * The JS side of a car session (docs/ANDROID-AUTO-SPEC.md §3): the headless task `TASK` (src/services/car-screen),
 * run while the car's screen is connected, whatever the car shows. It sends the route to the car and speaks it, so it
 * can't live in the map's React root, which Android Auto destroys when the driver opens another app there. Running, it
 * also keeps React Native's timers firing with no activity in front (JavaTimerManager), as JsKeepAlive does for trips.
 *
 * React Native starts without a screen if the app isn't open. A JS reload makes a new React context: the task starts
 * again in each one while the session lasts. It ends in JS, on the `session-ended` action.
 */
internal object CarSessionTask {
  const val TASK = "WtfCarSession"

  private var host: com.facebook.react.ReactHost? = null
  private val listener =
    object : ReactInstanceEventListener {
      override fun onReactContextInitialized(context: ReactContext) {
        run(context)
      }
    }

  fun start(app: Application) {
    UiThreadUtil.assertOnUiThread()
    val host = (app as? ReactApplication)?.reactHost ?: return Unit.also { Log.w(CarLink.TAG, "no React host") }
    if (this.host != null) return
    this.host = host
    host.addReactInstanceEventListener(listener)
    val context = host.currentReactContext
    if (context != null) run(context) else host.start()
  }

  /** The session is over: the task ends itself on `session-ended`; no new context starts another. */
  fun stop() {
    UiThreadUtil.assertOnUiThread()
    host?.removeReactInstanceEventListener(listener)
    host = null
    CarLink.send("session-ended")
  }

  private fun run(context: ReactContext) {
    UiThreadUtil.runOnUiThread {
      if (host == null) return@runOnUiThread
      try {
        // No timeout: the task lasts as long as the car's screen. Allowed in front: the phone's app may be open.
        val id = HeadlessJsTaskContext.getInstance(context).startTask(HeadlessJsTaskConfig(TASK, Arguments.createMap(), 0, true))
        Log.i(CarLink.TAG, "session task $id started")
      } catch (e: Exception) {
        Log.w(CarLink.TAG, "session task failed to start: ${e.javaClass.simpleName}: ${e.message}")
      }
    }
  }
}
