/** OpenFreeMap Liberty in both color schemes (Calm redesign). */
export const MAP_STYLES = {
  light: "https://tiles.openfreemap.org/styles/liberty",
  dark: "https://tiles.openfreemap.org/styles/liberty",
} as const;

export function getMapStyle(
  scheme: "light" | "dark" | null | undefined,
): string {
  return scheme === "dark" ? MAP_STYLES.dark : MAP_STYLES.light;
}
