import { useSyncExternalStore } from "react";

// True from the moment a sheet starts closing (button or swipe) until the close ends. Focus
// on the home screen only flips once a swipe-dismiss has finished, which is too late for
// the map blur to start fading out.
let closing = false;
const listeners = new Set<() => void>();

export function setSheetClosing(value: boolean) {
  if (closing === value) return;
  closing = value;
  listeners.forEach((l) => l());
}

export function useSheetClosing() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => closing,
  );
}
