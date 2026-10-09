import { Slider } from "@expo/ui/jetpack-compose";
import { useRef } from "react";

import type { LevelSliderProps } from "./level-slider";

/** Material's slider: `onValueChangeFinished` when the finger lifts. Its `steps` are the stops between the ends. */
export function LevelSlider({ value, min, max, step, onValueChange, onRelease }: LevelSliderProps) {
  const last = useRef(value);
  return (
    <Slider
      value={value}
      min={min}
      max={max}
      steps={Math.max(0, Math.round((max - min) / step) - 1)}
      onValueChange={(v) => {
        const at = Math.round((v - min) / step) * step + min;
        last.current = at;
        onValueChange(at);
      }}
      onValueChangeFinished={() => onRelease(last.current)}
    />
  );
}
