package ai.wtf.androidauto

import android.util.Log
import com.facebook.react.ReactHost
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.common.LifecycleState
import com.facebook.react.fabric.FabricUIManager
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.common.UIManagerType

/**
 * React Native applies a render's changes to the views on display frames it stops when the phone's activity pauses
 * (FabricUIManager.onHostPause), and never starts without one (the app opened from the car's screen). The car's map
 * would show its first frame for good: the dot and the route stood still while only the camera, moved by direct
 * commands, went on. While the car's map shows, its frames run whatever the phone's activity does; after, they follow
 * the activity again. `onContext`: each new React context (the first, a JS reload), for the map to start again in it.
 */
internal class CarFabricFrames(private val host: ReactHost, private val onContext: (ReactContext) -> Unit) {
  private var context: ReactContext? = null
  private var running = false

  private val lifecycle =
    object : LifecycleEventListener {
      override fun onHostResume() = Unit

      // After every listener has had the pause, Fabric's own among them.
      override fun onHostPause() {
        UiThreadUtil.getUiThreadHandler().post { if (running) fabric()?.onHostResume() }
      }

      override fun onHostDestroy() = Unit
    }

  private val instances =
    object : ReactInstanceEventListener {
      override fun onReactContextInitialized(context: ReactContext) {
        UiThreadUtil.runOnUiThread {
          if (!running) return@runOnUiThread
          attach(context)
          onContext(context)
        }
      }
    }

  fun start() {
    UiThreadUtil.assertOnUiThread()
    if (running) return
    running = true
    host.addReactInstanceEventListener(instances)
    host.currentReactContext?.let { attach(it) }
  }

  fun stop() {
    UiThreadUtil.assertOnUiThread()
    if (!running) return
    running = false
    host.removeReactInstanceEventListener(instances)
    context?.removeLifecycleEventListener(lifecycle)
    if (host.lifecycleState != LifecycleState.RESUMED) fabric()?.onHostPause()
    context = null
  }

  private fun attach(context: ReactContext) {
    if (this.context !== context) {
      this.context?.removeLifecycleEventListener(lifecycle)
      this.context = context
      context.addLifecycleEventListener(lifecycle)
    }
    fabric()?.onHostResume()
  }

  private fun fabric(): FabricUIManager? {
    val context = context ?: return null
    return try {
      UIManagerHelper.getUIManager(context, UIManagerType.FABRIC) as? FabricUIManager
    } catch (e: Exception) {
      Log.w(CarLink.TAG, "no Fabric UI manager: ${e.javaClass.simpleName}: ${e.message}")
      null
    }
  }
}
