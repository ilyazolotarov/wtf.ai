package ai.wtf.audiooutput

import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.MediaRouter2
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Where the phone plays audio, and the system's output switcher (ROUTING-SPEC §8.5); the same JS contract as the iOS
// module, without its picker view: `openPicker` opens the system's media output panel instead. `playOnSpeaker` plays
// a clip on the phone's own speaker whatever else is connected (UI-SPEC §6.2's reminder to put the car on the map);
// `playGuidance` plays one as navigation guidance wherever that goes (Android Auto mixes it over the car's sources).

class AudioOutputModule : Module() {
  private var callback: AudioDeviceCallback? = null
  /** Ends the clip playing (resolving its promise false); null when none plays. */
  private var stopClip: (() -> Unit)? = null

  private val audio: AudioManager?
    get() = appContext.reactContext?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

  override fun definition() = ModuleDefinition {
    Name("AudioOutput")

    Events("onOutputChange")

    Function("current") { describe(null) }

    Function("openPicker") { openPicker() }

    AsyncFunction("playOnSpeaker") { uri: String, volume: Double, promise: Promise ->
      play(uri, volume.toFloat(), onSpeaker = true, promise)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("playGuidance") { uri: String, volume: Double, promise: Promise ->
      play(uri, volume.toFloat(), onSpeaker = false, promise)
    }.runOnQueue(Queues.MAIN)

    /** Stops the clip `playOnSpeaker` or `playGuidance` plays. */
    AsyncFunction("stopOnSpeaker") {
      stopClip?.invoke()
    }.runOnQueue(Queues.MAIN)

    OnDestroy {
      stopClip?.invoke()
    }

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

  /**
   * Where media plays now: its kind, the device's name, why it changed (when it did), the media volume (0–1), and every
   * device media goes to when more than one (a screen recording or mirroring adds a "remote submix" to the speaker or
   * takes the sound away from it).
   */
  private fun describe(reason: String?): Map<String, Any?> {
    val am = audio
    val devices = am?.let { outputs(it) } ?: emptyList()
    val device = devices.firstOrNull()
    val max = am?.getStreamMaxVolume(AudioManager.STREAM_MUSIC) ?: 0
    return mapOf(
      "kind" to (device?.let { kind(it.type) } ?: "none"),
      "name" to device?.productName?.toString(),
      "reason" to reason,
      "volume" to if (am != null && max > 0) am.getStreamVolume(AudioManager.STREAM_MUSIC).toDouble() / max else null,
      "all" to if (devices.size > 1) devices.map { "${kind(it.type)} ${it.productName}" } else null,
    ).filterValues { it != null }
  }

  private fun outputs(am: AudioManager): List<AudioDeviceInfo> {
    if (Build.VERSION.SDK_INT >= 33) {
      val media = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).build()
      val devices = am.getAudioDevicesForAttributes(media)
      if (devices.isNotEmpty()) return devices
    }
    // Before Android 13: what media prefers among the outputs connected.
    val outputs = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
    return listOfNotNull(PREFERRED.firstNotNullOfOrNull { type -> outputs.firstOrNull { it.type == type } })
  }

  /**
   * Plays a local clip (`file://`) as navigation guidance, lowering other audio meanwhile; true once it played to its
   * end, false when it couldn't (no speaker, a player error, stopped). `onSpeaker`: on the built-in speaker, while a
   * car's Bluetooth keeps playing what it plays; else wherever guidance goes (Android Auto: the car's guidance channel,
   * mixed over its radio or music).
   */
  private fun play(uri: String, volume: Float, onSpeaker: Boolean, promise: Promise) {
    stopClip?.invoke()
    val context = appContext.reactContext
    val am = audio
    val speaker = if (onSpeaker) {
      am?.getDevices(AudioManager.GET_DEVICES_OUTPUTS)?.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
    } else {
      null
    }
    if (context == null || am == null || (onSpeaker && speaker == null)) {
      promise.resolve(false)
      return
    }
    val attributes = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .build()
    val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
      .setAudioAttributes(attributes)
      .build()
    val player = MediaPlayer()
    var settled = false
    lateinit var stop: () -> Unit
    // Exactly once, whatever ends it.
    val finish = { played: Boolean ->
      if (!settled) {
        settled = true
        if (stopClip === stop) stopClip = null
        am.abandonAudioFocusRequest(focus)
        player.release()
        promise.resolve(played)
      }
    }
    stop = { finish(false) }
    stopClip = stop
    try {
      player.setAudioAttributes(attributes)
      player.setDataSource(context, Uri.parse(uri))
      player.setVolume(volume, volume)
      speaker?.let { player.setPreferredDevice(it) }
      player.setOnCompletionListener { finish(true) }
      player.setOnErrorListener { _, _, _ ->
        finish(false)
        true
      }
      player.setOnPreparedListener {
        am.requestAudioFocus(focus)
        it.start()
      }
      player.prepareAsync()
    } catch (e: Exception) {
      finish(false)
    }
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
      // Captured or redirected: a screen recording with sound, mirroring or casting the screen.
      AudioDeviceInfo.TYPE_REMOTE_SUBMIX -> "capture"
      else -> "other"
    }
  }
}
