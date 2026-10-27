package ai.wtf.androidauto

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * The car session's hold on location (docs/ANDROID-AUTO-SPEC.md §3). Android Auto binds the app with location while the
 * car's screen shows it, and without it once the driver opens another app there: GNSS stopped, and with it the
 * guidance, the voice and the trip in the car's other displays. A foreground service of the location type, started
 * while the car shows the app, keeps it for the session. It does no work itself; the notification says what it is.
 */
class CarLocationService : Service() {
  companion object {
    private const val CHANNEL_ID = "android-auto"
    private const val NOTIFICATION_ID = 4712

    @Volatile
    var running = false
      private set

    /**
     * False (with a note) without location permission, or when Android refuses (the car shows another app). Checked
     * first: a service started in the foreground must go there, which a location service can't without the permission.
     */
    fun start(context: Context): Boolean {
      if (!located(context)) {
        CarLink.note("location service not started: no location permission")
        return false
      }
      return try {
        ContextCompat.startForegroundService(context, Intent(context, CarLocationService::class.java))
        true
      } catch (e: Exception) {
        CarLink.note("location service not started: ${e.javaClass.simpleName}: ${e.message}", problem = true)
        false
      }
    }

    private fun located(context: Context): Boolean =
      listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        .any { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }

    fun stop(context: Context) {
      context.stopService(Intent(context, CarLocationService::class.java))
    }

    /** The notification in the app's language, once the session has sent its words. */
    fun update(context: Context) {
      if (!running) return
      try {
        (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIFICATION_ID, notification(context))
      } catch (e: Exception) {
        CarLink.note("location service notification failed: ${e.javaClass.simpleName}: ${e.message}", problem = true)
      }
    }

    /** The phone's quiet channel for the car session's notifications (this one, the turn-by-turn one). */
    fun channel(context: Context): String {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (manager.getNotificationChannel(CHANNEL_ID) == null) {
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Android Auto", NotificationManager.IMPORTANCE_LOW))
      }
      return CHANNEL_ID
    }

    /** Tapped on the phone: the app opens there. */
    fun openApp(context: Context): PendingIntent? =
      context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
        PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      }

    private fun notification(context: Context): Notification =
      NotificationCompat.Builder(context, channel(context))
        .setContentTitle(context.applicationInfo.loadLabel(context.packageManager))
        .setContentText(CarLink.labels.notification)
        .setSmallIcon(context.applicationInfo.icon)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
        .setContentIntent(openApp(context))
        .build()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // In the foreground first, as Android asks of a service started there; with the permission gone since, it refuses.
    try {
      startForeground(NOTIFICATION_ID, notification(this), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
      running = true
      CarLink.note("location service running")
    } catch (e: Exception) {
      CarLink.note("location service refused: ${e.javaClass.simpleName}: ${e.message}", problem = true)
      stopSelf()
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }
}
