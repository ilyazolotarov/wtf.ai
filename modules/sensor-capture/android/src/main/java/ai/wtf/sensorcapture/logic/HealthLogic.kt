package ai.wtf.sensorcapture.logic

// The app process on Android in the iOS module's words (docs/TRIP-LOGGER-SPEC.md §4.4): exit reasons, process
// importance, thermal status and memory trim levels as the names the TypeScript writes into the trip log. The
// platform's integer constants are spelled out here (no android.* imports), so a plain JVM test pins them.

object HealthLogic {
  /** `ApplicationExitInfo.REASON_*` (API 30+). */
  fun exitReason(reason: Int): String = when (reason) {
    1 -> "exit-self"
    2 -> "signaled"
    3 -> "low-memory"
    4 -> "crash"
    5 -> "crash-native"
    6 -> "anr"
    7 -> "initialization-failure"
    8 -> "permission-change"
    9 -> "excessive-resource-usage"
    10 -> "user-requested"
    11 -> "user-stopped"
    12 -> "dependency-died"
    13 -> "other"
    14 -> "freezer"
    15 -> "package-state-change"
    16 -> "package-updated"
    else -> "unknown"
  }

  /** `RunningAppProcessInfo.IMPORTANCE_*`: how much the process mattered to Android when it ended. */
  fun importance(importance: Int): String = when {
    importance <= 100 -> "foreground"
    importance <= 125 -> "foreground-service"
    importance <= 200 -> "visible"
    importance <= 230 -> "perceptible"
    importance <= 300 -> "service"
    importance <= 325 -> "top-sleeping"
    importance <= 350 -> "cant-save-state"
    importance < 1000 -> "cached"
    else -> "gone"
  }

  /** Below `visible`: the app wasn't on screen. */
  fun inBackground(importance: Int): Boolean = importance > 200

  /** `PowerManager.THERMAL_STATUS_*` (0 none … 6 shutdown) in iOS's four levels. */
  fun thermal(status: Int): String = when {
    status <= 0 -> "nominal"
    status <= 2 -> "fair"
    status == 3 -> "serious"
    else -> "critical"
  }

  /**
   * `ComponentCallbacks2.TRIM_MEMORY_*` worth a note, or null: UI_HIDDEN (20) only says the app left the screen.
   */
  fun trimLevel(level: Int): String? = when (level) {
    5 -> "running moderate"
    10 -> "running low"
    15 -> "running critical"
    40 -> "background"
    60 -> "moderate"
    80 -> "complete"
    else -> null
  }
}
