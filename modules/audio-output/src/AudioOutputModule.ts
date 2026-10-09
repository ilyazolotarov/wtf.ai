import { NativeModule, requireNativeView, requireOptionalNativeModule } from "expo";
import type { ComponentType, Ref } from "react";
import { Platform, type ViewProps } from "react-native";

// Typed binding for modules/audio-output (iOS and Android; on web there is no output and no picker).

export type AudioOutputKind = "speaker" | "receiver" | "wired" | "bluetooth" | "carplay" | "airplay" | "other" | "none";

export interface AudioOutput {
  kind: AudioOutputKind;
  /** The device's name ("iPhone Speaker", the car's Bluetooth name). */
  name?: string | null;
  /** Why it changed (events only): "new device", "device gone", "override", … */
  reason?: string | null;
}

type AudioOutputEvents = { onOutputChange(output: AudioOutput): void };

declare class AudioOutputNativeModule extends NativeModule<AudioOutputEvents> {
  current(): AudioOutput;
  /** Android: opens the system's media output panel; false when none opened. */
  openPicker?(): boolean;
}

const native = requireOptionalNativeModule<AudioOutputNativeModule>("AudioOutput");

/** Where the phone plays audio now; null without the module. */
export function currentAudioOutput(): AudioOutput | null {
  return native?.current() ?? null;
}

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
