// The phone's camera button, heard by the other map that follows the car: the car's screen (UI-SPEC §6.2). The phone's
// camera has its own reducer (use-camera-mode.ts); the car's map (car-map-root.tsx) listens here and recentres as its
// own recentre button would, whatever the phone's mode became.

const listeners = new Set<() => void>();

/** The phone's camera button was pressed. */
export function requestRecentre(): void {
  for (const listener of [...listeners]) listener();
}

/** Hears `requestRecentre`; returns the release. */
export function onRecentreRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
