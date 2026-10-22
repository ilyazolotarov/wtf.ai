package ai.wtf.sensorcapture

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import java.lang.ref.WeakReference

// React Native's JS timers stop while the app isn't in front (JavaTimerManager pauses with the activity) unless a
// headless JS task is running. A trip lives on timers (the OBD poller's sleeps, the navigator's tick), and with
// another app in front (Waze getting the shared position, docs/ANDROID-SPEC.md §8) they must keep firing: one task,
// registered in JS as `TASK` and never finishing by itself, is held while the trip service runs.
object JsKeepAlive {
  const val TASK = "WtfTripKeepAlive"
  private const val TAG = "WtfJsKeepAlive"

  /**
   * The context the task runs in, and its id. Tasks belong to one React context: a JS reload mid-trip (More → Update's
   * restart) makes a new one, whose timers need a task of their own.
   */
  private var held: WeakReference<ReactContext>? = null
  private var taskId: Int? = null

  fun start(context: ReactContext) {
    UiThreadUtil.runOnUiThread {
      if (taskId != null && held?.get() === context) return@runOnUiThread
      // One from a context before a reload: finished, if that context is still there.
      finishHeld()
      try {
        // No timeout; allowed in front, where a trip usually starts.
        taskId = HeadlessJsTaskContext.getInstance(context).startTask(HeadlessJsTaskConfig(TASK, Arguments.createMap(), 0, true))
        held = WeakReference(context)
        Log.i(TAG, "started task $taskId")
      } catch (e: Exception) {
        Log.w(TAG, "could not start: ${e.javaClass.simpleName}: ${e.message}")
      }
    }
  }

  fun stop() {
    UiThreadUtil.runOnUiThread { finishHeld() }
  }

  private fun finishHeld() {
    val id = taskId ?: return
    val context = held?.get()
    taskId = null
    held = null
    if (context == null) return
    try {
      HeadlessJsTaskContext.getInstance(context).finishTask(id)
      Log.i(TAG, "finished task $id")
    } catch (e: Exception) {
      Log.w(TAG, "could not finish task $id: ${e.javaClass.simpleName}: ${e.message}")
    }
  }
}
