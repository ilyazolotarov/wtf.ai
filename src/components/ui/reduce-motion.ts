import { useSyncExternalStore } from "react";
import { AccessibilityInfo } from "react-native";

let reduce = false;
let watching = false;
const listeners = new Set<() => void>();

function set(value: boolean) {
  if (value === reduce) return;
  reduce = value;
  for (const listener of listeners) listener();
}

/** One subscription to the system for the whole app: every button reads it. */
function subscribe(listener: () => void): () => void {
  if (!watching) {
    watching = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(set);
    AccessibilityInfo.addEventListener("reduceMotionChanged", set);
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The system's Reduce Motion setting (iOS, Android "Remove animations"). */
export function useReduceMotion(): boolean {
  return useSyncExternalStore(subscribe, () => reduce);
}
