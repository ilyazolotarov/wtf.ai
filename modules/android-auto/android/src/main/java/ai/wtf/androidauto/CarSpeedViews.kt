package ai.wtf.androidauto

import ai.wtf.androidauto.logic.CarCamera
import ai.wtf.androidauto.logic.CarSpeed
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView

// The speed and the speed camera ahead on the car's map (docs/ANDROID-AUTO-SPEC.md §4, UI-SPEC §6.4, §6.5), as the JS
// side sends them (`CarLink.speed`): the speed with the limit's sign in a pill, the camera's card. Native views over
// the React root, as the map's credit: React Native text on the car's display is drawn at the phone's density. What
// they say is decided in TypeScript (car-guidance.ts `carSpeed`); sizes are the phone's, in the map's dp (the car's ×
// MAP_SCALE).

/** The phone's colours (src/constants/theme.ts) for the car's day or night. */
internal class CarPalette(dark: Boolean) {
  val bg = if (dark) 0xFF121211.toInt() else 0xFFF5F4F1.toInt()
  /** `panelSolid`. */
  val panel = if (dark) 0xDB1E1D1C.toInt() else 0xDBFFFFFF.toInt()
  val line = if (dark) 0x14FFFFFF else 0x12000000
  val text = if (dark) 0xFFF2F0EC.toInt() else 0xFF1D1C1A.toInt()
  val text2 = if (dark) 0xFFA6A29B.toInt() else 0xFF6B675F.toInt()
  /** `bad`: too fast. */
  val bad = if (dark) 0xFFED8C80.toInt() else 0xFFBC4A3F.toInt()
  val badText = if (dark) 0xFF0B0D0E.toInt() else 0xFFFFFFFF.toInt()
  /** The sign's white, dimmed at night so it doesn't glare. */
  val signFill = if (dark) 0xFFF2F0EC.toInt() else 0xFFFFFFFF.toInt()
  val signRing = 0xFFD52B1E.toInt()
  val signText = 0xFF1D1C1A.toInt()
}

/**
 * The speed limit as the road sign drivers know (speed-limit-sign.tsx): a white disc in a red ring, the number black.
 * `halo`: ringed in the sign's white, `HALO_DP` wide (on a red card); the sign is that much smaller.
 */
private class SpeedSignView(context: Context) : View(context) {
  var kph = 0
  var halo = false
  var palette = CarPalette(false)
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

  override fun onDraw(canvas: Canvas) {
    val size = minOf(width, height).toFloat()
    val r = size / 2
    val inset = if (halo) HALO_DP * resources.displayMetrics.density else 0f
    if (halo) {
      paint.color = palette.signFill
      canvas.drawCircle(r, r, r, paint)
    }
    val sign = size - 2 * inset
    paint.color = palette.signRing
    canvas.drawCircle(r, r, sign / 2, paint)
    paint.color = palette.signFill
    canvas.drawCircle(r, r, sign / 2 - sign * 0.11f, paint)
    paint.color = palette.signText
    paint.typeface = Typeface.DEFAULT_BOLD
    paint.textSize = sign * (if (kph >= 100) 0.34f else 0.41f)
    paint.textAlign = Paint.Align.CENTER
    paint.letterSpacing = -0.03f
    canvas.drawText(kph.toString(), r, r - (paint.descent() + paint.ascent()) / 2, paint)
  }

  companion object {
    const val HALO_DP = 2f
  }
}

/** A thin rounded bar, `progress` of it filled. */
private class BarView(context: Context) : View(context) {
  private var progress = 0f
  private var track = 0
  private var fill = 0
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

  fun set(progress: Double, track: Int, fill: Int) {
    this.progress = progress.toFloat().coerceIn(0f, 1f)
    this.track = track
    this.fill = fill
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    val r = height / 2f
    paint.color = track
    canvas.drawRoundRect(0f, 0f, width.toFloat(), height.toFloat(), r, r, paint)
    if (progress <= 0f) return
    paint.color = fill
    canvas.drawRoundRect(0f, 0f, maxOf(height.toFloat(), width * progress), height.toFloat(), r, r, paint)
  }
}

/**
 * The speed on the car's map, in the visible map's bottom left corner as Google Maps has it: the limit's sign and the
 * speed with its unit, the speed red past the driver's margin. No sign while the camera's card shows one (the JS side
 * leaves it out: one sign on the screen, as on the phone).
 */
internal class SpeedPill(context: Context) : LinearLayout(context) {
  private val dp = resources.displayMetrics.density
  private val sign = SpeedSignView(context)
  private val value = LinearLayout(context)
  private val number = TextView(context)
  private val unit = TextView(context)

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    val pad = px(PAD_DP)
    setPadding(pad, pad, pad, pad)
    elevation = px(6).toFloat()
    addView(sign, LayoutParams(px(SIGN_DP), px(SIGN_DP)))
    value.orientation = VERTICAL
    value.gravity = Gravity.CENTER
    value.minimumWidth = px(52)
    value.minimumHeight = px(SIGN_DP)
    value.setPadding(px(8), 0, px(8), 0)
    // Centred over the unit: a vertical LinearLayout's children span its width.
    number.gravity = Gravity.CENTER_HORIZONTAL
    unit.gravity = Gravity.CENTER_HORIZONTAL
    number.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 24f)
    number.includeFontPadding = false
    number.letterSpacing = -0.02f
    unit.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 10f)
    unit.includeFontPadding = false
    value.addView(number)
    value.addView(unit)
    addView(value)
    visibility = GONE
  }

  fun show(speed: CarSpeed?, palette: CarPalette) {
    val kph = speed?.speedKph
    if (speed == null || kph == null) {
      visibility = GONE
      return
    }
    visibility = VISIBLE
    val limitKph = speed.limitKph
    background = GradientDrawable().apply {
      cornerRadius = px(SIGN_DP / 2 + PAD_DP).toFloat()
      setColor(palette.panel)
    }
    sign.visibility = if (limitKph != null) VISIBLE else GONE
    sign.kph = limitKph ?: 0
    sign.palette = palette
    sign.invalidate()
    value.layoutParams = (value.layoutParams as LayoutParams).apply { marginStart = if (limitKph != null) px(6) else 0 }
    number.text = kph.toString()
    unit.text = speed.unit
    if (speed.over) {
      value.background = GradientDrawable().apply {
        cornerRadius = px(SIGN_DP / 2).toFloat()
        setColor(palette.bad)
      }
      number.typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
      number.setTextColor(palette.badText)
      unit.setTextColor(palette.badText)
    } else {
      value.background = null
      number.typeface = Typeface.create("sans-serif-light", Typeface.NORMAL)
      number.setTextColor(palette.text)
      unit.setTextColor(palette.text2)
    }
  }

  private fun px(dps: Int) = (dps * dp).toInt()

  private companion object {
    const val SIGN_DP = 40
    const val PAD_DP = 5
  }
}

/**
 * A speed camera ahead (UI-SPEC §6.5): the phone's card (camera-card.tsx) at the top of the visible map, beside the turn
 * card: the camera's glyph, "Speed camera in 600 m", the limit at the camera as its sign, and a bar filling as the car
 * comes to it; past the driver's margin red, "Slow down" over the distance, the sign ringed in white. Not the host's
 * alert: its bar is a timer, started again by each replacement as the distance changes, and can't be hidden.
 */
internal class CameraCard(context: Context) : FrameLayout(context) {
  private val dp = resources.displayMetrics.density
  private val tile = FrameLayout(context)
  private val glyph = ImageView(context)
  private val title = TextView(context)
  private val line = TextView(context)
  private val sign = SpeedSignView(context)
  private val bar = BarView(context)

  init {
    elevation = px(6).toFloat()
    val row = LinearLayout(context)
    row.orientation = LinearLayout.HORIZONTAL
    row.gravity = Gravity.CENTER_VERTICAL
    row.setPadding(px(12), px(12), px(12), px(14))
    glyph.setImageResource(R.drawable.car_speed_camera)
    tile.addView(glyph, LayoutParams(px(26), px(26), Gravity.CENTER))
    row.addView(tile, LinearLayout.LayoutParams(px(44), px(44)))
    val texts = LinearLayout(context)
    texts.orientation = LinearLayout.VERTICAL
    title.typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    line.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 12f)
    texts.addView(title)
    texts.addView(line)
    row.addView(texts, LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = px(12); marginEnd = px(12) })
    val signSize = px(44 + 2 * SpeedSignView.HALO_DP.toInt())
    row.addView(sign, LinearLayout.LayoutParams(signSize, signSize))
    addView(row, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    // Inside the rounded corners, as the phone's.
    addView(bar, LayoutParams(LayoutParams.MATCH_PARENT, px(3), Gravity.BOTTOM).apply { leftMargin = px(20); rightMargin = px(20); bottomMargin = px(5) })
    visibility = GONE
  }

  fun show(camera: CarCamera?, palette: CarPalette) {
    if (camera == null) {
      visibility = GONE
      return
    }
    visibility = VISIBLE
    val red = camera.slowDown
    background = GradientDrawable().apply {
      cornerRadius = px(24).toFloat()
      setColor(if (red) palette.bad else palette.panel)
    }
    tile.background = GradientDrawable().apply {
      cornerRadius = px(14).toFloat()
      setColor(if (red) ON_RED_TILE else palette.text)
    }
    glyph.setColorFilter(if (red) palette.badText else palette.bg)
    title.text = camera.title
    title.setTextSize(TypedValue.COMPLEX_UNIT_DIP, if (red) 17f else 15f)
    title.setTextColor(if (red) palette.badText else palette.text)
    line.text = camera.line ?: ""
    line.visibility = if (camera.line != null) VISIBLE else GONE
    line.setTextColor(if (red) palette.badText else palette.text2)
    sign.visibility = if (camera.limitKph != null) VISIBLE else GONE
    sign.kph = camera.limitKph ?: 0
    sign.halo = red
    sign.palette = palette
    sign.invalidate()
    bar.set(camera.progress, if (red) ON_RED_TRACK else palette.line, if (red) palette.badText else palette.text)
  }

  private fun px(dps: Int) = (dps * dp).toInt()

  private companion object {
    /** White at 18 % and 25 %, over the red. */
    const val ON_RED_TILE = 0x2EFFFFFF
    const val ON_RED_TRACK = 0x40FFFFFF
  }
}
