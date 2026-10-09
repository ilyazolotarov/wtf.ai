import { Slider } from "@expo/ui";

export interface LevelSliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  /** While dragging, on each stop. */
  onValueChange(value: number): void;
  /** Once the finger lifts, with where it stopped (to play a sample then, not while it still rests on the slider). */
  onRelease(value: number): void;
}

/**
 * A stepped slider that also says when it is let go (the universal `@expo/ui` slider doesn't): SwiftUI's on iOS,
 * Material's on Android (`level-slider.ios.tsx`, `.android.tsx`). Render it inside an `@expo/ui` `Host`. Elsewhere,
 * every change counts as a release.
 */
export function LevelSlider({ value, min, max, step, onValueChange, onRelease }: LevelSliderProps) {
  return (
    <Slider
      value={value}
      min={min}
      max={max}
      step={step}
      onValueChange={(v) => {
        onValueChange(v);
        onRelease(v);
      }}
    />
  );
}
