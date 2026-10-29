import { AppState, type AppStateStatus } from "react-native";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { PositionEstimate } from "@/nav/position/types";

import { useSmoothedPosition } from "../use-smoothed-position";

const moving: PositionEstimate = {
  lat: 50.43,
  lon: 30.516,
  headingRad: 0,
  speedMps: 16.7,
  accuracyM: 5,
  source: "fused",
  trust: "TRUSTED",
  timestamp: 1_000_000,
};

function Probe({ position }: { position: PositionEstimate }) {
  useSmoothedPosition(position);
  return null;
}

describe("useSmoothedPosition", () => {
  let state: AppStateStatus;
  let onChange: ((s: AppStateStatus) => void) | null;
  /** The loop's frame timers asked for: the first at once, then each a frame (~29 ms) on. */
  const frameTimers = () =>
    (globalThis.setTimeout as unknown as jest.Mock).mock.calls.filter(([, ms]) => ms === 0 || (ms > 25 && ms < 34)).length;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(globalThis, "setTimeout");
    state = "active";
    onChange = null;
    Object.defineProperty(AppState, "currentState", { configurable: true, get: () => state });
    jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
      onChange = listener as (s: AppStateStatus) => void;
      return { remove: () => (onChange = null) } as ReturnType<typeof AppState.addEventListener>;
    });
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    Object.defineProperty(AppState, "currentState", { configurable: true, writable: true, value: "active" });
  });

  const switchTo = (s: AppStateStatus) =>
    act(() => {
      state = s;
      onChange?.(s);
    });

  it("asks for frames on screen, none in the background, and again back on screen", () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<Probe position={moving} />);
    });
    expect(frameTimers()).toBe(1);

    switchTo("background");
    const asked = frameTimers();
    act(() => renderer.update(<Probe position={{ ...moving, timestamp: moving.timestamp + 500 }} />));
    act(() => jest.advanceTimersByTime(1_000));
    expect(frameTimers()).toBe(asked);

    switchTo("active");
    expect(frameTimers()).toBe(asked + 1);
    act(() => renderer.unmount());
  });

  // React Native's requestAnimationFrame is a setTimeout(0): unless the phone's display paces it, it fires at once, and
  // a loop on it spun the JS thread until iOS killed the app for its CPU use (2026-10-16). The car's map draws while
  // the phone's display doesn't pace timers (CARPLAY-SPEC §4): its loop waits a frame on its own.
  it("draws about 30 frames a second, however fast timers fire", () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<Probe position={moving} />);
    });
    act(() => jest.advanceTimersByTime(1_000));
    expect(frameTimers()).toBeGreaterThanOrEqual(30);
    expect(frameTimers()).toBeLessThanOrEqual(36);
    act(() => renderer.unmount());
  });
});
