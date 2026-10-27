import { NativeModule, requireNativeView, requireOptionalNativeModule } from "expo";
import type { ComponentType, Ref } from "react";
import { Platform, type ViewProps } from "react-native";

// Typed binding for modules/audio-output (iOS and Android; on web there is no output and no picker).

/** `capture` (Android): media captured or redirected (a screen recording with sound, mirroring or casting). */
export type AudioOutputKind =
  | "speaker"
  | "receiver"
  | "wired"
  | "bluetooth"
  | "carplay"
  | "airplay"
  | "capture"
  | "other"
  | "none";

export interface AudioOutput {
  kind: AudioOutputKind;
  /** The device's name ("iPhone Speaker", the car's Bluetooth name). */
  name?: string | null;
  /** Why it changed (events only): "new device", "device gone", "override", … */
  reason?: string | null;
  /**
   * The volume it plays at, 0–1: the media volume on Android, the output volume on iOS. The route voice plays there,
   * so 0 is silence whatever the app's own voice volume (Settings).
   */
  volume?: number | null;
  /** Android: every device media plays to (`<kind> <name>`), when more than one. */
  all?: string[] | null;
}

type AudioOutputEvents = { onOutputChange(output: AudioOutput): void };

declare class AudioOutputNativeModule extends NativeModule<AudioOutputEvents> {
  current(): AudioOutput;
  /** Android: opens the system's media output panel; false when none opened. */
  openPicker?(): boolean;
  /** Android: plays a local clip on the phone's speaker; true once it played to its end. */
  playOnSpeaker?(uri: string, volume: number): Promise<boolean>;
  /** Android: plays a local clip as navigation guidance; true once it played to its end. */
  playGuidance?(uri: string, volume: number): Promise<boolean>;
  /** Stops the clip `playOnSpeaker` or `playGuidance` plays. */
  stopOnSpeaker?(): Promise<void>;
  /** iOS: the audio session's mode as voice prompts (CarPlay connected), or the plain one again. */
  setVoicePrompt?(on: boolean): void;
  /** iOS: what the next voice prompt may be (`AVAudioSession.promptStyle`). */
  promptStyle?(): VoicePromptStyle;
}

const native = requireOptionalNativeModule<AudioOutputNativeModule>("AudioOutput");

/** Where the phone plays audio now; null without the module. */
export function currentAudioOutput(): AudioOutput | null {
  return native?.current() ?? null;
}

/** The phone's own outputs: the voice is heard there whatever the car plays. */
const ON_THE_PHONE = new Set<AudioOutputKind>(["speaker", "receiver", "wired", "none"]);

/** Somewhere off the phone: a car's Bluetooth, silent while the car plays another source. */
export const isOffPhone = (o: AudioOutput) => !ON_THE_PHONE.has(o.kind);

/** Each change of where the phone plays audio. */
export function onAudioOutput(fn: (output: AudioOutput) => void): () => void {
  const sub = native?.addListener("onOutputChange", fn);
  return () => sub?.remove();
}

/** Whether the driver can choose the output from the app: iOS's picker view, Android's system output panel. */
export const canPickAudioOutput = native != null;

/** Android: opens the system's media output panel (on iOS the picker view's `open` does). */
export function openAudioOutputPanel(): boolean {
  return native?.openPicker?.() ?? false;
}

/**
 * Whether a clip can be played on the phone's own speaker while a car's Bluetooth is connected: Android only (iOS
 * plays to the speaker over Bluetooth only in a recording session, which asks for the microphone).
 */
export const canPlayOnSpeaker = native?.playOnSpeaker != null;

/** Android: plays a local clip (`file://`) on the phone's speaker at `volume` (0–1); true once it played to its end. */
export function playOnSpeaker(uri: string, volume: number): Promise<boolean> {
  return native?.playOnSpeaker?.(uri, volume) ?? Promise.resolve(false);
}

/**
 * Whether a clip can be played as navigation guidance (Android): Android Auto mixes guidance over whatever the car
 * plays, its radio too, where media from the phone would have to be the car's source.
 */
export const canPlayGuidance = native?.playGuidance != null;

/** Android: plays a local clip (`file://`) as navigation guidance at `volume` (0–1); true once it played to its end. */
export function playGuidance(uri: string, volume: number): Promise<boolean> {
  return native?.playGuidance?.(uri, volume) ?? Promise.resolve(false);
}

/**
 * iOS: the audio session in the voice-prompt mode (CarPlay connected), which CarPlay mixes over the car's audio as a
 * navigation app's guidance; false: plain playback again. False when it couldn't be set (a build without it).
 */
export function setVoicePrompt(on: boolean): boolean {
  if (!native?.setVoicePrompt) return false;
  native.setVoicePrompt(on);
  return true;
}

/** CarPlay's word on the next voice prompt: none (a call, Siri), a short tone, or the whole prompt. */
export type VoicePromptStyle = "none" | "short" | "normal";

/** iOS: what the next voice prompt may be; "normal" without the module. */
export function voicePromptStyle(): VoicePromptStyle {
  return native?.promptStyle?.() ?? "normal";
}

/** Stops the clip `playOnSpeaker` or `playGuidance` plays (its promise then resolves false). */
export function stopOnSpeaker(): void {
  void native?.stopOnSpeaker?.();
}

/** The picker's methods, on its ref. */
export interface AudioOutputPickerHandle {
  /** Opens the system sheet as a tap on the picker would; false when it couldn't. */
  open(): Promise<boolean>;
}

/**
 * Apple's output picker (a button that opens the system sheet); null without the module. Colours as processColor
 * gives them.
 */
export const AudioOutputPicker: ComponentType<
  ViewProps & { tint?: number; activeTint?: number; ref?: Ref<AudioOutputPickerHandle> }
> | null = native && Platform.OS === "ios" ? requireNativeView("AudioOutput") : null;
