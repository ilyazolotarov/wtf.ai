import { useEffect, useState } from "react";

import { useT } from "@/i18n/provider";

import { formatAge } from "./format-time";

/** How often an age ("12 min ago") is redrawn. */
const AGE_REFRESH_MS = 15_000;

/** How long ago `sinceMs` (wall clock) was, in words, kept current; "" without one. */
export function useAgeText(sinceMs: number | undefined): string {
  const { t } = useT();
  const ageMs = useAgeMs(sinceMs);
  return sinceMs === undefined ? "" : formatAge(ageMs, t);
}

/** How long ago `sinceMs` was, redrawn like `useAgeText`; 0 while it is undefined. */
export function useAgeMs(sinceMs: number | undefined): number {
  const now = useNowMs(sinceMs !== undefined, AGE_REFRESH_MS);
  return sinceMs === undefined ? 0 : now - sinceMs;
}

/** Wall clock, ms, redrawn every `everyMs` while `on`. */
function useNowMs(on: boolean, everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [on, everyMs]);
  return now;
}
