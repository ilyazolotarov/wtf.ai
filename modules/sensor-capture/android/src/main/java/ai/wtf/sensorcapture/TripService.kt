package ai.wtf.sensorcapture

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
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

// Keeps the process alive while a trip is recorded (docs/ANDROID-SPEC.md §3 D). Without a foreground service Android
// stops sensor delivery and Bluetooth I/O soon after the screen turns off. The service does no work itself: GNSS, IMU
// and the adapter run in the app process; this only holds the foreground state, the notification and a CPU wake lock.
class TripService : Service() {
  companion object {
    private const val TAG = "WtfTripService"
    private const val CHANNEL_ID = "trip"
    private const val NOTIFICATION_ID = 4711
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_TEXT = "text"
    private const val EXTRA_CHANNEL = "channel"

    @Volatile
    var running = false
      private set

    /** The foreground service types this phone and the current permissions allow; 0 = cannot start. */
    fun allowedTypes(context: Context): Int {
      fun granted(p: String) = ContextCompat.checkSelfPermission(context, p) == PackageManager.PERMISSION_GRANTED
      var types = 0
      if (granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION)) {
        types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
      }
      if (Build.VERSION.SDK_INT < 31 || granted(Manifest.permission.BLUETOOTH_CONNECT)) {
        types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
      }
      return types
    }

    /** At least one service type must be allowed, or the start throws. */
    fun canStart(context: Context): Boolean = allowedTypes(context) != 0

    /** Starts the service; false (with a log line) when Android refuses, e.g. from the background or without permission. */
    fun start(context: Context, title: String, text: String, channelName: String): Boolean {
      return try {
        val intent = Intent(context, TripService::class.java)
          .putExtra(EXTRA_TITLE, title)
          .putExtra(EXTRA_TEXT, text)
          .putExtra(EXTRA_CHANNEL, channelName)
        ContextCompat.startForegroundService(context, intent)
        true
      } catch (e: Exception) {
        Log.w(TAG, "could not start: ${e.javaClass.simpleName}: ${e.message}")
        false
      }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, TripService::class.java))
    }
  }

  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "wtf.ai"
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: ""
    val channelName = intent?.getStringExtra(EXTRA_CHANNEL) ?: "Trip"
    val types = allowedTypes(this)
    try {
      val notification = buildNotification(title, text, channelName)
      if (types != 0) {
        startForeground(NOTIFICATION_ID, notification, types)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (e: Exception) {
      // E.g. a missing permission for the declared type: do not crash the app over a notification.
      Log.w(TAG, "startForeground failed: ${e.javaClass.simpleName}: ${e.message}")
      stopSelf()
      return START_NOT_STICKY
    }
    if (wakeLock == null) {
      val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "wtfai:trip").also { it.acquire() }
    }
    running = true
    Log.i(TAG, "running types=$types")
    // The trip lives in the app process; if Android kills it, restarting an empty service helps nobody.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    Log.i(TAG, "stopped")
    super.onDestroy()
  }

  private fun buildNotification(title: String, text: String, channelName: String): Notification {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) == null) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, channelName, NotificationManager.IMPORTANCE_LOW))
    }
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val open = launch?.let { PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT) }
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(text)
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
      .setContentIntent(open)
      .build()
  }
}
