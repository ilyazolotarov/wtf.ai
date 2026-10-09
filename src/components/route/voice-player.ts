import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import * as Speech from "expo-speech";
import { Platform } from "react-native";

import { VOICE_CLIPS } from "./voice-clips";
import type { Phrase, VoiceLang } from "./voice-phrases";

/** `gain`: this item's own (a sample at another volume); otherwise the driver's, as the player has it when it plays. */
type Item = { clip: number; id: string; text: string; language: string; gain?: number } | { text: string; language: string; gain?: number };

/** A clip that never reports its end (failed to load) doesn't hold up what comes after it. */
const CLIP_TIMEOUT_MS = 8000;
/** A clip paused by the system is played again at most this many times. */
const MAX_REPLAYS = 2;
/** The system voice: its end is waited for at most this long plus this much per character. */
const SPEECH_TIMEOUT_MS = 4000;
const SPEECH_MS_PER_CHAR = 120;

const queue: Item[] = [];
let busy = false;
/** Bumped by `hushVoice`, and when an item is given up on: what was playing then doesn't go on to the next item. */
let generation = 0;
let stopCurrent: (() => void) | null = null;
let audioMode: Promise<void> | null = null;
/** Where the voice says what it did (the trip log's notes): the only way to tell later why a drive stayed silent. */
let note: (text: string) => void = () => {};
/** The player's gain for the driver's voice volume (Settings), 0–1 of the recorded level: a clip already playing keeps its own. */
let volume = 1;

export function setVoiceNote(fn: (text: string) => void): void {
  note = fn;
}

export function setVoiceVolume(v: number): void {
  volume = Math.min(1, Math.max(0, v));
}

const languageOf = (lang: VoiceLang) => (lang === "uk" ? "uk-UA" : "en-US");

/**
 * Says an announcement's phrases after whatever is being said: the recorded clips (voice-clips.ts) when every phrase
 * has one, otherwise the whole announcement in the system voice. Clips play over other audio, lowering it meanwhile,
 * also with the ring/silent switch on and with the app in the background. A clip that won't play is said by the
 * system voice instead. `gain` (0–1) plays these at that level instead of the driver's (the Guide's volume sample);
 * it travels with them, since a clip starts only once the audio mode is set.
 */
export function sayPhrases(phrases: Phrase[], lang: VoiceLang, gain?: number): void {
  const language = languageOf(lang);
  const clips = phrases.map((p) => VOICE_CLIPS[lang]?.[p.id]);
  if (clips.every((c) => c !== undefined)) queue.push(...phrases.map((p, i) => ({ clip: clips[i]!, id: p.id, text: p.text, language, gain })));
  else queue.push({ text: phrases.map((p) => p.text).join(", "), language, gain });
  note(`voice say ${phrases.map((p) => p.id).join(" + ")}${clips.every((c) => c !== undefined) ? "" : " (system voice)"}${busy ? `, after ${queue.length - 1} waiting` : ""}`);
  if (!busy) next();
}

/** Stops what is being said and drops what was waiting. */
export function hushVoice(): void {
  generation++;
  queue.length = 0;
  busy = false;
  stopCurrent?.();
  stopCurrent = null;
  void Speech.stop();
}

function next(): void {
  const item = queue.shift();
  busy = item !== undefined;
  if (!item) return;
  const gen = generation;
  let finished = false;
  // Exactly once per item, whatever reports its end (or fails to).
  const done = () => {
    if (finished) return;
    finished = true;
    if (gen === generation) next();
  };
  if ("clip" in item) void playClip(item, gen, done);
  else speak(item.text, item.language, done, item.gain);
}

function speak(text: string, language: string, done: () => void, gain = volume): void {
  const timer = setTimeout(() => {
    note(`voice: the system voice never finished "${text.slice(0, 40)}"`);
    done();
  }, SPEECH_TIMEOUT_MS + SPEECH_MS_PER_CHAR * text.length);
  const end = () => {
    clearTimeout(timer);
    done();
  };
  try {
    Speech.speak(text, {
      language,
      volume: gain,
      useApplicationAudioSession: false,
      onDone: end,
      onStopped: end,
      onError: (e) => {
        note(`voice: the system voice failed: ${String(e)}`);
        end();
      },
    });
  } catch (e) {
    note(`voice: the system voice failed: ${String(e)}`);
    end();
  }
}

async function playClip(item: Extract<Item, { clip: number }>, gen: number, done: () => void): Promise<void> {
  // In the background too (the screen locked, another app in front): without it expo-audio pauses its players there.
  audioMode ??= setAudioModeAsync({ playsInSilentMode: true, interruptionMode: "duckOthers", shouldPlayInBackground: true }).catch((e: unknown) => {
    note(`voice: audio mode not set: ${String(e)}`);
  });
  await audioMode;
  if (gen !== generation) return;
  // Said by the system voice instead, and the audio mode set again before the next clip.
  const fallBack = (why: string) => {
    note(`voice clip ${item.id} ${why}: system voice instead`);
    audioMode = null;
    speak(item.text, item.language, done, item.gain);
  };
  let player: ReturnType<typeof createAudioPlayer>;
  try {
    player = createAudioPlayer(item.clip);
    player.volume = item.gain ?? volume;
  } catch (e) {
    fallBack(`not loaded (${String(e)})`);
    return;
  }
  let ended = false;
  let subscription: { remove(): void } | null = null;
  // Releasing the player must never keep the queue from going on.
  const release = () => {
    try {
      subscription?.remove();
      player.remove();
    } catch (e) {
      note(`voice clip ${item.id}: release failed: ${String(e)}`);
    }
  };
  const end = (thenNext: boolean) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    if (stopCurrent === stop) stopCurrent = null;
    release();
    if (thenNext) done();
  };
  const stop = () => {
    try {
      player.pause();
    } catch {
      // Released already.
    }
    end(false);
  };
  const giveUp = () => {
    note(`voice clip ${item.id} never reported its end`);
    end(true);
  };
  let timer = setTimeout(giveUp, CLIP_TIMEOUT_MS);
  stopCurrent = stop;
  // iOS: expo-audio pauses its players when the output they play to goes away (a Bluetooth device disconnected) and
  // never resumes them: the clip is played again from its start, on whatever the phone now plays to. (Android pauses
  // only for another app's audio, a call: not to be played over.)
  let started = false;
  let replays = 0;
  const replay = () => {
    replays++;
    note(`voice clip ${item.id} paused by the system (the audio output gone?): played again`);
    clearTimeout(timer);
    timer = setTimeout(giveUp, CLIP_TIMEOUT_MS);
    started = false;
    void player
      .seekTo(0)
      .then(() => {
        if (!ended) player.play();
      })
      .catch((e: unknown) => {
        if (ended) return;
        end(false);
        fallBack(`did not play again (${String(e)})`);
      });
  };
  try {
    subscription = player.addListener("playbackStatusUpdate", (status) => {
      if (ended) return;
      if (status.didJustFinish) end(true);
      else if (status.playing) started = true;
      else if (started && replays < MAX_REPLAYS && Platform.OS === "ios") replay();
    });
    player.play();
  } catch (e) {
    end(false);
    fallBack(`did not play (${String(e)})`);
  }
}
