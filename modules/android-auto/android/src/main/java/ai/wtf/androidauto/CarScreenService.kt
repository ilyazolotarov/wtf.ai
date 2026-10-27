package ai.wtf.androidauto

import ai.wtf.androidauto.logic.CarGuidanceLogic
import ai.wtf.androidauto.logic.CarRoute
import ai.wtf.androidauto.logic.SessionStep
import android.Manifest
import android.app.Application
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.util.Log
import androidx.car.app.AppManager
import androidx.car.app.CarAppService
import androidx.car.app.CarContext
import androidx.car.app.CarToast
import androidx.car.app.Screen
import androidx.car.app.ScreenManager
import androidx.car.app.Session
import androidx.car.app.SessionInfo
import androidx.car.app.navigation.NavigationManager
import androidx.car.app.navigation.NavigationManagerCallback
import androidx.car.app.validation.HostValidator
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
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
  private var turns: CarTurnNotifications? = null

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
          // What the car's connection holds, let go only by its current session: a session made again before this one
          // was destroyed has them now.
          if (CarLink.session !== this@CarScreenSession) return
          CarLink.session = null
          turns?.clear()
          CarLocationService.stop(carContext)
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
            CarLink.note("navigation stopped by the car")
            CarLink.send("end-route")
          }
        },
      )
    }
    turns = CarTurnNotifications(carContext)
    CarSessionTask.start(carContext.applicationContext as Application)
    syncNavigation()
    request(intent)
    return NavigationScreen(carContext).also { navigation = it }
  }

  /** The car's assistant or another app asks for a place while the app is open. */
  override fun onNewIntent(intent: Intent) {
    request(intent)
  }

  /**
   * A navigation intent (quality guideline NF-6): `androidx.car.app.action.NAVIGATE` to go to a `geo:` place, or
   * `ACTION_VIEW` to look for one. The JS side searches and routes (car-session.ts).
   */
  private fun request(intent: Intent) {
    val uri = intent.data?.toString() ?: return
    when (intent.action) {
      CarContext.ACTION_NAVIGATE -> CarLink.request(CarLink.Request(navigate = true, uri = uri))
      Intent.ACTION_VIEW -> CarLink.request(CarLink.Request(navigate = false, uri = uri))
    }
  }

  /** The map with the route's cards: a list or the search open over it goes (a place asked for is gone to). */
  fun showMap() {
    val screens = carContext.getCarService(ScreenManager::class.java)
    if (screens.stackSize > 1) screens.popToRoot()
  }

  /** The search screen with `query` typed, right over the map (a list open before goes). */
  fun openSearch(query: String) {
    val screens = carContext.getCarService(ScreenManager::class.java)
    if (screens.stackSize == 0) return
    screens.popToRoot()
    screens.push(SearchScreen(carContext, query, keyboard = false))
  }

  override fun onCarConfigurationChanged(newConfiguration: Configuration) {
    map?.onDarkModeChanged()
    refresh()
  }

  /** Labels, places, the voice or the notice changed: the templates are built again. */
  fun refresh() {
    CarLocationService.update(carContext)
    val screens = carContext.getCarService(ScreenManager::class.java)
    // Empty before the first screen is pushed and after the session ends.
    val top = if (screens.stackSize > 0) screens.top else null
    top?.invalidate()
    if (top !== navigation) navigation?.invalidate()
  }

  /** Location allowed since the session started: held from now, if the car shows the app (else at its next start). */
  fun locationAllowed() {
    if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) && !CarLocationService.running) {
      CarLocationService.start(carContext)
    }
  }

  /**
   * The location notice's button (parked only): Android's permission dialog, on the phone's screen, and the car says to
   * look at the phone only when it's safe (quality guideline VI-1).
   */
  fun requestLocation() {
    CarLink.note("location permission asked on the car's screen")
    try {
      CarToast.makeText(carContext, CarLink.labels.checkPhone, CarToast.LENGTH_LONG).show()
      carContext.requestPermissions(listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)) { granted, _ ->
        CarLink.note(if (granted.isEmpty()) "location permission refused" else "location permission granted: ${granted.joinToString { it.substringAfterLast('.') }}")
        if (granted.isNotEmpty()) locationAllowed()
        CarLink.send("permission")
      }
    } catch (e: Exception) {
      CarLink.note("location permission request failed: ${e.javaClass.simpleName}: ${e.message}", problem = true)
    }
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
      CarLink.note("navigation session failed: ${e.javaClass.simpleName}: ${e.message}", problem = true)
    }
    turns?.update(route)
  }
}
