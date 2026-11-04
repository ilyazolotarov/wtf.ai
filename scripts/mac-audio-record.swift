// The Mac's sound, as it plays, into a 48 kHz stereo WAV: ScreenCaptureKit's system audio, no loopback driver (the
// iOS Simulator plays through the Mac). For the App Store previews' sound (scripts/app-store-screenshots.py).
//
//     swift scripts/mac-audio-record.swift out.wav      # until SIGINT; prints "started <unix seconds>" at the first sound
//
// Needs Screen Recording permission for the process that runs it (System Settings › Privacy & Security).
import AVFoundation
import Foundation
import ScreenCaptureKit

guard CommandLine.arguments.count == 2 else {
  FileHandle.standardError.write("usage: mac-audio-record.swift out.wav\n".data(using: .utf8)!)
  exit(2)
}
let outURL = URL(fileURLWithPath: CommandLine.arguments[1])
let rate = 48_000.0

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
  let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 2, interleaved: false)!
  var file: AVAudioFile?
  var stream: SCStream?

  func start() async throws {
    let content = try await SCShareableContent.current
    guard let display = content.displays.first else { throw NSError(domain: "no display", code: 1) }
    let config = SCStreamConfiguration()
    config.capturesAudio = true
    config.sampleRate = Int(rate)
    config.channelCount = 2
    config.excludesCurrentProcessAudio = true
    // The picture isn't wanted: the smallest, slowest one the stream takes.
    config.width = 2
    config.height = 2
    config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: config, delegate: self)
    // Audio only comes with a screen output attached; its frames are dropped.
    try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "screen"))
    try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "audio"))
    try await stream.startCapture()
    self.stream = stream
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .audio, sample.isValid, let pcm = pcmBuffer(sample) else { return }
    do {
      if file == nil {
        // When the buffer's first sample played, on the wall clock: what the video's scenes are cut by.
        let age = CMClockGetTime(CMClockGetHostTimeClock()).seconds - sample.presentationTimeStamp.seconds
        print(String(format: "started %.3f", Date().timeIntervalSince1970 - age))
        fflush(stdout)
        // 32-bit float WAV, interleaved as WAV files are; written from the non-interleaved buffers.
        let settings: [String: Any] = [
          AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: rate, AVNumberOfChannelsKey: 2,
          AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false,
        ]
        file = try AVAudioFile(forWriting: outURL, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
      }
      try file?.write(from: pcm)
    } catch {
      FileHandle.standardError.write("write failed: \(error)\n".data(using: .utf8)!)
      exit(1)
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    FileHandle.standardError.write("capture stopped: \(error)\n".data(using: .utf8)!)
    exit(1)
  }

  private func pcmBuffer(_ sample: CMSampleBuffer) -> AVAudioPCMBuffer? {
    guard let desc = sample.formatDescription?.audioStreamBasicDescription, desc.mSampleRate == rate,
      desc.mChannelsPerFrame == 2,
      let inFormat = AVAudioFormat(standardFormatWithSampleRate: desc.mSampleRate, channels: 2)
    else { return nil }
    // Stereo comes as two buffers, one a channel: the list sized for them by CoreMedia.
    return try? sample.withAudioBufferList { list, _ in
      AVAudioPCMBuffer(pcmFormat: inFormat, bufferListNoCopy: list.unsafePointer).flatMap(copy)
    }
  }

  /// The buffer copied out of ScreenCaptureKit's memory, which it reuses once the handler returns.
  private func copy(_ pcm: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: pcm.frameLength) else { return nil }
    out.frameLength = pcm.frameLength
    for ch in 0..<2 {
      out.floatChannelData![ch].update(from: pcm.floatChannelData![ch], count: Int(pcm.frameLength))
    }
    return out
  }
}

let recorder = Recorder()
signal(SIGINT, SIG_IGN)
let stop = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
stop.setEventHandler {
  Task {
    try? await recorder.stream?.stopCapture()
    recorder.file = nil  // closes the WAV
    exit(0)
  }
}
stop.resume()
Task {
  do {
    try await recorder.start()
  } catch {
    FileHandle.standardError.write("capture failed: \(error)\n".data(using: .utf8)!)
    exit(1)
  }
}
dispatchMain()
