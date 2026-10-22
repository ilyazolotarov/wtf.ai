package ai.wtf.positionshare

import android.app.AppOpsManager
import android.content.Context
import android.os.Process
import android.provider.Settings
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability

// What sharing needs from the phone (docs/ANDROID-SPEC.md §8): Developer options on, wtf.ai picked as the mock
// location app there, and Google Play services (the fused provider other navigators read).
object ShareSetup {
  /** The navigators the setup page names, in the order it lists them. */
  val NAVIGATORS = listOf("com.waze", "com.google.android.apps.maps")

  fun developerOptions(context: Context): Boolean =
    Settings.Global.getInt(context.contentResolver, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) != 0

  /** wtf.ai is the app chosen in Developer options → "Select mock location app". */
  fun isMockLocationApp(context: Context): Boolean = try {
    val ops = context.getSystemService(AppOpsManager::class.java)
    ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_MOCK_LOCATION, Process.myUid(), context.packageName) == AppOpsManager.MODE_ALLOWED
  } catch (e: Exception) {
    false
  }

  fun playServices(context: Context): Boolean = try {
    GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
  } catch (e: Exception) {
    false
  }

  /** The `NAVIGATORS` installed on this phone. */
  fun installedNavigators(context: Context): List<String> =
    NAVIGATORS.filter { context.packageManager.getLaunchIntentForPackage(it) != null }

  fun state(context: Context): Map<String, Any> = mapOf(
    "developerOptions" to developerOptions(context),
    "mockLocationApp" to isMockLocationApp(context),
    "playServices" to playServices(context),
    "navigators" to installedNavigators(context),
  )
}
