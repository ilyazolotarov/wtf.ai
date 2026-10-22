package ai.wtf.sensorcapture

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext

// React Native's JS timers stop while the app isn't in front (JavaTimerManager pauses with the activity) unless a
// headless JS task is running. A trip lives on timers (the OBD poller's sleeps, the navigator's tick), and with
// another app in front (Waze getting the shared position, docs/ANDROID-SPEC.md §8) they must keep firing: one task,
// registered in JS as `TASK` and never finishing by itself, is held while the trip service runs.
object JsKeepAlive {
  const val TASK = "WtfTripKeepAlive"
  private const val TAG = "WtfJsKeepAlive"

  private var taskId: Int? = null

  fun start(context: ReactContext) {
    UiThreadUtil.runOnUiThread {
      if (taskId != null) return@runOnUiThread
      try {
        // No timeout; allowed in front, where a trip usually starts.
        taskId = HeadlessJsTaskContext.getInstance(context).startTask(HeadlessJsTaskConfig(TASK, Arguments.createMap(), 0, true))
        Log.i(TAG, "started task $taskId")
      } catch (e: Exception) {
        Log.w(TAG, "could not start: ${e.javaClass.simpleName}: ${e.message}")
      }
    }
  }

  fun stop(context: ReactContext) {
    UiThreadUtil.runOnUiThread {
      val id = taskId ?: return@runOnUiThread
      taskId = null
      HeadlessJsTaskContext.getInstance(context).finishTask(id)
      Log.i(TAG, "finished task $id")
    }
  }
}
