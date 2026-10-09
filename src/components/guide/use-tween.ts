import { useEffect, useRef, useState } from "react";

const easeInOut = (k: number) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);

/** `target`, eased from wherever it was over `ms`, a frame at a time: for drawn values (SVG props) Animated can't drive. */
export function useTween(target: number, ms = 900): number {
  const [value, setValue] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    const from = current.current;
    if (from === target) return;
    const startedAt = Date.now();
    let frame = 0;
    const step = () => {
      const k = Math.min(1, (Date.now() - startedAt) / ms);
      const v = from + (target - from) * easeInOut(k);
      current.current = v;
      setValue(v);
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return value;
}
