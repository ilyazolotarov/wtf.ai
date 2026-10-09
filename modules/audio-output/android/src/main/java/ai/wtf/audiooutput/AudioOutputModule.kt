package ai.wtf.audiooutput

import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaRouter2
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Where the phone plays audio, and the system's output switcher (ROUTING-SPEC §8.5); the same JS contract as the iOS
// module, without its picker view: `openPicker` opens the system's media output panel instead.

class AudioOutputModule : Module() {
  private var callback: AudioDeviceCallback? = null

  private val audio: AudioManager?
    get() = appContext.reactContext?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

  override fun definition() = ModuleDefinition {
    Name("AudioOutput")

    Events("onOutputChange")

    Function("current") { describe(null) }

    Function("openPicker") { openPicker() }

    OnStartObserving {
      val am = audio ?: return@OnStartObserving
      if (callback != null) return@OnStartObserving
      val cb = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) {
          sendEvent("onOutputChange", describe("new device"))
        }

        override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) {
          sendEvent("onOutputChange", describe("device gone"))
        }
      }
      am.registerAudioDeviceCallback(cb, Handler(Looper.getMainLooper()))
      callback = cb
    }

    OnStopObserving {
      callback?.let { audio?.unregisterAudioDeviceCallback(it) }
      callback = null
    }
  }

  /** Where media plays now: its kind, the device's name, and why it changed (when it did). */
  private fun describe(reason: String?): Map<String, Any?> {
    val device = audio?.let { output(it) }
    return mapOf(
      "kind" to (device?.let { kind(it.type) } ?: "none"),
      "name" to device?.productName?.toString(),
      "reason" to reason,
    ).filterValues { it != null }
  }

  private fun output(am: AudioManager): AudioDeviceInfo? {
    if (Build.VERSION.SDK_INT >= 33) {
      val media = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).build()
      am.getAudioDevicesForAttributes(media).firstOrNull()?.let { return it }
    }
    // Before Android 13: what media prefers among the outputs connected.
    val outputs = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
    return PREFERRED.firstNotNullOfOrNull { type -> outputs.firstOrNull { it.type == type } }
  }

  /**
   * The system's media output panel: Android 14's output switcher, the System UI dialog on 12–13, the Settings panel
   * on 11, Bluetooth settings otherwise. False when none opened.
   */
  private fun openPicker(): Boolean {
    val context = appContext.reactContext ?: return false
    if (Build.VERSION.SDK_INT >= 34 && MediaRouter2.getInstance(context).showSystemOutputSwitcher()) return true
    if (Build.VERSION.SDK_INT in 31..33) {
      val dialog = Intent("com.android.systemui.action.LAUNCH_MEDIA_OUTPUT_DIALOG")
        .setPackage("com.android.systemui")
        .putExtra("package_name", context.packageName)
      if (context.packageManager.queryBroadcastReceivers(dialog, 0).isNotEmpty()) {
        context.sendBroadcast(dialog)
        return true
      }
    }
    if (Build.VERSION.SDK_INT == 30 && start(
        context,
        Intent("com.android.settings.panel.action.MEDIA_OUTPUT")
          .putExtra("com.android.settings.panel.extra.PACKAGE_NAME", context.packageName),
      )
    ) return true
    return start(context, Intent(Settings.ACTION_BLUETOOTH_SETTINGS))
  }

  private fun start(context: Context, intent: Intent): Boolean {
    val activity = appContext.currentActivity
    return try {
      if (activity != null) activity.startActivity(intent)
      else context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      true
    } catch (e: Exception) {
      false
    }
  }

  private companion object {
    val PREFERRED = listOf(
      AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
      AudioDeviceInfo.TYPE_BLE_HEADSET,
      AudioDeviceInfo.TYPE_BLE_SPEAKER,
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_USB_HEADSET,
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
    )

    fun kind(type: Int): String = when (type) {
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER_SAFE -> "speaker"
      AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "receiver"
      AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET,
      AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_LINE_ANALOG, AudioDeviceInfo.TYPE_LINE_DIGITAL,
      AudioDeviceInfo.TYPE_AUX_LINE -> "wired"
      AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET,
      AudioDeviceInfo.TYPE_BLE_SPEAKER, AudioDeviceInfo.TYPE_BLE_BROADCAST -> "bluetooth"
      else -> "other"
    }
  }
}
