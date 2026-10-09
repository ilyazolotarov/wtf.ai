// The route voice's queue (voice-player.ts) on a fake audio player: whatever the player does or fails to report, the
// next announcement is still said.

import { hushVoice, sayPhrases, setVoiceNote } from "../voice-player";

// jest.mock calls are hoisted above the import.
type Listener = (status: { didJustFinish: boolean; playing?: boolean }) => void;

const mockPlayers: { clip: number; listener: Listener | null; played: boolean; plays: number; seeks: number; failPlay: boolean; failRemove: boolean }[] = [];
let mockFailPlay = false;
let mockFailRemove = false;

const mockSession: boolean[] = [];
jest.mock("expo-audio", () => ({
  setAudioModeAsync: jest.fn(() => Promise.resolve()),
  setIsAudioActiveAsync: jest.fn((active: boolean) => {
    mockSession.push(active);
    return Promise.resolve();
  }),
  createAudioPlayer: jest.fn((clip: number) => {
    const p = { clip, listener: null as Listener | null, played: false, plays: 0, seeks: 0, failPlay: mockFailPlay, failRemove: mockFailRemove };
    mockPlayers.push(p);
    return {
      addListener: (_: string, l: Listener) => {
        p.listener = l;
        return { remove: () => {} };
      },
      play: () => {
        if (p.failPlay) throw new Error("session activation failed");
        p.played = true;
        p.plays++;
      },
      seekTo: () => {
        p.seeks++;
        return Promise.resolve();
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
const microtasks = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
/** Lets the player go on, the music's 300 ms to go down included. */
const flush = async () => {
  await microtasks();
  jest.advanceTimersByTime(300);
  await microtasks();
};
const finish = (i: number) => mockPlayers[i].listener?.({ didJustFinish: true });

beforeEach(() => {
  jest.useFakeTimers();
  hushVoice();
  mockPlayers.length = 0;
  mockSpoken.length = 0;
  mockSession.length = 0;
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

  test("the music stays down through an announcement, from before its first clip to after its last", async () => {
    sayPhrases([{ id: "now-left", text: "Turn left" }, { id: "then-left", text: "then left" }], "en");
    await microtasks();
    // Down first, the clip only once it is.
    expect(mockSession).toEqual([true]);
    expect(mockPlayers).toHaveLength(0);
    await flush();
    finish(0);
    await flush();
    expect(mockPlayers.map((p) => p.clip)).toEqual([1, 3]);
    finish(1);
    await flush();
    expect(mockSession).toEqual([true]);
    // Another announcement soon after keeps it down.
    sayPhrases([{ id: "now-right", text: "Turn right" }], "en");
    await flush();
    expect(mockPlayers.at(-1)!.clip).toBe(2);
    finish(2);
    await flush();
    jest.advanceTimersByTime(500);
    expect(mockSession).toEqual([true, false]);
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

  test("a clip the system pauses (its Bluetooth output gone) is played again from its start", async () => {
    sayPhrases([{ id: "now-left", text: "Turn left" }], "en");
    await flush();
    sayPhrases([{ id: "now-right", text: "Turn right" }], "en");
    await flush();
    mockPlayers[0].listener?.({ didJustFinish: false, playing: true });
    jest.advanceTimersByTime(6000);
    mockPlayers[0].listener?.({ didJustFinish: false, playing: false });
    await flush();
    expect(mockPlayers[0]).toMatchObject({ seeks: 1, plays: 2 });
    expect(notes.some((n) => n.startsWith("voice clip now-left paused by the system"))).toBe(true);
    // Its time to end starts again: 12 s after it began, it isn't given up on.
    jest.advanceTimersByTime(6000);
    mockPlayers[0].listener?.({ didJustFinish: false, playing: true });
    finish(0);
    await flush();
    expect(mockPlayers.map((p) => p.clip)).toEqual([1, 2]);
    expect(notes).not.toContain("voice clip now-left never reported its end");
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
