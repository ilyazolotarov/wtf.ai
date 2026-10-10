import AVFoundation
import AVKit
import ExpoModulesCore

// Where the phone plays audio, and Apple's output picker (ROUTING-SPEC §8.5). The route voice goes wherever iOS sends
// it: to a car's Bluetooth while one is connected, even when the car plays another source and nothing is heard. The
// picker lets the driver send it to the phone's speaker instead, without turning Bluetooth off.

public class AudioOutputModule: Module {
  private var observer: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("AudioOutput")

    Events("onOutputChange")

    Function("current") { () -> [String: Any] in
      AudioOutputModule.describe(reason: nil).compactMapValues { $0 }
    }

    OnStartObserving {
      guard self.observer == nil else { return }
      self.observer = NotificationCenter.default.addObserver(
        forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
      ) { [weak self] notification in
        let raw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
        let reason = raw.flatMap { AVAudioSession.RouteChangeReason(rawValue: $0) }
        self?.sendEvent("onOutputChange", AudioOutputModule.describe(reason: reason))
      }
    }

    OnStopObserving {
      if let observer = self.observer {
        NotificationCenter.default.removeObserver(observer)
      }
      self.observer = nil
    }

    View(AudioOutputPickerView.self) {
      Prop("tint") { (view: AudioOutputPickerView, color: UIColor) in
        view.picker.tintColor = color
      }
      Prop("activeTint") { (view: AudioOutputPickerView, color: UIColor) in
        view.picker.activeTintColor = color
      }
      // Opens the system sheet as a tap on the picker would (from another control: a long press on the voice button).
      AsyncFunction("open") { (view: AudioOutputPickerView) -> Bool in
        view.open()
      }.runOnQueue(.main)
    }
  }

  /**
   * The first output of the current route: its kind, the device's name, why it changed (when it did), and the volume
   * it plays at (0–1).
   */
  private static func describe(reason: AVAudioSession.RouteChangeReason?) -> [String: Any?] {
    let session = AVAudioSession.sharedInstance()
    let output = session.currentRoute.outputs.first
    return [
      "kind": output.map { kind(of: $0.portType) } ?? "none",
      "name": output?.portName,
      "reason": reason.map(name(of:)),
      "volume": Double(session.outputVolume),
    ]
  }

  private static func kind(of port: AVAudioSession.Port) -> String {
    switch port {
    case .builtInSpeaker: return "speaker"
    case .builtInReceiver: return "receiver"
    case .headphones, .usbAudio, .lineOut: return "wired"
    case .bluetoothA2DP, .bluetoothHFP, .bluetoothLE: return "bluetooth"
    case .carAudio: return "carplay"
    case .airPlay: return "airplay"
    default: return "other"
    }
  }

  private static func name(of reason: AVAudioSession.RouteChangeReason) -> String {
    switch reason {
    case .newDeviceAvailable: return "new device"
    case .oldDeviceUnavailable: return "device gone"
    case .categoryChange: return "category"
    case .override: return "override"
    case .wakeFromSleep: return "wake"
    case .noSuitableRouteForCategory: return "no route"
    case .routeConfigurationChange: return "configuration"
    default: return "unknown"
    }
  }
}

/**
 * Apple's AirPlay/Bluetooth/iPhone output picker: tapping it opens the system sheet. AVRoutePickerView has no call to
 * open it; its button's tap is sent instead.
 */
public final class AudioOutputPickerView: ExpoView {
  let picker = AVRoutePickerView()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    picker.prioritizesVideoDevices = false
    picker.backgroundColor = .clear
    addSubview(picker)
  }

  func open() -> Bool {
    guard let button = Self.button(in: picker) else { return false }
    button.sendActions(for: .touchUpInside)
    return true
  }

  private static func button(in view: UIView) -> UIButton? {
    for sub in view.subviews {
      if let button = sub as? UIButton { return button }
      if let button = button(in: sub) { return button }
    }
    return nil
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    picker.frame = bounds
  }
}
