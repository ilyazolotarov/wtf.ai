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
  let frames: number;

  beforeEach(() => {
    state = "active";
    onChange = null;
    frames = 0;
    Object.defineProperty(AppState, "currentState", { configurable: true, get: () => state });
    jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
      onChange = listener as (s: AppStateStatus) => void;
      return { remove: () => (onChange = null) } as ReturnType<typeof AppState.addEventListener>;
    });
    jest.spyOn(globalThis, "requestAnimationFrame").mockImplementation(() => ++frames);
    jest.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(AppState, "currentState", { configurable: true, writable: true, value: "active" });
  });

  const switchTo = (s: AppStateStatus) =>
    act(() => {
      state = s;
      onChange?.(s);
    });

  // React Native's requestAnimationFrame is a setTimeout(0): in the background nothing paces it, and the loop spun the
  // JS thread until iOS killed the app for its CPU use (2026-10-16).
  it("asks for frames on screen, none in the background, and again back on screen", () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<Probe position={moving} />);
    });
    expect(frames).toBe(1);

    switchTo("background");
    const asked = frames;
    act(() => renderer.update(<Probe position={{ ...moving, timestamp: moving.timestamp + 500 }} />));
    expect(frames).toBe(asked);
    expect(globalThis.cancelAnimationFrame).toHaveBeenCalled();

    switchTo("active");
    expect(frames).toBe(asked + 1);
    act(() => renderer.unmount());
  });
});
