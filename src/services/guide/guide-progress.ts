// The in-app guide (UI-SPEC §7.7): which lessons the driver finished, whether the map tour was offered, and the
// hand-off that starts the tour on the map from the Guide sheet.

import Storage from "expo-sqlite/kv-store";
import { useSyncExternalStore } from "react";

const DONE_KEY = "guide.done";
const TOUR_OFFERED_KEY = "guide.tour-offered";

let done: ReadonlySet<string> = loadDone();
const doneListeners = new Set<() => void>();

function loadDone(): ReadonlySet<string> {
  try {
    const stored = JSON.parse(Storage.getItemSync(DONE_KEY) ?? "[]");
    return new Set(Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

/** Lesson ids the driver finished, in no order. */
export function useLessonsDone(): ReadonlySet<string> {
  return useSyncExternalStore(
    (listener) => {
      doneListeners.add(listener);
      return () => doneListeners.delete(listener);
    },
    () => done,
  );
}

export function markLessonDone(id: string): void {
  if (done.has(id)) return;
  done = new Set([...done, id]);
  Storage.setItemSync(DONE_KEY, JSON.stringify([...done]));
  doneListeners.forEach((listener) => listener());
}

/** The map offers the tour once, after onboarding and the first map; true once offered (or taken from the Guide). */
export function isTourOffered(): boolean {
  try {
    return Storage.getItemSync(TOUR_OFFERED_KEY) === "1";
  } catch {
    return true;
  }
}

export function markTourOffered(): void {
  Storage.setItemSync(TOUR_OFFERED_KEY, "1");
}

let tourPending = false;
const tourListeners = new Set<() => void>();

/** Ask the map screen to run the tour; it shows once the map is back on top (the sheets closed). */
export function requestTour(): void {
  tourPending = true;
  tourListeners.forEach((listener) => listener());
}

/** The pending request, once: taking it clears it. */
export function takeTourRequest(): boolean {
  const pending = tourPending;
  tourPending = false;
  return pending;
}

export function onTourRequest(listener: () => void): () => void {
  tourListeners.add(listener);
  return () => tourListeners.delete(listener);
}
