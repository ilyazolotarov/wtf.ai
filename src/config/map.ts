export const MAP_STYLES = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
} as const;

export function getMapStyle(
  scheme: "light" | "dark" | null | undefined,
): string {
  return scheme === "dark" ? MAP_STYLES.dark : MAP_STYLES.light;
}
