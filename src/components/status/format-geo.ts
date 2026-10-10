export type Lang = "en" | "uk";

const CARDINAL: Record<Lang, string[]> = {
  en: ["N", "NE", "E", "SE", "S", "SW", "W", "NW"],
  uk: ["Пн", "ПнСх", "Сх", "ПдСх", "Пд", "ПдЗх", "Зх", "ПнЗх"],
};

export function toDegrees(rad: number): number {
  return (((rad * 180) / Math.PI) % 360 + 360) % 360;
}

export function cardinal(degrees: number, lang: Lang): string {
  return CARDINAL[lang][Math.round(degrees / 45) % 8];
}

export function formatDistance(meters: number, lang: Lang): string {
  const km = lang === "uk" ? "км" : "km";
  const m = lang === "uk" ? "м" : "m";
  // A no-break space: a line never ends between the number and its unit.
  if (meters < 1000) return `${Math.round(meters)}\u00a0${m}`;
  const value = (meters / 1000).toFixed(meters >= 100000 ? 0 : 1);
  return `${lang === "uk" ? value.replace(".", ",") : value}\u00a0${km}`;
}

/** Travel time at 60 km/h. */
export function formatEta(meters: number, lang: Lang): string {
  const minutes = Math.max(1, Math.round(meters / 1000));
  const h = Math.floor(minutes / 60);
  const r = minutes % 60;
  if (lang === "uk") return h ? `${h} год ${r} хв` : `${r} хв`;
  return h ? `${h} h ${r} min` : `${r} min`;
}
