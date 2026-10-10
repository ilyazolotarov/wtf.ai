// Rush hours (ROUTING-SPEC §4.3): how much longer the main roads of big cities (`EdgeFlag.bigCity`, 500 000 people or
// more) take at an hour of the week than free-flowing.
// `RouteCosts.congestion` for a plan. A guess until drives measure it: no live or historical traffic is open for
// Ukraine. The hours follow TomTom's public Traffic Index for Kyiv (peaks 08–09 and 17–18, figures from before the
// war), and in October 2026 TomTom's router gave one 16 km Kyiv route 15 / 17 / 23 min at 03:00 / 08:30 / 18:00 on a
// weekday: the evening peak is the bigger one. The sizes are moderate on purpose.

/**
 * [from hour, factor] in order, Monday to Friday; 1 at weekends. Smaller cities get none: the drives through a city
 * on a Tuesday 17:00–19:20 were free-flowing, and 1.4 on its main roads made their planned time 4 % worse
 * (ROUTING-SPEC §4.4).
 */
const WEEKDAY: readonly (readonly [number, number])[] = [
  [0, 1],
  [7, 1.15],
  [8, 1.3],
  [9, 1.1],
  [10, 1],
  [17, 1.4],
  [19, 1.15],
  [20, 1],
];

/** The factor at `hour` (0–24, fractional) of `weekday` (0 = Monday … 6 = Sunday). */
export function congestion(weekday: number, hour: number): number {
  if (weekday >= 5) return 1;
  let factor = 1;
  for (const [from, f] of WEEKDAY) if (hour >= from) factor = f;
  return factor;
}

/** The factor at a moment, in the phone's own time zone (Kyiv time for a phone in Ukraine). */
export function congestionAt(date: Date): number {
  return congestion((date.getDay() + 6) % 7, date.getHours() + date.getMinutes() / 60);
}
