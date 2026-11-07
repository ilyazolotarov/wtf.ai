// The reminder to put the car on the map judges the car's own dot, not the phone's from before the car answered
// (use-place-reminder.ts `dotSettled`).

import { dotSettled } from "../use-place-reminder";

jest.mock("@/i18n/provider", () => ({}));
jest.mock("@/providers/runtime-provider", () => ({}));
jest.mock("@/components/route/voice-player", () => ({}));

describe("the dot the reminder judges", () => {
  test("not one shown while the car's dot is on its way", () => {
    expect(dotSettled({ waitingForCar: true })).toBe(false);
    expect(dotSettled(null)).toBe(false);
  });

  test("the car's, or the one shown when none of the car's comes", () => {
    expect(dotSettled({})).toBe(true);
  });
});
