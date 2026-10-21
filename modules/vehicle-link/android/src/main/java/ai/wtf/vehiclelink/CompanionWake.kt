package ai.wtf.vehiclelink

import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.companion.AssociationInfo
import android.companion.AssociationRequest
import android.companion.BluetoothDeviceFilter
import android.companion.BluetoothLeDeviceFilter
import android.companion.CompanionDeviceManager
import android.companion.ObservingDevicePresenceRequest
import android.content.Context
import android.content.Intent
import android.content.IntentSender
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Parcelable
import android.util.Log

// The devices that wake the app (docs/VEHICLE-LINK-SPEC.md §11): a companion association made through the system's
// one-time dialog, observed for presence, so Android binds WakeService when the device comes into BLE range or connects
// over Bluetooth, even with the app not running. Android 12+ (presence observing).
object CompanionWake {
  private const val TAG = "WtfCompanionWake"
  const val REQUEST_CODE = 0x57A1

  private var pending: ((Map<String, Any?>?) -> Unit)? = null

  fun supported(context: Context): Boolean =
    Build.VERSION.SDK_INT >= 31 && context.packageManager.hasSystemFeature(PackageManager.FEATURE_COMPANION_DEVICE_SETUP)

  private fun manager(context: Context): CompanionDeviceManager =
    context.getSystemService(CompanionDeviceManager::class.java)

  /** The associated devices: address and the name the dialog showed; a device picked twice, once. */
  fun devices(context: Context): List<Map<String, Any?>> {
    if (!supported(context)) return emptyList()
    val m = manager(context)
    val all = if (Build.VERSION.SDK_INT >= 33) {
      m.myAssociations.mapNotNull { info ->
        info.deviceMacAddress?.toString()?.uppercase()?.let { device(it, info.displayName?.toString()) }
      }
    } else {
      @Suppress("DEPRECATION")
      m.associations.map { device(it.uppercase(), nameOf(context, it)) }
    }
    return all.distinctBy { it["address"] }
  }

  private fun device(address: String, name: String?) = mapOf("address" to address, "name" to name)

  @SuppressLint("MissingPermission")
  private fun nameOf(context: Context, address: String): String? = runCatching {
    context.getSystemService(BluetoothManager::class.java).adapter.getRemoteDevice(address).name
  }.getOrNull()

  /**
   * Shows the system's dialog: the remembered adapter if it is a BLE one, and Classic devices (the car's Bluetooth).
   * [done] gets the chosen device, or null when the driver cancels or nothing is found.
   */
  fun associate(activity: Activity, bleAddress: String?, done: (Map<String, Any?>?) -> Unit) {
    pending?.invoke(null)
    pending = done
    val builder = AssociationRequest.Builder().setSingleDevice(false)
    bleAddress?.let {
      builder.addDeviceFilter(
        BluetoothLeDeviceFilter.Builder().setScanFilter(ScanFilter.Builder().setDeviceAddress(it).build()).build(),
      )
    }
    builder.addDeviceFilter(BluetoothDeviceFilter.Builder().build())
    val request = builder.build()
    val m = manager(activity)
    try {
      if (Build.VERSION.SDK_INT >= 33) {
        m.associate(request, activity.mainExecutor, object : CompanionDeviceManager.Callback() {
          override fun onAssociationPending(intentSender: IntentSender) = launch(activity, intentSender)

          override fun onAssociationCreated(associationInfo: AssociationInfo) {
            val address = associationInfo.deviceMacAddress?.toString()?.uppercase()
            if (address == null) return finish(null)
            observe(activity, associationInfo.id, address)
            finish(device(address, associationInfo.displayName?.toString()))
          }

          override fun onFailure(error: CharSequence?) {
            Log.w(TAG, "associate failed: $error")
            finish(null)
          }
        })
      } else {
        @Suppress("DEPRECATION")
        m.associate(request, object : CompanionDeviceManager.Callback() {
          @Deprecated("Android 13+ calls onAssociationPending")
          override fun onDeviceFound(intentSender: IntentSender) = launch(activity, intentSender)

          override fun onFailure(error: CharSequence?) {
            Log.w(TAG, "associate failed: $error")
            finish(null)
          }
        }, Handler(Looper.getMainLooper()))
      }
    } catch (e: Exception) {
      Log.w(TAG, "associate threw: ${e.javaClass.simpleName}: ${e.message}")
      finish(null)
    }
  }

  private fun launch(activity: Activity, sender: IntentSender) {
    try {
      activity.startIntentSenderForResult(sender, REQUEST_CODE, null, 0, 0, 0)
    } catch (e: Exception) {
      Log.w(TAG, "dialog failed: ${e.javaClass.simpleName}: ${e.message}")
      finish(null)
    }
  }

  private fun finish(result: Map<String, Any?>?) {
    val done = pending ?: return
    pending = null
    done(result)
  }

  /** The dialog's result. Android 13+ reports the association through the callback instead; a cancel comes here. */
  fun onActivityResult(context: Context, requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode != REQUEST_CODE) return
    if (resultCode != Activity.RESULT_OK) return finish(null)
    if (Build.VERSION.SDK_INT >= 33) return
    @Suppress("DEPRECATION")
    val address = when (val d = data?.getParcelableExtra<Parcelable>(CompanionDeviceManager.EXTRA_DEVICE)) {
      is BluetoothDevice -> d.address
      is ScanResult -> d.device.address
      else -> null
    }?.uppercase() ?: return finish(null)
    observe(context, null, address)
    finish(device(address, nameOf(context, address)))
  }

  /** Android binds WakeService when the device appears from now on, across reboots, until it is forgotten. */
  @SuppressLint("MissingPermission")
  private fun observe(context: Context, associationId: Int?, address: String) {
    try {
      val m = manager(context)
      if (Build.VERSION.SDK_INT >= 36 && associationId != null) {
        m.startObservingDevicePresence(ObservingDevicePresenceRequest.Builder().setAssociationId(associationId).build())
      } else {
        @Suppress("DEPRECATION")
        m.startObservingDevicePresence(address)
      }
    } catch (e: Exception) {
      Log.w(TAG, "observe failed: ${e.javaClass.simpleName}: ${e.message}")
    }
  }

  /** Observes every association of the app (observing one already observed changes nothing). */
  fun observeAll(context: Context) {
    if (!supported(context)) return
    val m = manager(context)
    if (Build.VERSION.SDK_INT >= 33) {
      for (info in m.myAssociations) {
        info.deviceMacAddress?.toString()?.uppercase()?.let { observe(context, info.id, it) }
      }
    } else {
      @Suppress("DEPRECATION")
      for (address in m.associations) observe(context, null, address.uppercase())
    }
  }

  @SuppressLint("MissingPermission")
  fun forget(context: Context, address: String) {
    if (!supported(context)) return
    val m = manager(context)
    try {
      if (Build.VERSION.SDK_INT >= 33) {
        for (info in m.myAssociations.filter { it.deviceMacAddress?.toString().equals(address, ignoreCase = true) }) {
          runCatching {
            if (Build.VERSION.SDK_INT >= 36) {
              m.stopObservingDevicePresence(ObservingDevicePresenceRequest.Builder().setAssociationId(info.id).build())
            } else {
              @Suppress("DEPRECATION")
              m.stopObservingDevicePresence(info.deviceMacAddress.toString())
            }
          }
          m.disassociate(info.id)
        }
      } else {
        @Suppress("DEPRECATION")
        runCatching { m.stopObservingDevicePresence(address) }
        @Suppress("DEPRECATION")
        m.disassociate(address)
      }
    } catch (e: Exception) {
      Log.w(TAG, "forget failed: ${e.javaClass.simpleName}: ${e.message}")
    }
  }
}
