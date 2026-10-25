package ai.wtf.androidauto

import ai.wtf.androidauto.logic.CarGuidanceLogic
import ai.wtf.androidauto.logic.CarRoute
import ai.wtf.androidauto.logic.SessionStep
import android.app.Application
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.util.Log
import androidx.car.app.AppManager
import androidx.car.app.CarAppService
import androidx.car.app.Screen
import androidx.car.app.ScreenManager
import androidx.car.app.Session
import androidx.car.app.SessionInfo
import androidx.car.app.navigation.NavigationManager
import androidx.car.app.navigation.NavigationManagerCallback
import androidx.car.app.validation.HostValidator
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner

/**
 * wtf.ai on Android Auto (docs/ANDROID-AUTO-SPEC.md): a navigation app whose map is the phone's and whose guidance is
 * the route service's. Bound by the Android Auto host when the driver opens the app on the car's screen.
 */
class CarScreenService : CarAppService() {
  /**
   * Debug builds talk to any host (the Desktop Head Unit, test hosts); release builds only to the hosts the library
   * lists (Android Auto, Android Automotive OS's template host).
   */
  override fun createHostValidator(): HostValidator =
    if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
      HostValidator.ALLOW_ALL_HOSTS_VALIDATOR
    } else {
      HostValidator.Builder(applicationContext).addAllowedHosts(androidx.car.app.R.array.hosts_allowlist_sample).build()
    }

  override fun onCreateSession(sessionInfo: SessionInfo): Session = CarScreenSession()
}

/**
 * One connection of the car's screen: the map surface, the navigation template, and the navigation session the host
 * shows in the car's own displays. Its JS side is CarSessionTask's task.
 */
class CarScreenSession : Session() {
  private var map: CarMapSurface? = null
  private var navigation: NavigationScreen? = null
  private var manager: NavigationManager? = null
  private var navigating = false

  init {
    lifecycle.addObserver(
      object : DefaultLifecycleObserver {
        // The car shows the app: Android Auto's binding gives it location now, which the service keeps for the session
        // (a session made while the car shows another app has none to keep yet).
        override fun onStart(owner: LifecycleOwner) {
          if (!CarLocationService.running) CarLocationService.start(carContext)
        }

        override fun onDestroy(owner: LifecycleOwner) {
          Log.i(CarLink.TAG, "car session ended")
          if (navigating) manager?.navigationEnded()
          navigating = false
          manager?.clearNavigationManagerCallback()
          map?.release()
          map = null
          CarLocationService.stop(carContext)
          if (CarLink.session === this@CarScreenSession) CarLink.session = null
          CarSessionTask.stop()
        }
      },
    )
  }

  override fun onCreateScreen(intent: Intent): Screen {
    Log.i(CarLink.TAG, "car session started")
    CarLink.session = this
    val map = CarMapSurface(carContext)
    this.map = map
    carContext.getCarService(AppManager::class.java).setSurfaceCallback(map)
    manager = carContext.getCarService(NavigationManager::class.java).apply {
      setNavigationManagerCallback(
        object : NavigationManagerCallback {
          // The host ends this app's navigation (another navigator started one, or the driver ended it there).
          override fun onStopNavigation() {
            navigating = false
            CarLink.send("end-route")
          }
        },
      )
    }
    CarSessionTask.start(carContext.applicationContext as Application)
    syncNavigation()
    return NavigationScreen(carContext).also { navigation = it }
  }

  override fun onCarConfigurationChanged(newConfiguration: Configuration) {
    map?.onDarkModeChanged()
    refresh()
  }

  /** Labels, places or the voice changed: the templates are built again. */
  fun refresh() {
    CarLocationService.update(carContext)
    val top = carContext.getCarService(ScreenManager::class.java).top
    top.invalidate()
    if (top !== navigation) navigation?.invalidate()
  }

  fun routeChanged() {
    syncNavigation()
    navigation?.invalidate()
  }

  private fun syncNavigation() {
    val manager = manager ?: return
    val route: CarRoute? = CarLink.route
    try {
      when (CarGuidanceLogic.sessionStep(navigating, route)) {
        SessionStep.START -> {
          manager.navigationStarted()
          navigating = true
          manager.updateTrip(CarTemplates.trip(carContext, route!!))
        }
        SessionStep.UPDATE -> manager.updateTrip(CarTemplates.trip(carContext, route!!))
        SessionStep.END -> {
          manager.navigationEnded()
          navigating = false
        }
        SessionStep.NONE -> Unit
      }
    } catch (e: Exception) {
      Log.w(CarLink.TAG, "navigation session: ${e.javaClass.simpleName}: ${e.message}")
    }
  }
}
