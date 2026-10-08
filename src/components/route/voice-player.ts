import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import * as Speech from "expo-speech";

import { VOICE_CLIPS } from "./voice-clips";
import type { Phrase, VoiceLang } from "./voice-phrases";

type Item = { clip: number } | { text: string; language: string };

/** A clip that never reports its end (failed to load) doesn't hold up what comes after it. */
const CLIP_TIMEOUT_MS = 8000;

const queue: Item[] = [];
let busy = false;
/** Bumped by `hushVoice`: what was playing then doesn't go on to the next item. */
let generation = 0;
let stopCurrent: (() => void) | null = null;
let audioMode: Promise<void> | null = null;

/**
 * Says an announcement's phrases after whatever is being said: the recorded clips (voice-clips.ts) when every phrase
 * has one, otherwise the whole announcement in the system voice. Clips play over other audio, lowering it meanwhile,
 * also with the ring/silent switch on.
 */
export function sayPhrases(phrases: Phrase[], lang: VoiceLang): void {
  const clips = phrases.map((p) => VOICE_CLIPS[lang]?.[p.id]);
  if (clips.every((c) => c !== undefined)) queue.push(...clips.map((clip) => ({ clip })));
  else queue.push({ text: phrases.map((p) => p.text).join(", "), language: lang === "uk" ? "uk-UA" : "en-US" });
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
  const done = () => {
    if (gen === generation) next();
  };
  if ("text" in item) Speech.speak(item.text, { language: item.language, useApplicationAudioSession: false, onDone: done, onError: done });
  else void playClip(item.clip, gen, done);
}

async function playClip(clip: number, gen: number, done: () => void): Promise<void> {
  audioMode ??= setAudioModeAsync({ playsInSilentMode: true, interruptionMode: "duckOthers" }).catch(() => {});
  await audioMode;
  if (gen !== generation) return;
  let player: ReturnType<typeof createAudioPlayer>;
  try {
    player = createAudioPlayer(clip);
  } catch {
    done();
    return;
  }
  let ended = false;
  const end = (thenNext: boolean) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    subscription.remove();
    player.remove();
    if (stopCurrent === stop) stopCurrent = null;
    if (thenNext) done();
  };
  const stop = () => {
    player.pause();
    end(false);
  };
  const timer = setTimeout(() => end(true), CLIP_TIMEOUT_MS);
  const subscription = player.addListener("playbackStatusUpdate", (status) => {
    if (status.didJustFinish) end(true);
  });
  stopCurrent = stop;
  player.play();
}
