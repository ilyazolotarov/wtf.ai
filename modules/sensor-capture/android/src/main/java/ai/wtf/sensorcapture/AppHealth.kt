package ai.wtf.sensorcapture

import ai.wtf.sensorcapture.logic.HealthLogic
import android.app.ActivityManager
import android.app.Application
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.os.Debug
import android.os.PowerManager
import android.os.Process
import android.os.SystemClock
import org.json.JSONObject

// The app process on Android (docs/TRIP-LOGGER-SPEC.md §4.4), the same JS contract as iOS's AppHealth.swift: how it
// was launched, the previous run's last heartbeat, Android's own record of how earlier processes ended
// (`ApplicationExitInfo`), memory and CPU now, and memory trim warnings.

object AppHealth {
  private const val PREFS = "ai.wtf.health"
  private const val HEARTBEAT = "heartbeat"
  private const val LAST_EXIT_MS = "lastExitMs"
  /** Exits read at a launch at most (Android keeps a few per app). */
  private const val MAX_EXITS = 8

  private val lock = Any()
  private var launch: Map<String, Any> = emptyMap()
  private var reports = mutableListOf<Map<String, Any>>()
  private var memoryWarnings = 0
  @Volatile var onMemoryWarning: ((String) -> Unit)? = null

  fun launched(app: Application) {
    val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val info = ActivityManager.RunningAppProcessInfo().also { ActivityManager.getMyMemoryState(it) }
    val out = mutableMapOf<String, Any>(
      "wallMs" to System.currentTimeMillis().toDouble(),
      "uptimeUs" to SystemClock.elapsedRealtimeNanos() / 1000.0,
      "inBackground" to HealthLogic.inBackground(info.importance),
      "reasons" to emptyList<String>(),
    )
    prefs.getString(HEARTBEAT, null)?.let { json ->
      runCatching { JSONObject(json) }.getOrNull()?.let { o ->
        out["previous"] = mapOf(
          "wallMs" to o.optDouble("wallMs"),
          "appState" to o.optString("appState"),
          "context" to o.optString("context"),
          "footprintMb" to o.optDouble("footprintMb", -1.0),
          "headroomMb" to o.optDouble("headroomMb", -1.0),
          "thermal" to o.optString("thermal", "nominal"),
          "memoryWarnings" to o.optInt("memoryWarnings"),
        )
      }
    }
    prefs.edit().remove(HEARTBEAT).apply()
    val exits = readExits(app, prefs)
    synchronized(lock) {
      launch = out
      reports.addAll(exits)
    }
    app.registerComponentCallbacks(object : ComponentCallbacks2 {
      override fun onTrimMemory(level: Int) {
        val name = HealthLogic.trimLevel(level) ?: return
        synchronized(lock) { memoryWarnings += 1 }
        onMemoryWarning?.invoke(name)
      }

      override fun onConfigurationChanged(newConfig: Configuration) {}

      @Deprecated("Superseded by onTrimMemory")
      override fun onLowMemory() {}
    })
  }

  /** How earlier processes ended, newer than the last read (API 30+). */
  private fun readExits(context: Context, prefs: android.content.SharedPreferences): List<Map<String, Any>> {
    if (Build.VERSION.SDK_INT < 30) return emptyList()
    val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val seen = prefs.getLong(LAST_EXIT_MS, 0L)
    val exits = runCatching { am.getHistoricalProcessExitReasons(context.packageName, 0, MAX_EXITS) }.getOrDefault(emptyList())
      .filter { it.timestamp > seen }
      .sortedBy { it.timestamp }
    exits.lastOrNull()?.let { prefs.edit().putLong(LAST_EXIT_MS, it.timestamp).apply() }
    return exits.map { e ->
      buildMap {
        put("kind", "exit")
        put("atMs", e.timestamp.toDouble())
        put("reason", HealthLogic.exitReason(e.reason))
        put("importance", HealthLogic.importance(e.importance))
        e.description?.let { put("description", it.take(300)) }
        if (e.pss > 0) put("pssMb", e.pss / 1024.0)
        if (e.rss > 0) put("rssMb", e.rss / 1024.0)
      }
    }
  }

  fun launchInfo(): Map<String, Any> = synchronized(lock) { launch }

  fun takeReports(): List<Map<String, Any>> = synchronized(lock) {
    val out = reports.toList()
    reports.clear()
    out
  }

  /** The process now, and a heartbeat the next launch reads. Off the main thread: reading PSS takes a few ms. */
  fun stats(context: Context, appState: String, contextNote: String): Map<String, Any> {
    val footprintMb = Debug.getPss() / 1024.0
    val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val memory = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
    val headroomMb = memory.availMem / 1_048_576.0
    val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    val thermal = HealthLogic.thermal(pm.currentThermalStatus)
    val warnings = synchronized(lock) { memoryWarnings }
    val heartbeat = JSONObject()
      .put("wallMs", System.currentTimeMillis().toDouble())
      .put("appState", appState)
      .put("context", contextNote)
      .put("footprintMb", footprintMb)
      .put("headroomMb", headroomMb)
      .put("thermal", thermal)
      .put("memoryWarnings", warnings)
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(HEARTBEAT, heartbeat.toString()).apply()
    return mapOf(
      "footprintMb" to footprintMb,
      "headroomMb" to headroomMb,
      "cpuS" to Process.getElapsedCpuTime() / 1000.0,
      "thermal" to thermal,
      "lowPower" to pm.isPowerSaveMode,
      "memoryWarnings" to warnings,
    )
  }
}
