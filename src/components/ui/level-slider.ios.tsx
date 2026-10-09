import { Slider } from "@expo/ui/swift-ui";
import { useRef } from "react";

import type { LevelSliderProps } from "./level-slider";

/** SwiftUI's slider: its editing ends when the finger lifts. */
export function LevelSlider({ value, min, max, step, onValueChange, onRelease }: LevelSliderProps) {
  const last = useRef(value);
  return (
    <Slider
      value={value}
      min={min}
      max={max}
      step={step}
      onValueChange={(v) => {
        const at = Math.round(v / step) * step;
        last.current = at;
        onValueChange(at);
      }}
      onEditingChanged={(editing) => {
        if (!editing) onRelease(last.current);
      }}
    />
  );
}
