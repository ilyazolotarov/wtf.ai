// One voice for the route however many screens show it (VoiceGuide in use-voice-guidance.ts): the phone's map and the
// car's screen (docs/ANDROID-AUTO-SPEC.md §3) each follow the route, and only the first to claim the voice speaks.

import { en } from "@/i18n/en";
import type { GuidanceStep } from "@/nav/routing/guidance";
import type { Maneuver } from "@/nav/routing/maneuvers";
import type { RouteSnapshot } from "@/services/navigation/route-service";

import { VoiceGuide } from "../use-voice-guidance";
import { sayPhrases } from "../voice-player";

// jest.mock calls are hoisted above the imports.
const mockNotes: string[] = [];
jest.mock("../voice-player", () => ({
  sayPhrases: jest.fn(),
  hushVoice: jest.fn(),
  setVoiceNote: jest.fn(),
  setVoiceVolume: jest.fn(),
}));
jest.mock("@/services/runtime", () => ({ getRuntime: () => ({ recorder: { note: (text: string) => mockNotes.push(text) } }) }));
jest.mock("@/services/kv-store", () => ({ kvStore: { getJson: () => null, setJson: () => {} } }));

const t = (key: keyof typeof en) => en[key];
const m = (kind: Maneuver["kind"], atM: number): Maneuver => ({ kind, atM, lat: 51, lon: 31, turnRad: 0 });
const destination = { lat: 51, lon: 31, name: "Kyiv" };

function route(state: GuidanceStep["state"]): RouteSnapshot {
  return {
    destination,
    status: "active",
    planId: 1,
    replanning: false,
    maneuvers: [m("depart", 0), m("arrive", 2000)],
    guidance: {
      state,
      alongM: state === "arrived" ? 2000 : 0,
      offM: 0,
      remainingM: state === "arrived" ? 0 : 2000,
      remainingS: 200,
      nextIndex: 1,
      toNextM: state === "arrived" ? 0 : 2000,
      thenIndex: null,
      passedIndex: 0,
      progressAt: { lat: 51, lon: 31 },
    },
  };
}

/** Both guides follow the route to arrival, which is said once: by the guide holding the voice. */
function drive(guides: VoiceGuide[], muted = false) {
  for (const state of ["on", "arrived"] as const) {
    const r = route(state);
    for (const g of guides) g.update(r, 10, muted, t, "en");
  }
}

beforeEach(() => {
  jest.mocked(sayPhrases).mockClear();
  mockNotes.length = 0;
});

describe("VoiceGuide", () => {
  test("two screens, one voice: the first to claim it", () => {
    const phone = new VoiceGuide();
    const car = new VoiceGuide();
    const releases = [phone.claim(), car.claim()];
    drive([phone, car]);
    expect(sayPhrases).toHaveBeenCalledTimes(1);
    releases.forEach((r) => r());
  });

  test("the other takes over when the first lets go", () => {
    const phone = new VoiceGuide();
    const car = new VoiceGuide();
    const releasePhone = phone.claim();
    const releaseCar = car.claim();
    releasePhone();
    drive([phone, car]);
    expect(sayPhrases).toHaveBeenCalledTimes(1);
    releaseCar();
  });

  test("muted: nothing said, one note in the trip log", () => {
    const phone = new VoiceGuide();
    const car = new VoiceGuide();
    const releases = [phone.claim(), car.claim()];
    drive([phone, car], true);
    expect(sayPhrases).not.toHaveBeenCalled();
    expect(mockNotes).toEqual(["voice muted: arrived"]);
    releases.forEach((r) => r());
  });

  test("without a claim, silent", () => {
    drive([new VoiceGuide()]);
    expect(sayPhrases).not.toHaveBeenCalled();
  });
});
