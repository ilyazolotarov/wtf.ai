// Where the reminder to put the car on the map can't go to the phone's speaker (iOS), it is said again when the audio
// moves to the car's Bluetooth soon after (use-place-reminder.ts).

import type { AudioOutput } from "../../../../modules/audio-output/src/AudioOutputModule";
import { AGAIN_AFTER_MS, AGAIN_WITHIN_MS, sayAgainOnCarAudio } from "../use-place-reminder";

jest.mock("@/i18n/provider", () => ({}));
jest.mock("@/providers/runtime-provider", () => ({}));
jest.mock("@/components/route/voice-player", () => ({}));

const speaker: AudioOutput = { kind: "speaker", name: "Speaker" };
const car: AudioOutput = { kind: "bluetooth", name: "Car" };

function watch(from: AudioOutput | null) {
  const listeners = new Set<(o: AudioOutput) => void>();
  const again: AudioOutput[] = [];
  const stop = sayAgainOnCarAudio(
    from,
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    (to) => again.push(to),
  );
  return { emit: (o: AudioOutput) => listeners.forEach((fn) => fn(o)), again, listeners, stop };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("the reminder said again when the audio moves to the car", () => {
  test("once, a moment after the car's Bluetooth takes the audio", () => {
    const w = watch(speaker);
    w.emit(car);
    w.emit({ kind: "bluetooth", name: "Other" });
    expect(w.again).toHaveLength(0);
    jest.advanceTimersByTime(AGAIN_AFTER_MS);
    expect(w.again).toEqual([car]);
    expect(w.listeners.size).toBe(0);
  });

  test("not for a change that keeps the output, nor one onto the phone", () => {
    const w = watch(car);
    w.emit(car);
    w.emit(speaker);
    jest.advanceTimersByTime(AGAIN_WITHIN_MS);
    expect(w.again).toHaveLength(0);
  });

  test("not when the car connects later than the window", () => {
    const w = watch(speaker);
    jest.advanceTimersByTime(AGAIN_WITHIN_MS);
    expect(w.listeners.size).toBe(0);
    w.emit(car);
    jest.advanceTimersByTime(AGAIN_AFTER_MS);
    expect(w.again).toHaveLength(0);
  });

  test("not after it stopped watching (the map screen gone)", () => {
    const w = watch(speaker);
    w.emit(car);
    w.stop();
    jest.advanceTimersByTime(AGAIN_AFTER_MS);
    expect(w.again).toHaveLength(0);
  });
});
