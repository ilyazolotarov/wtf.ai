import type { useT } from "@/i18n/provider";

type Translate = ReturnType<typeof useT>["t"];

/** m:ss */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "just now", "12 min ago", "1 h 5 min ago". */
export function formatAge(ms: number, t: Translate): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return t("ageJustNow");
  if (min < 60) return t("ageMinutes").replace("{m}", String(min));
  return t("ageHours").replace("{h}", String(Math.floor(min / 60))).replace("{m}", String(min % 60));
}
