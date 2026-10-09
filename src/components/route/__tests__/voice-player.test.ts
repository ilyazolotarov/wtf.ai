// The route voice's queue (voice-player.ts) on a fake audio player: whatever the player does or fails to report, the
// next announcement is still said.

import { hushVoice, sayPhrases, setVoiceNote } from "../voice-player";

// jest.mock calls are hoisted above the import.
type Listener = (status: { didJustFinish: boolean }) => void;

const mockPlayers: { clip: number; listener: Listener | null; played: boolean; failPlay: boolean; failRemove: boolean }[] = [];
let mockFailPlay = false;
let mockFailRemove = false;

jest.mock("expo-audio", () => ({
  setAudioModeAsync: jest.fn(() => Promise.resolve()),
  createAudioPlayer: jest.fn((clip: number) => {
    const p = { clip, listener: null as Listener | null, played: false, failPlay: mockFailPlay, failRemove: mockFailRemove };
    mockPlayers.push(p);
    return {
      addListener: (_: string, l: Listener) => {
        p.listener = l;
        return { remove: () => {} };
      },
      play: () => {
        if (p.failPlay) throw new Error("session activation failed");
        p.played = true;
      },
      pause: () => {},
      remove: () => {
        if (p.failRemove) throw new Error("released twice");
      },
    };
  }),
}));

const mockSpoken: { text: string; options: { onDone?: () => void } }[] = [];
jest.mock("expo-speech", () => ({
  speak: jest.fn((text: string, options: { onDone?: () => void }) => mockSpoken.push({ text, options })),
  stop: jest.fn(() => Promise.resolve()),
}));

jest.mock("../voice-clips", () => ({ VOICE_CLIPS: { en: { "now-left": 1, "now-right": 2, "then-left": 3 } } }));

const notes: string[] = [];
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const finish = (i: number) => mockPlayers[i].listener?.({ didJustFinish: true });

beforeEach(() => {
  jest.useFakeTimers();
  hushVoice();
  mockPlayers.length = 0;
  mockSpoken.length = 0;
  notes.length = 0;
  mockFailPlay = mockFailRemove = false;
  setVoiceNote((t) => notes.push(t));
});
afterEach(() => jest.useRealTimers());

describe("voice player", () => {
  test("clips play one after another, each when the last reports its end", async () => {
    sayPhrases([{ id: "now-left", text: "Turn left" }, { id: "then-left", text: "then left" }], "en");
    await flush();
    expect(mockPlayers.map((p) => p.clip)).toEqual([1]);
    finish(0);
    await flush();
    expect(mockPlayers.map((p) => p.clip)).toEqual([1, 3]);
    expect(mockPlayers[1].played).toBe(true);
  });

  test("a clip that never reports its end holds the next announcement up only briefly", async () => {
    sayPhrases([{ id: "now-left", text: "Turn left" }], "en");
    await flush();
    sayPhrases([{ id: "now-right", text: "Turn right" }], "en");
    await flush();
    expect(mockPlayers).toHaveLength(1);
    jest.advanceTimersByTime(8000);
    await flush();
    expect(mockPlayers.map((p) => p.clip)).toEqual([1, 2]);
    expect(notes).toContain("voice clip now-left never reported its end");
  });

  test("a player that throws on release doesn't silence the rest of the drive", async () => {
    mockFailRemove = true;
    sayPhrases([{ id: "now-left", text: "Turn left" }], "en");
    await flush();
    mockFailRemove = false;
    finish(0);
    sayPhrases([{ id: "now-right", text: "Turn right" }], "en");
    await flush();
    expect(mockPlayers.map((p) => p.clip)).toEqual([1, 2]);
    expect(mockPlayers[1].played).toBe(true);
  });

  test("a clip that won't play is said by the system voice, and the queue goes on", async () => {
    mockFailPlay = true;
    sayPhrases([{ id: "now-left", text: "Turn left" }], "en");
    await flush();
    mockFailPlay = false;
    expect(mockSpoken.map((s) => s.text)).toEqual(["Turn left"]);
    expect(notes.some((n) => n.startsWith("voice clip now-left did not play"))).toBe(true);
    mockSpoken[0].options.onDone?.();
    sayPhrases([{ id: "now-right", text: "Turn right" }], "en");
    await flush();
    expect(mockPlayers.at(-1)!.clip).toBe(2);
    expect(mockPlayers.at(-1)!.played).toBe(true);
  });

  test("the system voice that never says it finished doesn't block what follows", async () => {
    sayPhrases([{ id: "no-clip", text: "Something without a clip" }], "en");
    await flush();
    sayPhrases([{ id: "now-right", text: "Turn right" }], "en");
    await flush();
    expect(mockPlayers).toHaveLength(0);
    jest.advanceTimersByTime(10_000);
    await flush();
    expect(mockPlayers.map((p) => p.clip)).toEqual([2]);
  });
});
