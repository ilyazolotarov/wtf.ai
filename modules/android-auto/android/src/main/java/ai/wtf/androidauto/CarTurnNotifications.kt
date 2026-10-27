package ai.wtf.androidauto

import ai.wtf.androidauto.logic.CarGuidanceLogic
import ai.wtf.androidauto.logic.CarRoute
import ai.wtf.androidauto.logic.CarTurnNotification
import android.app.Notification
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import androidx.car.app.CarContext
import androidx.car.app.notification.CarAppExtender
import androidx.car.app.notification.CarPendingIntent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.toBitmap

/**
 * Turn-by-turn notifications (docs/ANDROID-AUTO-SPEC.md §4, quality guideline NF-3): while the car navigates, the next
 * maneuver in Android Auto's rail when another app fills the car's screen, and popped up over it once per maneuver as
 * it comes near (`CarGuidanceLogic.turnNotification`). The host shows none of it while the car shows the app's own
 * guidance. On the phone it is a quiet notification on the location service's channel.
 */
internal class CarTurnNotifications(private val context: CarContext) {
  private companion object {
    const val NOTIFICATION_ID = 4713

    /** The large icon's size, px: the maneuver drawn for the car's pop-up and rail. */
    const val ICON_PX = 128
  }

  /** The maneuver popped up for last (`CarStep.id`). */
  private var alerted: String? = null

  /** What the notification shows now (without its pop-up); null: none posted. */
  private var shown: CarTurnNotification? = null
  private var checked = false
  private val icons = HashMap<Int, Bitmap>()

  private val manager get() = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  /** The route changed: the notification follows it, posted again only when what it shows changed. */
  fun update(route: CarRoute?) {
    val next = CarGuidanceLogic.turnNotification(route, alerted) ?: return clear()
    val content = next.copy(alertFor = null)
    if (content == shown && next.alertFor == null) return
    if (!checked) {
      checked = true
      if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) {
        CarLink.note("turn-by-turn notifications not shown: the app's notifications are off on the phone")
      }
    }
    try {
      manager.notify(NOTIFICATION_ID, build(next))
      shown = content
      next.alertFor?.let {
        alerted = it
        CarLink.note("turn notification popped up: ${next.text}, ${next.title}")
      }
    } catch (e: Exception) {
      CarLink.note("turn notification failed: ${e.javaClass.simpleName}: ${e.message}", problem = true)
    }
  }

  fun clear() {
    if (shown == null) return
    shown = null
    try {
      manager.cancel(NOTIFICATION_ID)
    } catch (e: Exception) {
      CarLink.note("turn notification not taken down: ${e.javaClass.simpleName}: ${e.message}", problem = true)
    }
  }

  private fun build(n: CarTurnNotification): Notification {
    val icon = n.maneuver?.let { CarTemplates.maneuverIcon(it) } ?: R.drawable.car_navigation
    // A pop-up only for the maneuver it is for; the rest updates the rail alone.
    val car = CarAppExtender.Builder()
      .setContentTitle(n.title)
      .setSmallIcon(icon)
      .setImportance(if (n.alertFor != null) NotificationManagerCompat.IMPORTANCE_HIGH else NotificationManagerCompat.IMPORTANCE_LOW)
    if (n.text.isNotEmpty()) car.setContentText(n.text)
    largeIcon(icon)?.let { car.setLargeIcon(it) }
    openOnCar?.let { car.setContentIntent(it) }
    val phone = NotificationCompat.Builder(context, CarLocationService.channel(context))
      .setContentTitle(n.title)
      .setSmallIcon(icon)
      .setOngoing(true)
      .setOnlyAlertOnce(n.alertFor == null)
      .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
      .setShowWhen(false)
      .setContentIntent(CarLocationService.openApp(context))
    if (n.text.isNotEmpty()) phone.setContentText(n.text)
    return phone.extend(car.build()).build()
  }

  private fun largeIcon(res: Int): Bitmap? =
    icons[res] ?: ContextCompat.getDrawable(context, res)?.toBitmap(ICON_PX, ICON_PX)?.also { icons[res] = it }

  /** Tapped on the car: the app's screen there (no place asked for: the session ignores an intent without one). */
  private val openOnCar by lazy {
    try {
      CarPendingIntent.getCarApp(context, NOTIFICATION_ID, Intent().setComponent(ComponentName(context, CarScreenService::class.java)), 0)
    } catch (e: Exception) {
      CarLink.note("turn notification opens nothing on the car: ${e.javaClass.simpleName}: ${e.message}", problem = true)
      null
    }
  }
}
