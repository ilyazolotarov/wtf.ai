package ai.wtf.graphbytes

import com.facebook.react.bridge.ReactContext
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Installs `globalThis.__wtfGraphBytes` (cpp/GraphBytes.h) on the React Native runtime. */
class GraphBytesModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("GraphBytes")

    // Synchronous: on the JS thread, where the runtime may be touched.
    Function("install") {
      val holder = (appContext.reactContext as? ReactContext)?.javaScriptContextHolder ?: throw Exceptions.ReactContextLost()
      synchronized(holder) {
        val runtime = holder.get()
        if (runtime == 0L) throw Exceptions.ReactContextLost()
        nativeInstall(runtime)
      }
      true
    }
  }

  private external fun nativeInstall(runtime: Long)

  companion object {
    init {
      System.loadLibrary("graphbytes")
    }
  }
}
