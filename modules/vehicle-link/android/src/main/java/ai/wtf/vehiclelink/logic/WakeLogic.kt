package ai.wtf.vehiclelink.logic

// Waking the app when a companion device appears (docs/VEHICLE-LINK-SPEC.md §11): what to offer in the system dialog
// and when an appearance is worth acting on. Plain Kotlin for the JVM tests.
object WakeLogic {
  /** The JS task registered in index.ts. */
  const val TASK = "VehicleWake"

  /** The task's longest run: connect to the adapter and see a trip start if the car is being started. */
  const val TASK_TIMEOUT_MS = 10 * 60_000L

  /** One arrival can come through two callbacks (the old and new APIs), or a device can flap at the edge of range. */
  const val REPEAT_WITHIN_MS = 60_000L

  /**
   * Android 16 reports an arrival through the old callback and the new one, the old one sometimes first: the old one
   * waits this long, so the new one, which says how the device appeared, is the one acted on.
   */
  const val LEGACY_DELAY_MS = 1_000L

  /**
   * The app process died with the device still present (in the car, mid-drive): Android binds the service again, which
   * starts the process, but says nothing appeared. No callback this long after the bind is that case.
   */
  const val REBOUND_AFTER_MS = 3_000L

  const val HOW_REBOUND = "restarted with the device present"

  /**
   * The remembered adapter offered in the dialog when it is a BLE one: BLE adapters advertise whenever powered, so
   * Android sees them come into range. A Classic adapter never connects by itself, so Android never sees it appear;
   * the car's own Bluetooth, which the phone connects to at ignition, stands in for it.
   */
  fun bleAddress(deviceId: String?): String? = deviceId?.let { LinkLogic.parseBleId(it) }

  /** The trip log's word for how the device appeared. */
  fun how(bleAppeared: Boolean?, btConnected: Boolean?): String = when {
    bleAppeared == true -> "ble in range"
    btConnected == true -> "bluetooth connected"
    else -> "device appeared"
  }

  class Repeats(private val withinMs: Long = REPEAT_WITHIN_MS) {
    private var lastMs: Long? = null

    /** True for an arrival to act on; false for the same one again within [withinMs]. */
    fun fresh(nowMs: Long): Boolean {
      val last = lastMs
      if (last != null && nowMs - last in 0 until withinMs) return false
      lastMs = nowMs
      return true
    }
  }
}
