package ai.wtf.androidauto

import ai.wtf.androidauto.logic.CarGuidanceLogic
import android.app.Presentation
import android.graphics.Color
import android.graphics.Rect
import android.graphics.drawable.ColorDrawable
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.os.Bundle
import androidx.car.app.CarContext
import androidx.car.app.SurfaceCallback
import androidx.car.app.SurfaceContainer
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.interfaces.fabric.ReactSurface
import com.facebook.react.runtime.ReactSurfaceImpl

/**
 * The car's map (docs/ANDROID-AUTO-SPEC.md §4): Android Auto hands over a Surface; a virtual display on it shows a
 * Presentation whose view is the React root `MODULE` (src/components/car-screen/car-map-root.tsx) on the app's one
 * React host. The map is the phone's MapSurface: its style, dot, route and camera, and over-the-air JS updates reach the
 * car's screen too. The display has the car's size and density, so React Native and MapLibre lay out in the car's dp.
 *
 * The root gets the car's day or night and the part of the screen the template's cards leave visible as props, and is
 * stopped when the surface goes (the driver opened another app on the car's screen, or the car disconnected).
 */
internal class CarMapSurface(private val carContext: CarContext) : SurfaceCallback {
  private var display: VirtualDisplay? = null
  private var presentation: Presentation? = null
  private var surface: ReactSurface? = null
  private var frames: CarFabricFrames? = null
  private var container: SurfaceContainer? = null
  private var visibleArea: Rect? = null

  override fun onSurfaceAvailable(surfaceContainer: SurfaceContainer) {
    val target = surfaceContainer.surface
    if (target == null || surfaceContainer.width <= 0 || surfaceContainer.height <= 0) return
    // A new surface (the car's screen resized, or back from another app): drawn again from scratch.
    release()
    container = surfaceContainer
    CarLink.note("map surface ${surfaceContainer.width}x${surfaceContainer.height} at ${surfaceContainer.dpi} dpi")
    try {
      val displays = carContext.getSystemService(DisplayManager::class.java)
      val display = displays.createVirtualDisplay(
        DISPLAY_NAME,
        surfaceContainer.width,
        surfaceContainer.height,
        surfaceContainer.dpi,
        target,
        DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY,
      )
      this.display = display
      val presentation = Presentation(carContext, display.display)
      this.presentation = presentation
      val host = (carContext.applicationContext as ReactApplication).reactHost ?: throw IllegalStateException("no React host")
      val surface = host.createSurface(presentation.context, MODULE, props())
      this.surface = surface
      val view = surface.view ?: throw IllegalStateException("React surface without a view")
      presentation.window?.setBackgroundDrawable(ColorDrawable(if (carContext.isDarkMode) Color.BLACK else Color.WHITE))
      presentation.setContentView(view)
      presentation.show()
      surface.start()
      frames = CarFabricFrames(host) { restartIfStopped() }.also { it.start() }
    } catch (e: Exception) {
      CarLink.note("map surface failed: ${e.javaClass.simpleName}: ${e.message}", problem = true)
      release()
    }
  }

  override fun onVisibleAreaChanged(visibleArea: Rect) {
    this.visibleArea = Rect(visibleArea)
    updateProps()
  }

  override fun onSurfaceDestroyed(surfaceContainer: SurfaceContainer) {
    CarLink.note("map surface destroyed")
    release()
  }

  /** The car switched between day and night. */
  fun onDarkModeChanged() {
    presentation?.window?.setBackgroundDrawable(ColorDrawable(if (carContext.isDarkMode) Color.BLACK else Color.WHITE))
    updateProps()
  }

  fun release() {
    frames?.stop()
    frames = null
    surface?.let { s ->
      try {
        s.stop()
      } catch (e: Exception) {
        CarLink.note("map surface stop failed: ${e.javaClass.simpleName}: ${e.message}", problem = true)
      }
    }
    surface = null
    try {
      presentation?.dismiss()
    } catch (e: Exception) {
      CarLink.note("map presentation dismiss failed: ${e.javaClass.simpleName}: ${e.message}", problem = true)
    }
    presentation = null
    display?.release()
    display = null
    container = null
  }

  /** `dark`, and `insets`: the template's cards, in dp from each edge (the camera keeps the car in the rest). */
  private fun props(): Bundle {
    val c = container
    val area = visibleArea
    val insets = Bundle()
    if (c != null && area != null) {
      val (left, top, right, bottom) = CarGuidanceLogic.insetsDp(c.width, c.height, area.left, area.top, area.right, area.bottom, c.dpi)
      insets.putDouble("left", left)
      insets.putDouble("top", top)
      insets.putDouble("right", right)
      insets.putDouble("bottom", bottom)
    }
    return Bundle().apply {
      putBoolean("dark", carContext.isDarkMode)
      putBundle("insets", insets)
    }
  }

  private fun updateProps() {
    (surface as? ReactSurfaceImpl)?.updateInitProps(props())
  }

  /**
   * A new React context: a reload restarts the surfaces it had, but a host destroyed and made again (the development
   * build's launcher, when the surface came before it) has forgotten them. Checked once the reload has had its turn.
   */
  private fun restartIfStopped() {
    UiThreadUtil.getUiThreadHandler().postDelayed({
      val s = surface ?: return@postDelayed
      if (s.isRunning) return@postDelayed
      CarLink.note("map surface started again in a new React context")
      s.start()
    }, RESTART_CHECK_MS)
  }

  companion object {
    /** The React root's name (index.ts). */
    const val MODULE = "CarMap"
    private const val DISPLAY_NAME = "wtf.ai car map"
    private const val RESTART_CHECK_MS = 1000L
  }
}
