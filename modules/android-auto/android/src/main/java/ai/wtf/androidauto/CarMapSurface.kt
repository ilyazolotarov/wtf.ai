package ai.wtf.androidauto

import ai.wtf.androidauto.logic.CarGuidanceLogic
import android.app.Presentation
import android.graphics.Color
import android.graphics.Rect
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
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
 * car's screen too. The display has the car's size and its density times `MAP_SCALE`: React Native and MapLibre draw the
 * map bigger than the car's dp, as Android for Cars asks.
 *
 * The root gets the car's day or night and the part of the screen the template's cards leave visible as props, and is
 * stopped when the surface goes (the driver opened another app on the car's screen, or the car disconnected).
 *
 * The map data credit over it is a native view: React Native text on this display is drawn at the phone's density and
 * clipped to a box laid out at the car's.
 */
internal class CarMapSurface(private val carContext: CarContext) : SurfaceCallback {
  private var display: VirtualDisplay? = null
  private var presentation: Presentation? = null
  private var surface: ReactSurface? = null
  private var frames: CarFabricFrames? = null
  private var container: SurfaceContainer? = null
  private var visibleArea: Rect? = null
  private var credit: TextView? = null

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
        CarGuidanceLogic.mapDpi(surfaceContainer.dpi),
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
      val root = FrameLayout(presentation.context)
      root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
      val credit = creditView(presentation.context)
      this.credit = credit
      root.addView(credit)
      placeCredit()
      presentation.setContentView(root)
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
    placeCredit()
    updateProps()
  }

  // The driver's gestures on the map (touch screens; rotary and touchpad in pan mode), in the map's dp for the JS camera
  // (ANDROID-AUTO-SPEC §4): a scroll's distance as the finger went back (the camera moves by it), a fling's velocity as
  // the finger went, a scale's focus (-1: none, the map's centre) and factor.
  override fun onScroll(distanceX: Float, distanceY: Float) {
    val dp = density() ?: return
    CarLink.gesture(mapOf("kind" to "scroll", "dx" to distanceX / dp, "dy" to distanceY / dp))
  }

  override fun onFling(velocityX: Float, velocityY: Float) {
    val dp = density() ?: return
    CarLink.gesture(mapOf("kind" to "fling", "vx" to velocityX / dp, "vy" to velocityY / dp))
  }

  override fun onScale(focusX: Float, focusY: Float, scaleFactor: Float) {
    val dp = density() ?: return
    val focused = focusX >= 0 && focusY >= 0
    CarLink.gesture(
      mapOf("kind" to "scale", "x" to if (focused) focusX / dp else -1f, "y" to if (focused) focusY / dp else -1f, "factor" to scaleFactor),
    )
  }

  // A tap on the map (Car API 5): a grey route or its label there is chosen (the JS map looks).
  override fun onClick(x: Float, y: Float) {
    val dp = density() ?: return
    CarLink.gesture(mapOf("kind" to "click", "x" to x / dp, "y" to y / dp))
  }

  /** The map display's pixels per dp (its density is the car's times MAP_SCALE). */
  private fun density(): Float? = container?.let { CarGuidanceLogic.mapDpi(it.dpi) / 160f }

  override fun onSurfaceDestroyed(surfaceContainer: SurfaceContainer) {
    CarLink.note("map surface destroyed")
    release()
  }

  /** The car switched between day and night. */
  fun onDarkModeChanged() {
    presentation?.window?.setBackgroundDrawable(ColorDrawable(if (carContext.isDarkMode) Color.BLACK else Color.WHITE))
    credit?.let { paintCredit(it) }
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
    credit?.animate()?.cancel()
    credit = null
    display?.release()
    display = null
    container = null
  }

  /**
   * `dark`; `insets`: the template's cards, in the map's dp from each edge (the camera keeps the car in the rest);
   * `scale`: the map's density over the car's.
   */
  private fun props(): Bundle {
    val c = container
    val area = visibleArea
    val insets = Bundle()
    if (c != null && area != null) {
      val dpi = CarGuidanceLogic.mapDpi(c.dpi)
      val (left, top, right, bottom) = CarGuidanceLogic.insetsDp(c.width, c.height, area.left, area.top, area.right, area.bottom, dpi)
      insets.putDouble("left", left)
      insets.putDouble("top", top)
      insets.putDouble("right", right)
      insets.putDouble("bottom", bottom)
    }
    return Bundle().apply {
      putBoolean("dark", carContext.isDarkMode)
      putBundle("insets", insets)
      putDouble("scale", CarGuidanceLogic.MAP_SCALE)
    }
  }

  /**
   * The map data credit (UI-SPEC §6.1, `MAP_CREDIT` in src/config/map.ts): in the visible map's bottom left corner once
   * the map has drawn (`showCredit`), faded after 5 s, as on the phone.
   */
  private fun creditView(context: android.content.Context) = TextView(context).apply {
    text = CREDIT
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
    val dp = resources.displayMetrics.density
    setPadding((6 * dp).toInt(), (3 * dp).toInt(), (6 * dp).toInt(), (3 * dp).toInt())
    paintCredit(this)
    visibility = View.GONE
  }

  /** The phone's map colours (constants/theme.ts): `text2` on `bg` at 80 %. */
  private fun paintCredit(view: TextView) {
    val dark = carContext.isDarkMode
    view.setTextColor(if (dark) 0xFFA6A29B.toInt() else 0xFF6B675F.toInt())
    view.background = GradientDrawable().apply {
      cornerRadius = 6 * view.resources.displayMetrics.density
      setColor(if (dark) 0xCC121211.toInt() else 0xCCF5F4F1.toInt())
    }
  }

  /** Once the map has drawn (the JS side says so): before, the screen is blank, and the credit would fade over it. */
  fun showCredit() {
    val view = credit ?: return
    if (view.visibility == View.VISIBLE || view.alpha < 1f) return
    view.visibility = View.VISIBLE
    view.animate().alpha(0f).setStartDelay(CREDIT_SHOWN_MS).setDuration(CREDIT_FADE_MS).withEndAction { view.visibility = View.GONE }
  }

  /** 8 dp in from the visible map's bottom left corner: clear of the template's cards. */
  private fun placeCredit() {
    val view = credit ?: return
    val c = container ?: return
    val area = visibleArea ?: Rect(0, 0, c.width, c.height)
    val gap = (8 * view.resources.displayMetrics.density).toInt()
    view.layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.START).apply {
      leftMargin = area.left + gap
      bottomMargin = c.height - area.bottom + gap
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
    private const val CREDIT = "© OpenStreetMap contributors · © OpenMapTiles"
    private const val CREDIT_SHOWN_MS = 5000L
    private const val CREDIT_FADE_MS = 600L
  }
}
