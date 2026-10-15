package ai.wtf.appnotice

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

// "A new version of the app is ready" (docs/UPDATES-SPEC.md §5.3): a plain notification, so a driver who opens the
// app only in the car, where the prompt waits, still learns of it at home. A tap opens `url` (the App update page).
object UpdateNotice {
  private const val CHANNEL_ID = "app-update"
  private const val NOTIFICATION_ID = 2001

  /** False when notifications are off for the app (Android 13+ asks; the driver may have said no). */
  fun show(context: Context, title: String, text: String, channelName: String, url: String): Boolean {
    val manager = NotificationManagerCompat.from(context)
    if (!manager.areNotificationsEnabled()) return false
    val system = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (system.getNotificationChannel(CHANNEL_ID) == null) {
      system.createNotificationChannel(NotificationChannel(CHANNEL_ID, channelName, NotificationManager.IMPORTANCE_DEFAULT))
    }
    val open = Intent(Intent.ACTION_VIEW, Uri.parse(url)).setPackage(context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val tap = PendingIntent.getActivity(context, NOTIFICATION_ID, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(text)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text))
      .setSmallIcon(context.applicationInfo.icon)
      .setAutoCancel(true)
      .setOnlyAlertOnce(true)
      .setContentIntent(tap)
      .build()
    return try {
      manager.notify(NOTIFICATION_ID, notification)
      true
    } catch (e: SecurityException) {
      false
    }
  }

  fun cancel(context: Context) {
    NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
  }
}
