package ai.wtf.vehiclelink

import ai.wtf.vehiclelink.logic.WakeLogic
import android.app.Application
import android.companion.AssociationInfo
import android.companion.CompanionDeviceService
import android.companion.DevicePresenceEvent
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.annotation.RequiresApi
import com.facebook.react.ReactApplication
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.jstasks.HeadlessJsTaskEventListener

// Android binds this when an associated device appears (CompanionWake, docs/VEHICLE-LINK-SPEC.md §11), starting the
// process if it isn't running, and keeps the binding while the device stays. The JS task `VehicleWake` then starts the
// runtime and connects the adapter; a trip that starts records in the background under the trip service.
@RequiresApi(31)
class WakeService : CompanionDeviceService() {
  companion object {
    private const val TAG = "WtfWakeService"
    private val repeats = WakeLogic.Repeats()
  }

  private val main = Handler(Looper.getMainLooper())
  private var told = false

  override fun onCreate() {
    super.onCreate()
    // Only when this bind started the process: bound again with the app running (observing starts with the device
    // present, a rebind), the app has connected by itself.
    val fresh = (application as? ReactApplication)?.reactHost?.currentReactContext == null
    if (fresh) main.postDelayed({ if (!told) appeared(WakeLogic.HOW_REBOUND) }, WakeLogic.REBOUND_AFTER_MS)
  }

  override fun onDestroy() {
    main.removeCallbacksAndMessages(null)
    super.onDestroy()
  }

  @Deprecated("Android 13+ calls the AssociationInfo one")
  override fun onDeviceAppeared(address: String) = legacyAppeared()

  // Android 12 declares both abstract: without this, a disappearance there would crash the process.
  @Deprecated("Android 13+ calls the AssociationInfo one")
  override fun onDeviceDisappeared(address: String) = Unit

  @Deprecated("Android 16+ calls onDevicePresenceEvent")
  @RequiresApi(33)
  override fun onDeviceAppeared(associationInfo: AssociationInfo) = legacyAppeared()

  @RequiresApi(33)
  @Deprecated("Android 16+ calls onDevicePresenceEvent")
  override fun onDeviceDisappeared(associationInfo: AssociationInfo) = Unit

  @RequiresApi(36)
  override fun onDevicePresenceEvent(event: DevicePresenceEvent) {
    val ble = event.event == DevicePresenceEvent.EVENT_BLE_APPEARED
    val bt = event.event == DevicePresenceEvent.EVENT_BT_CONNECTED
    if (ble || bt) {
      told = true
      appeared(WakeLogic.how(ble, bt))
    }
  }

  private fun legacyAppeared() {
    told = true
    val how = WakeLogic.how(null, null)
    if (Build.VERSION.SDK_INT >= 36) main.postDelayed({ appeared(how) }, WakeLogic.LEGACY_DELAY_MS)
    else appeared(how)
  }

  private fun appeared(how: String) {
    synchronized(repeats) { if (!repeats.fresh(SystemClock.elapsedRealtime())) return }
    Log.i(TAG, "woken: $how")
    WakeTask.start(application, how)
  }
}

/** Runs the JS task `VehicleWake`, starting React Native without a screen if the app isn't open. */
object WakeTask {
  private const val TAG = "WtfWakeTask"

  fun start(app: Application, how: String) {
    val host = (app as? ReactApplication)?.reactHost ?: return Unit.also { Log.w(TAG, "no React host") }
    // The CPU stays up while the task connects; the trip service holds its own lock once a trip records.
    val lock = (app.getSystemService(Context.POWER_SERVICE) as PowerManager)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "wtfai:wake")
      .apply { setReferenceCounted(false); acquire(WakeLogic.TASK_TIMEOUT_MS) }
    UiThreadUtil.runOnUiThread {
      val context = host.currentReactContext
      if (context != null) {
        run(context, how, lock)
      } else {
        host.addReactInstanceEventListener(object : ReactInstanceEventListener {
          override fun onReactContextInitialized(context: ReactContext) {
            host.removeReactInstanceEventListener(this)
            run(context, how, lock)
          }
        })
        host.start()
      }
    }
  }

  private fun run(context: ReactContext, how: String, lock: PowerManager.WakeLock) {
    UiThreadUtil.runOnUiThread {
      val tasks = HeadlessJsTaskContext.getInstance(context)
      var id = -1
      val listener = object : HeadlessJsTaskEventListener {
        override fun onHeadlessJsTaskStart(taskId: Int) = Unit

        override fun onHeadlessJsTaskFinish(taskId: Int) {
          if (taskId != id) return
          tasks.removeTaskEventListener(this)
          if (lock.isHeld) lock.release()
        }
      }
      tasks.addTaskEventListener(listener)
      try {
        val data = Arguments.createMap().apply { putString("how", how) }
        // Allowed in front too: the app may be open when the device appears.
        id = tasks.startTask(HeadlessJsTaskConfig(WakeLogic.TASK, data, WakeLogic.TASK_TIMEOUT_MS, true))
      } catch (e: Exception) {
        Log.w(TAG, "task failed to start: ${e.javaClass.simpleName}: ${e.message}")
        tasks.removeTaskEventListener(listener)
        if (lock.isHeld) lock.release()
      }
    }
  }
}
