// The route voice's queue (voice-player.ts) on a fake audio player: whatever the player does or fails to report, the
// next announcement is still said.

import { hushVoice, sayOnSpeaker, sayPhrases, setVoiceAsGuidance, setVoiceNote, setVoiceVolume } from "../voice-player";

// jest.mock calls are hoisted above the import.
type Listener = (status: { didJustFinish: boolean; playing?: boolean }) => void;

const mockPlayers: { clip: number; listener: Listener | null; played: boolean; plays: number; seeks: number; volume?: number; failPlay: boolean; failRemove: boolean }[] = [];
let mockFailPlay = false;
let mockFailRemove = false;

jest.mock("expo-audio", () => ({
  setAudioModeAsync: jest.fn(() => Promise.resolve()),
  createAudioPlayer: jest.fn((clip: number) => {
    const p = { clip, listener: null as Listener | null, played: false, plays: 0, seeks: 0, volume: undefined as number | undefined, failPlay: mockFailPlay, failRemove: mockFailRemove };
    mockPlayers.push(p);
    return {
      set volume(v: number) {
        p.volume = v;
      },
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

const mockSpoken: { text: string; options: { onDone?: () => void; volume?: number } }[] = [];
jest.mock("expo-speech", () => ({
  speak: jest.fn((text: string, options: { onDone?: () => void; volume?: number }) => mockSpoken.push({ text, options })),
  stop: jest.fn(() => Promise.resolve()),
}));

// Android's player, on the phone's speaker or as navigation guidance: each call waits for `mockSpeaker.end` to say how
// it went.
const mockSpeaker: {
  plays: { uri: string; volume: number }[];
  guidance: { uri: string; volume: number }[];
  end: ((played: boolean) => void) | null;
  stops: number;
} = { plays: [], guidance: [], end: null, stops: 0 };
jest.mock("../../../../modules/audio-output/src/AudioOutputModule", () => ({
  canPlayOnSpeaker: true,
  canPlayGuidance: true,
  playOnSpeaker: jest.fn((uri: string, volume: number) => {
    mockSpeaker.plays.push({ uri, volume });
    return new Promise<boolean>((resolve) => (mockSpeaker.end = resolve));
  }),
  playGuidance: jest.fn((uri: string, volume: number) => {
    mockSpeaker.guidance.push({ uri, volume });
    return new Promise<boolean>((resolve) => (mockSpeaker.end = resolve));
  }),
  stopOnSpeaker: jest.fn(() => {
    mockSpeaker.stops++;
    mockSpeaker.end?.(false);
  }),
}));
jest.mock("expo-asset", () => ({
  Asset: { fromModule: (clip: number) => ({ downloadAsync: () => Promise.resolve({ localUri: `file:///clip-${clip}.mp3` }) }) },
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
  mockSpeaker.plays.length = 0;
  mockSpeaker.guidance.length = 0;
  mockSpeaker.end = null;
  mockSpeaker.stops = 0;
  setVoiceNote((t) => notes.push(t));
  setVoiceVolume(1);
});
afterEach(() => {
  setVoiceAsGuidance(false);
  jest.useRealTimers();
});

describe("voice player", () => {
  test("clips and the system voice play at the driver's volume", async () => {
    setVoiceVolume(0.6);
    sayPhrases([{ id: "now-left", text: "Turn left" }], "en");
    await flush();
    expect(mockPlayers[0].volume).toBe(0.6);
    finish(0);
    sayPhrases([{ id: "no-clip", text: "Somewhere" }], "en");
    await flush();
    expect(mockSpoken[0].options.volume).toBe(0.6);
  });

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

  test("a phrase for the phone's speaker plays there at the driver's volume, then the queue goes on", async () => {
    setVoiceVolume(0.6);
    sayOnSpeaker([{ id: "now-left", text: "Turn left" }], "en");
    sayPhrases([{ id: "now-right", text: "Turn right" }], "en");
    await flush();
    expect(mockSpeaker.plays).toEqual([{ uri: "file:///clip-1.mp3", volume: 0.6 }]);
    expect(mockPlayers).toHaveLength(0);
    mockSpeaker.end?.(true);
    await flush();
    expect(mockPlayers.map((p) => p.clip)).toEqual([2]);
    expect(notes[0]).toBe("voice say now-left (phone speaker)");
  });

  test("a phrase the speaker won't play goes where the audio goes", async () => {
    sayOnSpeaker([{ id: "now-left", text: "Turn left" }], "en");
    await flush();
    mockSpeaker.end?.(false);
    await flush();
    expect(mockPlayers.map((p) => p.clip)).toEqual([1]);
    expect(mockPlayers[0].played).toBe(true);
    expect(notes.some((n) => n.startsWith("voice clip now-left not played on the phone's speaker"))).toBe(true);
  });

  test("hushing stops the speaker, and nothing else is said for it", async () => {
    sayOnSpeaker([{ id: "now-left", text: "Turn left" }], "en");
    await flush();
    hushVoice();
    await flush();
    expect(mockSpeaker.stops).toBe(1);
    expect(mockPlayers).toHaveLength(0);
    expect(mockSpoken).toHaveLength(0);
  });

  test("the speaker that never reports its end is stopped, and the queue goes on", async () => {
    sayOnSpeaker([{ id: "now-left", text: "Turn left" }], "en");
    sayPhrases([{ id: "now-right", text: "Turn right" }], "en");
    await flush();
    jest.advanceTimersByTime(8000);
    await flush();
    expect(mockSpeaker.stops).toBe(1);
    expect(mockPlayers.map((p) => p.clip)).toEqual([2]);
    expect(notes).toContain("voice clip now-left on the phone's speaker never reported its end");
  });

  test("with Android Auto connected, clips play as navigation guidance at the driver's volume, one after another", async () => {
    setVoiceAsGuidance(true);
    setVoiceVolume(0.6);
    sayPhrases([{ id: "now-left", text: "Turn left" }], "en");
    sayPhrases([{ id: "now-right", text: "Turn right" }], "en");
    await flush();
    expect(mockSpeaker.guidance).toEqual([{ uri: "file:///clip-1.mp3", volume: 0.6 }]);
    expect(mockPlayers).toHaveLength(0);
    mockSpeaker.end?.(true);
    await flush();
    expect(mockSpeaker.guidance.map((g) => g.uri)).toEqual(["file:///clip-1.mp3", "file:///clip-2.mp3"]);
    // A phrase meant for the phone's speaker still goes there.
    mockSpeaker.end?.(true);
    sayOnSpeaker([{ id: "then-left", text: "Then left" }], "en");
    await flush();
    expect(mockSpeaker.plays).toEqual([{ uri: "file:///clip-3.mp3", volume: 0.6 }]);
  });

  test("a clip that won't play as guidance goes where the audio goes; without Android Auto, clips play as before", async () => {
    setVoiceAsGuidance(true);
    sayPhrases([{ id: "now-left", text: "Turn left" }], "en");
    await flush();
    mockSpeaker.end?.(false);
    await flush();
    expect(mockPlayers.map((p) => p.clip)).toEqual([1]);
    expect(notes.some((n) => n.startsWith("voice clip now-left not played as guidance"))).toBe(true);
    finish(0);

    setVoiceAsGuidance(false);
    sayPhrases([{ id: "now-right", text: "Turn right" }], "en");
    await flush();
    expect(mockSpeaker.guidance).toHaveLength(1);
    expect(mockPlayers.map((p) => p.clip)).toEqual([1, 2]);
  });
});
