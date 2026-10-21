package ai.wtf.sensorcapture

import android.app.Application
import android.content.Context
import expo.modules.core.interfaces.ApplicationLifecycleListener
import expo.modules.core.interfaces.Package

// Found by Expo autolinking by its file name (…Package.kt): the app's Application.onCreate reaches AppHealth before
// any JS runs, so the launch and the previous run are read once per process.
class SensorCapturePackage : Package {
  override fun createApplicationLifecycleListeners(context: Context): List<ApplicationLifecycleListener> =
    listOf(object : ApplicationLifecycleListener {
      override fun onCreate(application: Application) {
        AppHealth.launched(application)
      }
    })
}
